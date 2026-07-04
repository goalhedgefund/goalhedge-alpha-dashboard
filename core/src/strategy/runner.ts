import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import type { IdFactory, InstrumentId, PositionId, SessionId } from '../domain/ids.js';
import type { OptionChainRow } from '../domain/marketdata.js';
import type { OrderIntent, StopPlan } from '../domain/orders.js';
import type { Position, Trade } from '../domain/positions.js';
import type { SessionStopKind } from '../domain/risk.js';
import { formatHHMMIst, type Clock } from '../domain/time.js';
import type { ExitEscalator } from '../oms/escalation.js';
import type { Oms } from '../oms/oms.js';
import type { RiskGate, RiskGateContext } from '../risk/risk-gate.js';
import type { SessionRiskState } from '../risk/session-risk.js';
import type { StopDecision, StopEngine } from '../stops/stop-engine.js';
import { checkGlobal, checkOption, type EligibilityConfig, type RegimeTrend } from './eligibility.js';
import type { EntryProposal, IStrategy, StrategyLifecycle, StrategyParams, StrategyView } from './types.js';

export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

/** Provides the market state the runner and gate need. Implemented over chain-state/features (or fixtures in tests). */
export interface MarketViewProvider {
  strategyView(nowMs: number): Omit<StrategyView, 'params'>;
  allowedInstruments(): ReadonlySet<InstrumentId>;
  optionRows(): ReadonlyMap<InstrumentId, OptionChainRow>;
  atmStrikePaise(): number | undefined;
  spotPaise(): number | undefined;
}

export interface RegimeProvider {
  trend(): RegimeTrend;
  highVolDay(): boolean;
}

export interface StrategyRunnerOptions {
  sessionId: SessionId;
  strategy: IStrategy;
  params: StrategyParams;
  market: MarketProfile;
  gate: RiskGate;
  oms: Oms;
  stopEngine: StopEngine;
  sessionRisk: SessionRiskState;
  ids: IdFactory;
  clock: Clock;
  view: MarketViewProvider;
  eligibility: EligibilityConfig;
  /** Trading date YYYY-MM-DD (IST) for blackout checks. */
  todayDate: string;
  regime?: RegimeProvider;
  journal?: JournalSink;
  /** Entry guard: when this returns false (broken journal) no new entry is proposed. */
  journalHealthy?: () => boolean;
  cooldownSec?: number;
  /** When present, stop exits ride the reprice→market escalation ladder. */
  escalator?: ExitEscalator;
}

/**
 * Owns one strategy's lifecycle and every hop between its decision and the
 * market: eligibility chain → strategy.decide → risk gate → OMS, plus stop
 * management for the resulting position. Strategies stay pure; the runner
 * is the only component that can turn a proposal into an order intent.
 *
 * No-trade reasons are journaled deduplicated: only when the reason CHANGES,
 * so the journal shows every state transition without per-tick spam.
 */
export class StrategyRunner {
  private lifecycle: StrategyLifecycle = 'DISARMED';
  private activeParams: StrategyParams;
  private pendingParams: StrategyParams | undefined;
  private activeStopPlan: StopPlan | undefined;
  private trackedPositionId: PositionId | undefined;
  private trackedInstrumentId: InstrumentId | undefined;
  private lastPremiumPaise: number | undefined;
  private entryInFlight = false;
  private exitInFlight = false;
  private cooldownUntilMs = 0;
  private lastNoTradeReason: string | undefined;
  private readonly cooldownMs: number;

  constructor(private readonly opts: StrategyRunnerOptions) {
    this.activeParams = { ...opts.params };
    this.cooldownMs = (opts.cooldownSec ?? 60) * 1000;
  }

  state(): StrategyLifecycle {
    return this.lifecycle;
  }

  arm(): void {
    if (this.lifecycle === 'DISARMED' || this.lifecycle === 'COOLDOWN') {
      this.lifecycle = 'ARMED';
      this.lastNoTradeReason = undefined;
      this.opts.strategy.reset();
    }
  }

  disarm(): void {
    this.lifecycle = 'DISARMED';
    this.opts.strategy.reset();
  }

  /** Queue a param change; it applies only when flat. */
  setParams(params: StrategyParams): void {
    this.pendingParams = { ...params };
    this.applyParamsIfFlat();
  }

  activeParamsSnapshot(): StrategyParams {
    return { ...this.activeParams };
  }

  /**
   * Drive the entry decision loop. Call on every underlying tick (and the
   * caller is responsible for having refreshed the view provider first).
   */
  async onUnderlyingTick(nowMs: number): Promise<void> {
    this.tickCooldown(nowMs);
    this.syncPosition(nowMs);
    if (this.lifecycle !== 'ARMED' || this.entryInFlight || this.openPosition() !== undefined) return;

    // Never open a new position while the audit trail is broken (disk-full /
    // latched journal failure). Protection for open positions (driveStops) is
    // NOT gated here — a broken journal must never strand an existing position.
    if (this.opts.journalHealthy?.() === false) {
      this.noTrade('JOURNAL_UNHEALTHY');
      return;
    }

    const global = checkGlobal(this.opts.eligibility, {
      nowHHMM: formatHHMMIst(nowMs),
      todayDate: this.opts.todayDate,
      highVolDay: this.opts.regime?.highVolDay() ?? false,
    });
    if (!global.pass) {
      this.noTrade(global.reason, global.detail);
      return;
    }

    const view: StrategyView = { ...this.opts.view.strategyView(nowMs), params: this.activeParams };
    const decision = this.opts.strategy.decide(view);
    if (decision.kind === 'NONE') {
      this.noTrade(decision.reason ?? 'NO_SIGNAL');
      return;
    }

    const proposedRow = this.opts.view.optionRows().get(decision.instrumentId);
    const atm = this.opts.view.atmStrikePaise();
    const option = checkOption(this.opts.eligibility, {
      right: decision.right,
      trend: this.opts.regime?.trend() ?? 0,
      ...(proposedRow !== undefined ? { row: proposedRow } : {}),
      ...(atm !== undefined ? { atmStrikePaise: atm } : {}),
    });
    if (!option.pass) {
      this.noTrade(option.reason, option.detail);
      return;
    }

    this.journal('strategy.signal', {
      strategyId: this.opts.strategy.id,
      instrumentId: decision.instrumentId,
      direction: decision.right === 'CE' ? 'LONG_CE' : 'LONG_PE',
      ...(decision.note !== undefined ? { note: decision.note } : {}),
    });
    this.lastNoTradeReason = undefined;

    const intent = this.buildEntryIntent(decision, nowMs);
    this.journal('intent.proposed', { intent });
    const verdict = this.opts.gate.evaluate(intent, this.gateContext(nowMs));
    this.journal('risk.verdict', { verdict });
    if (!verdict.approved) return;

    this.entryInFlight = true;
    this.activeStopPlan = decision.stopPlan;
    this.trackedInstrumentId = decision.instrumentId;
    const result = await this.opts.oms.submit(intent, verdict);
    if (!result.accepted) {
      this.entryInFlight = false;
      this.activeStopPlan = undefined;
      this.trackedInstrumentId = undefined;
      return;
    }
    this.syncPosition(nowMs);
  }

  /** Feed option premium ticks for the tracked instrument into the stop engine. */
  async onOptionTick(instrumentId: InstrumentId, ltpPaise: number, nowMs: number): Promise<void> {
    if (instrumentId === this.trackedInstrumentId) this.lastPremiumPaise = ltpPaise;
    await this.driveStops(nowMs);
  }

  /** Timer cadence: drives time stops when the market is silent, cooldown expiry, and exit escalation. */
  async onTimer(nowMs: number): Promise<void> {
    this.tickCooldown(nowMs);
    this.syncPosition(nowMs);
    await this.driveStops(nowMs);
    await this.opts.escalator?.poll(nowMs);
  }

  /** Wire trade completions here (from the OMS journal sink). */
  onTrade(trade: Trade): void {
    const before = this.opts.sessionRisk.current().latchedStop;
    const snap = this.opts.sessionRisk.recordTrade(trade.netPnlPaise);
    if (snap.latchedStop !== undefined && snap.latchedStop !== before) {
      this.journal('risk.sessionStop', { kind: snap.latchedStop });
    }
  }

  // ---------------------------------------------------------------------

  private async driveStops(nowMs: number): Promise<void> {
    // NOT gated on lifecycle: DISARM stops new entries, never stop
    // protection — an open position's stops are driven until it closes.
    if (this.exitInFlight) return;
    const pos = this.openPosition();
    if (pos === undefined || pos.instrumentId !== this.trackedInstrumentId) return;
    const premium = this.lastPremiumPaise;
    if (premium === undefined) return;

    const latched: SessionStopKind | undefined = this.opts.sessionRisk.current().latchedStop;
    const before = this.opts.stopEngine.get(pos.positionId);
    const spot = this.opts.view.spotPaise();
    const decision = this.opts.stopEngine.update(
      pos,
      { nowMs, premiumPaise: premium, ...(spot !== undefined ? { underlyingPaise: spot } : {}) },
      latched,
    );
    if (decision === undefined) return;

    if (decision.moved && before !== undefined) {
      this.journal('stop.moved', {
        positionId: pos.positionId,
        from: before,
        to: decision.state,
        trigger: decision.state.layer,
      });
    }
    if (decision.trigger !== undefined) {
      await this.handleTrigger(pos, decision, premium, nowMs);
    }
  }

  private async handleTrigger(pos: Position, decision: StopDecision, premiumPaise: number, nowMs: number): Promise<void> {
    const trigger = decision.trigger;
    if (trigger === undefined) return;
    this.exitInFlight = true;
    try {
      this.journal('stop.triggered', {
        positionId: pos.positionId,
        layer: trigger.reason,
        reason: trigger.reason,
        premiumPaise,
      });
      this.opts.stopEngine.disarm(pos.positionId);

      const intent = trigger.exitIntent;
      this.journal('intent.proposed', { intent });
      const verdict = this.opts.gate.evaluate(intent, this.gateContext(nowMs));
      this.journal('risk.verdict', { verdict });
      if (verdict.approved) {
        const result = await this.opts.oms.submit(intent, verdict);
        if (result.accepted) this.opts.escalator?.track(result.order, intent);
      }
    } finally {
      this.exitInFlight = false;
    }
    this.syncPosition(nowMs);
  }

  private syncPosition(nowMs: number): void {
    const pos = this.openPosition();

    if (pos !== undefined && this.entryInFlight) {
      this.entryInFlight = false;
      if (this.activeStopPlan !== undefined) {
        this.opts.stopEngine.arm(pos, this.activeStopPlan);
      }
      this.trackedPositionId = pos.positionId;
      this.lifecycle = 'ACTIVE';
      return;
    }

    if (pos === undefined && this.trackedPositionId !== undefined) {
      this.opts.stopEngine.disarm(this.trackedPositionId);
      this.trackedPositionId = undefined;
      this.trackedInstrumentId = undefined;
      this.activeStopPlan = undefined;
      this.lastPremiumPaise = undefined;
      if (this.lifecycle === 'ACTIVE') {
        // Normal close → cooldown. If we were DISARMED mid-position, the
        // position closed under continued stop protection; stay DISARMED.
        this.lifecycle = 'COOLDOWN';
        this.cooldownUntilMs = nowMs + this.cooldownMs;
        this.lastNoTradeReason = undefined;
        this.noTrade('COOLDOWN');
      }
      this.applyParamsIfFlat();
      this.opts.strategy.reset();
    }
  }

  private tickCooldown(nowMs: number): void {
    if (this.lifecycle === 'COOLDOWN' && nowMs >= this.cooldownUntilMs) {
      this.lifecycle = 'ARMED';
      this.lastNoTradeReason = undefined;
    }
  }

  private openPosition(): Position | undefined {
    return this.opts.oms.getPositions().find((p) => p.state !== 'CLOSED' && p.qty > 0);
  }

  private applyParamsIfFlat(): void {
    if (this.pendingParams !== undefined && this.openPosition() === undefined) {
      this.activeParams = { ...this.pendingParams };
      this.pendingParams = undefined;
      this.opts.strategy.reset();
    }
  }

  private buildEntryIntent(d: EntryProposal, nowMs: number): OrderIntent {
    return {
      intentId: this.opts.ids.intentId(),
      sessionId: this.opts.sessionId,
      strategyId: this.opts.strategy.id,
      ts: nowMs,
      side: 'BUY',
      instrumentId: d.instrumentId,
      qty: d.qtyLots * this.opts.market.contract.lotSize,
      type: 'LIMIT',
      limitPricePaise: d.limitPricePaise,
      ttlMs: d.ttlMs,
      tag: `${this.opts.strategy.id}:entry`,
      purpose: 'ENTRY',
      stopPlan: d.stopPlan,
      ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
    };
  }

  private gateContext(nowMs: number): RiskGateContext {
    const atm = this.opts.view.atmStrikePaise();
    return {
      nowMs,
      nowHHMM: formatHHMMIst(nowMs),
      allowedInstruments: this.opts.view.allowedInstruments(),
      optionRows: this.opts.view.optionRows(),
      ...(atm !== undefined ? { atmStrikePaise: atm } : {}),
      strikeBand: this.opts.eligibility.strikeBand,
      maxSpreadPct: this.opts.eligibility.maxSpreadPct,
      minOi: this.opts.eligibility.minOi,
      minVolume: this.opts.eligibility.minVolume,
      openPositions: this.opts.oms.getPositions(),
      session: this.opts.sessionRisk.current(),
      throttleAvailable: 1,
    };
  }

  private noTrade(reason: string, detail?: string): void {
    if (reason === this.lastNoTradeReason) return;
    this.lastNoTradeReason = reason;
    this.journal('strategy.noTrade', {
      strategyId: this.opts.strategy.id,
      reason,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  private journal<K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void {
    this.opts.journal?.(type, payload);
  }
}
