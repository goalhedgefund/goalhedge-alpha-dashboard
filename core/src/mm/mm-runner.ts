import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import type { IdFactory, InstrumentId, SessionId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import { isTerminalOrderState, type Order, type OrderIntent } from '../domain/orders.js';
import type { Trade } from '../domain/positions.js';
import type { SessionStopKind } from '../domain/risk.js';
import { formatHHMMIst, type Clock } from '../domain/time.js';
import type { Oms } from '../oms/oms.js';
import type { RiskGate, RiskGateContext } from '../risk/risk-gate.js';
import type { SessionRiskState } from '../risk/session-risk.js';
import type { MarketViewProvider } from '../strategy/runner.js';
import type { StrategyLifecycle, StrategyParams } from '../strategy/types.js';
import { QuotingEngine, type MmBookInput, type MmDesiredOrder } from './quoting-engine.js';

export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

/** Quote-quality gates shared with the risk gate context (host-supplied). */
export interface MmQuoteGates {
  maxSpreadPct: number;
  minOi: number;
  minVolume: number;
  strikeBand: number;
}

export interface MmRunnerOptions {
  sessionId: SessionId;
  strategyId: string;
  params: StrategyParams;
  market: MarketProfile;
  gate: RiskGate;
  oms: Oms;
  sessionRisk: SessionRiskState;
  ids: IdFactory;
  clock: Clock;
  view: MarketViewProvider;
  quoteGates: MmQuoteGates;
  journal?: JournalSink;
  /** When this returns false (broken journal) no NEW bids are placed. */
  journalHealthy?: () => boolean;
  /** Minimum ms between reconcile passes (quote churn brake). */
  evalIntervalMs?: number;
}

/**
 * ALL_OP market-making runner — the impure shell around the QuotingEngine.
 * Sits beside StrategyRunner (never through IStrategy): where the strategy
 * pipeline manages one entry proposal at a time, this reconciles a STANDING
 * working-order set on every tick/timer:
 *
 *   engine.evaluate(view) → desired set → diff vs live orders
 *     → cancel non-matching first → place missing through RiskGate → OMS
 *
 * The MM gets no private door to the broker: every order intent passes the
 * same gate.evaluate → oms.submit path as S1/S2. Cancel-before-replace is
 * structural — a replacement is only submitted on a later pass, once the
 * (instrument, side) lane has no live working order left.
 *
 * DISARM cancels every working MM order but leaves positions alone (the kill
 * switch and the session square-off own flattening).
 */
export class MmRunner {
  private lifecycle: StrategyLifecycle = 'DISARMED';
  private params: StrategyParams;
  private readonly engine: QuotingEngine;
  private readonly evalIntervalMs: number;
  private lastEvalMs = Number.NEGATIVE_INFINITY;
  private evaluating = false;
  private lastNoTradeReason: string | undefined;
  private readonly rightById = new Map<InstrumentId, OptionRight>();

  constructor(private readonly opts: MmRunnerOptions) {
    this.params = { ...opts.params };
    this.engine = new QuotingEngine(opts.market, this.params);
    this.evalIntervalMs = opts.evalIntervalMs ?? 200;
  }

  // ---------------------------------------------------- command surface (gateway)

  arm(): void {
    if (this.lifecycle === 'DISARMED') {
      this.lifecycle = 'ARMED';
      this.lastNoTradeReason = undefined;
    }
  }

  disarm(): void {
    this.lifecycle = 'DISARMED';
    void this.cancelAllWorking('disarm');
  }

  /** MM params apply immediately — there is no "flat" moment in a quoting day. */
  setParams(params: StrategyParams): void {
    this.params = { ...params };
    this.engine.setParams(this.params);
  }

  state(): StrategyLifecycle {
    return this.lifecycle;
  }

  lastNoTrade(): string | undefined {
    return this.lastNoTradeReason;
  }

  activeParamsSnapshot(): StrategyParams {
    return { ...this.params };
  }

  // ---------------------------------------------------------- host drive surface

  async onUnderlyingTick(nowMs: number): Promise<void> {
    await this.reconcile(nowMs, false);
  }

  async onOptionTick(_instrumentId: InstrumentId, _ltpPaise: number, nowMs: number): Promise<void> {
    await this.reconcile(nowMs, false);
  }

  async onTimer(nowMs: number): Promise<void> {
    await this.reconcile(nowMs, true);
  }

  /** Wire trade completions here (host journal sink), same as StrategyRunner. */
  onTrade(trade: Trade): void {
    const before = this.opts.sessionRisk.current().latchedStop;
    const snap = this.opts.sessionRisk.recordTrade(trade.netPnlPaise);
    if (snap.latchedStop !== undefined && snap.latchedStop !== before) {
      this.journal('risk.sessionStop', { kind: snap.latchedStop as SessionStopKind });
    }
  }

  // ------------------------------------------------------------------- internals

  private async reconcile(nowMs: number, force: boolean): Promise<void> {
    if (this.evaluating) return;
    if (!force && nowMs - this.lastEvalMs < this.evalIntervalMs) return;
    this.evaluating = true;
    this.lastEvalMs = nowMs;
    try {
      if (this.lifecycle !== 'ARMED') return;
      const evaluation = this.engine.evaluate(this.buildInput(nowMs));
      let desired = evaluation.desired;

      // A broken journal blocks NEW risk (bids); risk-reducing asks continue —
      // the same asymmetry StrategyRunner applies to entries vs stops.
      if (this.opts.journalHealthy?.() === false) {
        desired = desired.filter((d) => d.side === 'SELL');
        this.noTrade('JOURNAL_UNHEALTHY');
      } else if (evaluation.pauseReason !== undefined) {
        this.noTrade(evaluation.phase, evaluation.pauseReason);
      } else if (desired.some((d) => d.side === 'BUY')) {
        this.lastNoTradeReason = undefined;
      } else if (desired.length === 0) {
        this.noTrade('NO_QUOTABLE_MARKET');
      }

      const live = this.liveOrders();
      const tolerance = this.engine.activeParams().repriceTicks * this.opts.market.tickSizePaise;

      // 1) cancel every live order the desired set no longer wants
      const matchedDesired = new Set<MmDesiredOrder>();
      const cancellingLanes = new Set<string>();
      for (const order of live) {
        const match = desired.find(
          (d) =>
            !matchedDesired.has(d) &&
            d.instrumentId === order.instrumentId &&
            d.side === order.side &&
            d.qty === order.qty &&
            Math.abs((order.limitPricePaise ?? 0) - d.limitPricePaise) <= tolerance,
        );
        if (match !== undefined) {
          matchedDesired.add(match);
        } else {
          cancellingLanes.add(`${String(order.instrumentId)}:${order.side}`);
          await this.opts.oms.cancel(order.clientOrderId).catch((err: unknown) => {
            this.journal('diag.error', { where: 'mm.cancel', message: String(err) });
          });
        }
      }

      // 2) place what is missing. Cancel-before-replace is structural: a lane
      //    with a cancel in flight defers its replacement to the next pass, so
      //    the same slot is never live twice.
      for (const d of desired) {
        if (matchedDesired.has(d)) continue;
        if (cancellingLanes.has(`${String(d.instrumentId)}:${d.side}`)) continue;
        await this.place(d, nowMs);
      }
    } finally {
      this.evaluating = false;
    }
  }

  private async place(d: MmDesiredOrder, nowMs: number): Promise<void> {
    const intent: OrderIntent = {
      intentId: this.opts.ids.intentId(),
      sessionId: this.opts.sessionId,
      strategyId: this.opts.strategyId,
      ts: nowMs,
      side: d.side,
      instrumentId: d.instrumentId,
      qty: d.qty,
      type: 'LIMIT',
      limitPricePaise: d.limitPricePaise,
      ttlMs: this.engine.activeParams().quoteTtlSec * 1_000,
      tag: `${this.opts.strategyId}:${d.reason.toLowerCase()}`,
      purpose: d.purpose,
      ...(d.stopPlan !== undefined ? { stopPlan: d.stopPlan } : {}),
    };
    this.journal('intent.proposed', { intent });
    const verdict = this.opts.gate.evaluate(intent, this.gateContext(nowMs));
    this.journal('risk.verdict', { verdict });
    if (!verdict.approved) {
      if (d.side === 'BUY') this.noTrade(`GATE_${verdict.reason ?? 'REJECTED'}`);
      return;
    }
    const result = await this.opts.oms.submit(intent, verdict);
    if (!result.accepted) {
      this.journal('diag.error', {
        where: 'mm.place',
        message: `submit not accepted (${result.reason ?? 'unknown'}) for ${d.reason} ${d.side} ${String(d.instrumentId)}`,
      });
    }
  }

  private buildInput(nowMs: number) {
    const view = this.opts.view;
    const rows = view.optionRows();
    const atm = view.atmStrikePaise();
    let atmCe;
    let atmPe;
    if (atm !== undefined) {
      for (const row of rows.values()) {
        this.rightById.set(row.instrumentId, row.right);
        if (row.strikePaise !== atm) continue;
        if (row.right === 'CE') atmCe = row;
        else atmPe = row;
      }
    } else {
      for (const row of rows.values()) this.rightById.set(row.instrumentId, row.right);
    }

    const books: MmBookInput[] = [];
    for (const pos of this.opts.oms.getPositions()) {
      if (pos.state === 'CLOSED' || pos.qty <= 0) continue;
      const right = rows.get(pos.instrumentId)?.right ?? this.rightById.get(pos.instrumentId);
      if (right === undefined) continue; // never price a book we cannot classify
      const row = rows.get(pos.instrumentId);
      books.push({
        instrumentId: pos.instrumentId,
        right,
        qty: pos.qty,
        avgEntryPricePaise: pos.avgEntryPricePaise,
        openedTs: pos.openedTs,
        ...(row !== undefined ? { row } : {}),
      });
    }

    const spot = view.spotPaise();
    return {
      nowMs,
      nowHHMM: formatHHMMIst(nowMs),
      ...(spot !== undefined ? { spotPaise: spot } : {}),
      ...(atmCe !== undefined ? { atmCe } : {}),
      ...(atmPe !== undefined ? { atmPe } : {}),
      books,
      latchedStop: this.opts.sessionRisk.current().latchedStop !== undefined,
    };
  }

  private liveOrders(): Order[] {
    const prefix = `${this.opts.strategyId}:`;
    return this.opts.oms
      .getOrders()
      .filter((o) => !isTerminalOrderState(o.state) && o.tag.startsWith(prefix));
  }

  private async cancelAllWorking(why: string): Promise<void> {
    for (const order of this.liveOrders()) {
      await this.opts.oms.cancel(order.clientOrderId).catch((err: unknown) => {
        this.journal('diag.error', { where: `mm.cancelAll(${why})`, message: String(err) });
      });
    }
  }

  private gateContext(nowMs: number): RiskGateContext {
    const atm = this.opts.view.atmStrikePaise();
    const g = this.opts.quoteGates;
    return {
      nowMs,
      nowHHMM: formatHHMMIst(nowMs),
      allowedInstruments: this.opts.view.allowedInstruments(),
      optionRows: this.opts.view.optionRows(),
      ...(atm !== undefined ? { atmStrikePaise: atm } : {}),
      strikeBand: g.strikeBand,
      maxSpreadPct: g.maxSpreadPct,
      minOi: g.minOi,
      minVolume: g.minVolume,
      openPositions: this.opts.oms.getPositions(),
      session: this.opts.sessionRisk.current(),
      throttleAvailable: 1,
    };
  }

  private noTrade(reason: string, detail?: string): void {
    if (reason === this.lastNoTradeReason) return;
    this.lastNoTradeReason = reason;
    this.journal('strategy.noTrade', {
      strategyId: this.opts.strategyId,
      reason,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  private journal<K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void {
    this.opts.journal?.(type, payload);
  }
}
