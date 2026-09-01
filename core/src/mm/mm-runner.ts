import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import type { ClientOrderId, IdFactory, InstrumentId, SessionId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { OptionChainRow } from '../domain/marketdata.js';
import { isTerminalOrderState, type Order, type OrderIntent } from '../domain/orders.js';
import type { Trade } from '../domain/positions.js';
import type { SessionStopKind } from '../domain/risk.js';
import { formatHHMMIst, type Clock } from '../domain/time.js';
import type { GatewayMmState } from '../gateway/protocol.js';
import type { Oms } from '../oms/oms.js';
import type { ExitEscalator } from '../oms/escalation.js';
import type { RiskGate, RiskGateContext } from '../risk/risk-gate.js';
import type { SessionRiskState } from '../risk/session-risk.js';
import type { MarketViewProvider } from '../strategy/runner.js';
import type { StrategyLifecycle, StrategyParams } from '../strategy/types.js';
import {
  QuotingEngine,
  type MmActiveRunnerInput,
  type MmBookInput,
  type MmDefenceState,
  type MmDesiredOrder,
  type MmEntryFeatures,
  type MmEvaluation,
  type MmQuoteInput,
  type MmQuotePhase,
} from './quoting-engine.js';

export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

export interface MmQuoteGates {
  maxSpreadPct: number;
  minOi: number;
  minVolume: number;
  strikeBand: number;
}

export interface MmEntryDecision {
  clientOrderId: ClientOrderId;
  ts: number;
  instrumentId: InstrumentId;
  right: OptionRight;
  limitPricePaise?: number;
  features: MmEntryFeatures;
}

export interface MmRunnerOptions {
  sessionId: SessionId;
  strategyId: string;
  params: StrategyParams;
  market: MarketProfile;
  gate: RiskGate;
  oms: Oms;
  escalator?: ExitEscalator;
  sessionRisk: SessionRiskState;
  ids: IdFactory;
  clock: Clock;
  view: MarketViewProvider;
  quoteGates: MmQuoteGates;
  journal?: JournalSink;
  journalHealthy?: () => boolean;
  evalIntervalMs?: number;
  /** Optional replay/telemetry hooks; neither participates in order decisions. */
  entryDecisionSink?: (decision: MmEntryDecision) => void;
  tradeSink?: (trade: Trade) => void;
}

type ShadowEntryPhase = 'WATCHING' | 'CONFIRMING' | 'LIVE' | 'COOLDOWN' | 'CAP_REACHED';

interface ShadowEntryState {
  phase: ShadowEntryPhase;
  instrumentId?: InstrumentId;
  order?: MmDesiredOrder;
  shadowStartedTs?: number;
  clientOrderId?: ClientOrderId;
  liveUntilTs?: number;
  cooldownUntilTs?: number;
  distanceTicks?: number;
  triggerTs?: number;
  triggerLowAskPaise?: number;
  lastObservedVolume?: number;
  queueAheadQty?: number;
}

interface ShadowPolicyResult {
  desired: MmDesiredOrder[];
  waitReason?: string;
  waitDetail?: string;
}

/**
 * Impure shell around QuotingEngine. It owns runner assignment and reconciles
 * one desired order set through RiskGate -> OMS on each tick/timer pass.
 */
export class MmRunner {
  private lifecycle: StrategyLifecycle = 'DISARMED';
  private params: StrategyParams;
  private readonly engine: QuotingEngine;
  private readonly evalIntervalMs: number;
  private lastEvalMs = Number.NEGATIVE_INFINITY;
  private evaluating = false;
  private forceReconcileRequested = false;
  private lastNoTradeReason: string | undefined;
  private readonly rightById = new Map<InstrumentId, OptionRight>();
  private activeRunner: MmActiveRunnerInput | undefined;
  private pendingRunnerLotId: string | undefined;
  private quotePhase: MmQuotePhase | 'IDLE' = 'IDLE';
  private defences: MmDefenceState[] = [];
  // Lot IDs reserved by a live or recently-placed exit order. Prevents a second
  // exit being emitted for the same lot before the first fill is processed by
  // the position-keeper (async fill-processing race).
  private readonly reservedLotIds = new Set<string>();
  // Gate rejections are deterministic until price or risk state changes. Keep
  // them off the desired set briefly instead of submitting on every tick.
  private readonly entryBlockedUntil = new Map<InstrumentId, number>();
  private entryReplacementTs: number[] = [];
  private shadowEntry: ShadowEntryState | undefined;
  private entrySubmissionsToday = 0;

  constructor(private readonly opts: MmRunnerOptions) {
    this.params = { ...opts.params };
    this.engine = new QuotingEngine(opts.market, this.params);
    this.evalIntervalMs = opts.evalIntervalMs ?? 200;
  }

  arm(): void {
    if (this.lifecycle === 'DISARMED') {
      this.lifecycle = 'ARMED';
      this.lastNoTradeReason = undefined;
    }
  }

  disarm(): void {
    this.lifecycle = 'DISARMED';
    this.shadowEntry = undefined;
    void this.cancelAllWorking('disarm');
  }

  setParams(params: StrategyParams): void {
    this.params = { ...params };
    this.engine.setParams(this.params);
    this.shadowEntry = undefined;
    this.refreshRunner(this.opts.clock.now());
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

  mmState(): GatewayMmState {
    const params = this.engine.activeParams();
    const lots = this.opts.oms.getOpenLots();
    const runnerLot = this.activeRunner === undefined
      ? undefined
      : lots.find((lot) => lot.lotId === this.activeRunner?.lotId);
    const runnerUnits = runnerLot?.qty ?? 0;
    const scalpHeldUnits = Math.max(0, lots.reduce((sum, lot) => sum + lot.qty, 0) - runnerUnits);
    const workingBidUnits = this.liveOrders()
      .filter((order) => order.side === 'BUY')
      .reduce((sum, order) => sum + Math.max(0, order.qty - order.filledQty), 0);
    const lotSize = this.opts.market.contract.lotSize;
    const pendingLot = this.pendingRunnerLotId === undefined
      ? undefined
      : lots.find((lot) => lot.lotId === this.pendingRunnerLotId);
    const runner = this.activeRunner;
    const trend = this.engine.trendState();
    const selectedEntryRight = this.engine.entrySelection();
    const nowMs = this.opts.clock.now();
    this.pruneEntryReplacements(nowMs);
    const expiryInfo = this.expirySnapshot();
    return {
      quotePhase: this.quotePhase,
      scalpSlotsUsed: (scalpHeldUnits + workingBidUnits) / lotSize,
      scalpSlotsMax: params.maxScalpLots,
      trendRegime: trend.regime,
      trendDriftPct: trend.driftPct,
      ...(selectedEntryRight !== undefined ? { selectedEntryRight } : {}),
      entryReplacementsLastMin: this.entryReplacementTs.length,
      entryReplacementLimit: params.maxEntryReplacementsPerMin,
      shadowEntryEnabled: params.shadowEntryEnabled,
      shadowEntryPhase: params.shadowEntryEnabled ? this.shadowEntry?.phase ?? 'WATCHING' : 'DISABLED',
      entrySubmissionsToday: this.entrySubmissionsToday,
      entrySubmissionLimit: params.maxEntrySubmissionsPerDay,
      ...(this.shadowEntry?.instrumentId !== undefined
        ? { shadowEntryInstrumentId: String(this.shadowEntry.instrumentId) }
        : {}),
      ...(this.shadowEntry?.order?.limitPricePaise !== undefined
        ? { shadowEntryLimitPaise: this.shadowEntry.order.limitPricePaise }
        : {}),
      ...(this.shadowEntry?.distanceTicks !== undefined
        ? { shadowEntryDistanceTicks: this.shadowEntry.distanceTicks }
        : {}),
      ...(this.shadowEntry?.cooldownUntilTs !== undefined
        ? { shadowEntryCooldownUntilTs: this.shadowEntry.cooldownUntilTs }
        : {}),
      lossStreaks: { CE: this.engine.lossStreakCount('CE'), PE: this.engine.lossStreakCount('PE') },
      ...(expiryInfo !== undefined ? expiryInfo : {}),
      runnerStatus: runner !== undefined ? 'ACTIVE' : pendingLot !== undefined ? 'PENDING' : 'AVAILABLE',
      ...(pendingLot !== undefined ? { pendingRunnerInstrumentId: String(pendingLot.instrumentId) } : {}),
      ...(runner !== undefined
        ? {
            runner: {
              instrumentId: String(runner.instrumentId),
              entryPricePaise: runner.entryPricePaise,
              highWaterBidPaise: runner.highWaterBidPaise,
              stopPaise: runner.stopPaise,
              openedTs: runner.openedTs,
              activatedTs: runner.activatedTs,
            },
          }
        : {}),
      defences: this.engine.defenceSnapshot(this.opts.clock.now()).map((defence) => ({
        right: defence.right,
        reason: defence.reason,
        ...(defence.instrumentId !== undefined ? { instrumentId: String(defence.instrumentId) } : {}),
        ...(defence.drawdownPct !== undefined ? { drawdownPct: defence.drawdownPct } : {}),
        ...(defence.untilTs !== undefined ? { untilTs: defence.untilTs } : {}),
      })),
    };
  }

  /** Quoted expiry date + calendar days to expiry, from any subscribed chain row. */
  private expirySnapshot(): { expiryDate: string; daysToExpiry: number } | undefined {
    const row = this.opts.view.optionRows().values().next().value;
    const expiryDate = row?.expiry;
    if (expiryDate === undefined || expiryDate === '') return undefined;
    const IST_OFFSET_MS = 5.5 * 3_600_000;
    const todayIst = new Date(this.opts.clock.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
    const daysToExpiry = Math.round(
      (Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${todayIst}T00:00:00Z`)) / 86_400_000,
    );
    return { expiryDate, daysToExpiry };
  }

  async onUnderlyingTick(nowMs: number): Promise<void> {
    await this.reconcile(nowMs, false);
  }

  async onOptionTick(_instrumentId: InstrumentId, _ltpPaise: number, nowMs: number): Promise<void> {
    await this.reconcile(nowMs, false);
  }

  async onTimer(nowMs: number): Promise<void> {
    await this.opts.escalator?.poll(nowMs);
    await this.reconcile(nowMs, true);
  }

  onTrade(trade: Trade): void {
    this.opts.tradeSink?.(trade);
    const exitOrder = this.opts.oms.getOrder(trade.exit.clientOrderId);
    const exitTag = exitOrder?.tag.split(':')[1];
    // Release reservations for the lots closed by this trade.
    for (const lotId of exitOrder?.closeLotIds ?? []) this.reservedLotIds.delete(lotId);
    const right = this.opts.view.optionRows().get(trade.instrumentId)?.right ?? this.rightById.get(trade.instrumentId);

    if (
      trade.netPnlPaise < 0 &&
      right !== undefined &&
      (exitTag === 'hard_stop' || exitTag === 'scalp_timeout')
    ) {
      this.engine.noteDefensiveExit(right, trade.exit.ts);
      this.journal('mm.state', {
        event: 'DEFENSIVE_EXIT',
        instrumentId: String(trade.instrumentId),
        right,
        detail: `${exitTag}; netPaise=${trade.netPnlPaise}; lossStreak=${this.engine.lossStreakCount(right)}`,
      });
    } else if (trade.netPnlPaise > 0 && right !== undefined) {
      // Any positive-net exit on a right breaks its consecutive-loss streak.
      this.engine.notePositiveExit(right);
    }

    if (exitTag === 'scalp_exit' && this.pendingRunnerLotId !== undefined) {
      const pending = this.opts.oms.getOpenLots().find((lot) => lot.lotId === this.pendingRunnerLotId);
      if (pending?.instrumentId === trade.instrumentId) {
        if (trade.netPnlPaise > 0) this.activatePendingRunner(trade.exit.ts);
        else this.pendingRunnerLotId = undefined;
      }
    }
    this.syncInventoryState(`exit ${exitTag ?? trade.exitReason}`);

    const before = this.opts.sessionRisk.current().latchedStop;
    const snap = this.opts.sessionRisk.recordTrade(trade.netPnlPaise);
    if (snap.latchedStop !== undefined && snap.latchedStop !== before) {
      this.journal('risk.sessionStop', { kind: snap.latchedStop as SessionStopKind });
      this.forceReconcileRequested = true;
      void this.cancelAllWorking('session risk latch', true).finally(() => {
        void this.reconcile(this.opts.clock.now(), true);
      });
    }
  }

  private async reconcile(nowMs: number, force: boolean): Promise<void> {
    if (this.evaluating) {
      if (force) this.forceReconcileRequested = true;
      return;
    }
    if (!force && nowMs - this.lastEvalMs < this.evalIntervalMs) return;
    this.evaluating = true;
    this.lastEvalMs = nowMs;
    try {
      if (this.lifecycle !== 'ARMED') return;
      this.syncInventoryState('reconcile');
      this.refreshRunner(nowMs);
      const evaluation = this.engine.evaluate(this.buildInput(nowMs));
      this.quotePhase = evaluation.phase;
      this.defences = evaluation.defences;
      this.captureRunnerCandidate(evaluation);
      let desired = evaluation.desired;
      let shadowPolicy: ShadowPolicyResult | undefined;

      if (this.opts.journalHealthy?.() === false) {
        desired = desired.filter((order) => order.side === 'SELL');
        if (this.shadowEntry?.phase !== 'LIVE') this.shadowEntry = undefined;
        this.noTrade('JOURNAL_UNHEALTHY');
      } else if (evaluation.pauseReason !== undefined) {
        // A pause suppresses release but does not create broker traffic. Keep
        // a watching shadow anchored across brief asynchronous defence
        // flicker; its own TTL refreshes it when quoting safely resumes.
        this.noTrade(evaluation.phase, evaluation.pauseReason);
      } else {
        shadowPolicy = this.applyShadowEntryPolicy(desired, evaluation, nowMs);
        desired = shadowPolicy.desired;
        if (desired.some((order) => order.side === 'BUY')) {
          this.lastNoTradeReason = undefined;
        } else if (shadowPolicy.waitReason !== undefined) {
          this.noTrade(shadowPolicy.waitReason, shadowPolicy.waitDetail);
        } else if (desired.length === 0) {
          this.noTrade('NO_QUOTABLE_MARKET');
        }
      }

      const live = this.liveOrders();
      const tolerance = this.engine.activeParams().repriceTicks * this.opts.market.tickSizePaise;
      const matchedDesired = new Set<MmDesiredOrder>();
      const eligibleEntryInstruments = new Set(evaluation.eligibleEntryInstruments);
      let retainedUnmatchedEntryUnits = 0;
      const blockedBroadLanes = new Set<string>();
      const blockedLotLanes = new Set<string>();
      const blockedAllocatedSellInstruments = new Set<string>();
      for (const order of live) {
        const remainingQty = Math.max(0, order.qty - order.filledQty);
        if (this.opts.escalator?.isTracked(order.clientOrderId)) {
          const allocationMatch = desired.find(
            (candidate) =>
              !matchedDesired.has(candidate) &&
              candidate.instrumentId === order.instrumentId &&
              candidate.side === order.side &&
              candidate.qty === remainingQty &&
              sameAllocation(candidate.closeLotIds, order.closeLotIds),
          );
          if (allocationMatch !== undefined) matchedDesired.add(allocationMatch);
          blockOrderAllocation(
            order,
            blockedBroadLanes,
            blockedLotLanes,
            blockedAllocatedSellInstruments,
          );
          continue;
        }
        const match = desired.find(
          (candidate) =>
            !matchedDesired.has(candidate) &&
            candidate.instrumentId === order.instrumentId &&
            candidate.side === order.side &&
            candidate.qty === remainingQty &&
            intentTypeMatchesOrder(candidate.type, order.type) &&
            reasonMatches(order, candidate) &&
            sameAllocation(candidate.closeLotIds, order.closeLotIds) &&
            priceMatches(order.limitPricePaise, candidate.limitPricePaise, tolerance),
        );
        if (match !== undefined) {
          matchedDesired.add(match);
        } else {
          const safeToRest = eligibleEntryInstruments.has(order.instrumentId);
          // Ranking is intentionally not part of this decision. A safe quote
          // keeps its queue position for the full residence window even when
          // the other right temporarily wins the asynchronous L1 comparison.
          if (
            order.purpose === 'ENTRY' &&
            safeToRest &&
            nowMs - entryResidenceStart(order) < this.engine.activeParams().minRequoteMs
          ) {
            const laneCandidate = desired.find(
              (candidate) =>
                !matchedDesired.has(candidate) &&
                candidate.purpose === 'ENTRY' &&
                candidate.instrumentId === order.instrumentId &&
                candidate.side === order.side,
            );
            if (laneCandidate !== undefined) matchedDesired.add(laneCandidate);
            else retainedUnmatchedEntryUnits += remainingQty;
            blockOrderAllocation(
              order,
              blockedBroadLanes,
              blockedLotLanes,
              blockedAllocatedSellInstruments,
            );
            continue;
          }
          blockOrderAllocation(
            order,
            blockedBroadLanes,
            blockedLotLanes,
            blockedAllocatedSellInstruments,
          );
          await this.opts.oms.cancel(order.clientOrderId).then(() => {
            if (order.purpose === 'ENTRY') {
              this.noteEntryReplacement(nowMs);
              if (this.shadowEntry?.clientOrderId === order.clientOrderId) {
                this.beginShadowCooldown(order.instrumentId, nowMs);
              }
            }
          }).catch((err: unknown) => {
            this.journal('diag.error', { where: 'mm.cancel', message: String(err) });
          });
        }
      }

      for (const order of desired) {
        if (matchedDesired.has(order)) continue;
        if (order.purpose === 'ENTRY' && retainedUnmatchedEntryUnits > 0) {
          retainedUnmatchedEntryUnits = Math.max(0, retainedUnmatchedEntryUnits - order.qty);
          continue;
        }
        if (allocationBlocked(
          order,
          blockedBroadLanes,
          blockedLotLanes,
          blockedAllocatedSellInstruments,
        )) continue;
        if (this.opts.sessionRisk.current().latchedStop !== undefined && order.reason !== 'RISK_EXIT') {
          this.forceReconcileRequested = true;
          continue;
        }
        if (order.purpose === 'ENTRY' && this.entryChurnGuardActive(nowMs)) {
          const limit = this.engine.activeParams().maxEntryReplacementsPerMin;
          this.noTrade(
            'ENTRY_CHURN_GUARD',
            `${this.entryReplacementTs.length}/${limit} entry replacements in 60s`,
          );
          continue;
        }
        const clientOrderId = await this.place(order, nowMs);
        if (order.purpose === 'ENTRY' && this.engine.activeParams().shadowEntryEnabled) {
          if (clientOrderId !== undefined) this.noteShadowSubmission(order, clientOrderId, nowMs);
          else this.beginShadowCooldown(order.instrumentId, nowMs);
        }
      }
    } finally {
      this.evaluating = false;
      if (this.forceReconcileRequested) {
        this.forceReconcileRequested = false;
        await this.reconcile(this.opts.clock.now(), true);
      }
    }
  }

  private async place(order: MmDesiredOrder, nowMs: number): Promise<ClientOrderId | undefined> {
    const activeParams = this.engine.activeParams();
    const intent: OrderIntent = {
      intentId: this.opts.ids.intentId(),
      sessionId: this.opts.sessionId,
      strategyId: this.opts.strategyId,
      ts: nowMs,
      side: order.side,
      instrumentId: order.instrumentId,
      qty: order.qty,
      type: order.type,
      ...(order.limitPricePaise !== undefined ? { limitPricePaise: order.limitPricePaise } : {}),
      ...(order.protectTicks !== undefined ? { protectTicks: order.protectTicks } : {}),
      ttlMs: isUrgentExit(order.reason)
        ? 2_000
        : order.purpose === 'ENTRY' && activeParams.shadowEntryEnabled
          ? activeParams.shadowLiveOrderTtlMs
          : activeParams.quoteTtlSec * 1_000,
      tag: `${this.opts.strategyId}:${order.reason.toLowerCase()}`,
      purpose: order.purpose,
      ...(order.stopPlan !== undefined ? { stopPlan: order.stopPlan } : {}),
      ...(order.closeLotIds !== undefined ? { closeLotIds: [...order.closeLotIds] } : {}),
    };
    this.journal('intent.proposed', { intent });
    const verdict = this.opts.gate.evaluate(intent, this.gateContext(nowMs));
    this.journal('risk.verdict', { verdict });
    if (!verdict.approved) {
      if (order.side === 'BUY') {
        const cooldownMs = this.engine.activeParams().entryRejectCooldownSec * 1_000;
        this.entryBlockedUntil.set(order.instrumentId, nowMs + cooldownMs);
        this.noTrade(`GATE_${verdict.reason ?? 'REJECTED'}`);
      }
      return undefined;
    }
    const result = await this.opts.oms.submit(intent, verdict);
    if (!result.accepted) {
      this.journal('diag.error', {
        where: 'mm.place',
        message: `submit not accepted (${result.reason ?? 'unknown'}) for ${order.reason} ${order.side} ${String(order.instrumentId)}`,
      });
      return undefined;
    } else {
      const right = this.rightById.get(order.instrumentId);
      if (order.entryFeatures !== undefined && right !== undefined) {
        this.opts.entryDecisionSink?.({
          clientOrderId: result.order.clientOrderId,
          ts: nowMs,
          instrumentId: order.instrumentId,
          right,
          ...(order.limitPricePaise !== undefined ? { limitPricePaise: order.limitPricePaise } : {}),
          features: { ...order.entryFeatures },
        });
      }
      if (isUrgentExit(order.reason)) this.opts.escalator?.track(result.order, intent);
      // Reserve named lots so the next reconcile cycle cannot emit a second
      // exit for the same lot while the fill is in flight.
      for (const lotId of order.closeLotIds ?? []) this.reservedLotIds.add(lotId);
      return result.order.clientOrderId;
    }
  }

  /**
   * Convert continuously-recomputed entry wishes into one sticky internal
   * shadow. Only a near-touch shadow is released to the OMS; exits never pass
   * through this policy.
   */
  private applyShadowEntryPolicy(
    desired: readonly MmDesiredOrder[],
    evaluation: MmEvaluation,
    nowMs: number,
  ): ShadowPolicyResult {
    const params = this.engine.activeParams();
    if (!params.shadowEntryEnabled) return { desired: [...desired] };

    this.syncShadowEntryState(nowMs);
    const exits = desired.filter((order) => order.purpose !== 'ENTRY');
    const entries = desired.filter((order) => order.purpose === 'ENTRY');
    const eligible = new Set(evaluation.eligibleEntryInstruments);

    if (this.shadowEntry?.phase === 'CAP_REACHED') {
      return {
        desired: exits,
        waitReason: 'ENTRY_DAILY_CAP',
        waitDetail: `${this.entrySubmissionsToday}/${params.maxEntrySubmissionsPerDay} broker entry submissions`,
      };
    }

    if (this.shadowEntry?.phase === 'COOLDOWN') {
      return {
        desired: exits,
        waitReason: 'SHADOW_ENTRY_COOLDOWN',
        waitDetail: `retry after ${this.shadowEntry.cooldownUntilTs ?? nowMs}`,
      };
    }

    if (this.shadowEntry?.phase === 'LIVE') {
      const liveOrder = this.shadowEntry.clientOrderId === undefined
        ? undefined
        : this.opts.oms.getOrder(this.shadowEntry.clientOrderId);
      const safe = this.shadowEntry.instrumentId !== undefined && eligible.has(this.shadowEntry.instrumentId);
      if (
        safe &&
        liveOrder !== undefined &&
        !isTerminalOrderState(liveOrder.state) &&
        nowMs < (this.shadowEntry.liveUntilTs ?? 0) &&
        this.shadowEntry.order !== undefined
      ) {
        const remainingQty = Math.max(0, liveOrder.qty - liveOrder.filledQty);
        return remainingQty > 0
          ? { desired: [...exits, { ...this.shadowEntry.order, qty: remainingQty }] }
          : { desired: exits };
      }
      return {
        desired: exits,
        waitReason: safe ? 'SHADOW_ORDER_EXPIRED' : 'SHADOW_ENTRY_UNSAFE',
      };
    }

    const tick = this.opts.market.tickSizePaise;
    const freshCandidate = entries[0];
    let releaseCandidate: MmDesiredOrder | undefined;
    let releaseState: ShadowEntryState | undefined;

    if (this.shadowEntry?.phase === 'CONFIRMING') {
      const confirming = this.shadowEntry;
      const shadow = confirming.order;
      const row = confirming.instrumentId === undefined
        ? undefined
        : this.opts.view.optionRows().get(confirming.instrumentId);
      const candidateChanged = freshCandidate !== undefined && freshCandidate.instrumentId !== confirming.instrumentId;
      if (candidateChanged) {
        this.shadowEntry = this.newWatchingShadow(freshCandidate, nowMs);
      } else if (shadow?.limitPricePaise !== undefined && row !== undefined && row.askPaise > 0) {
        confirming.triggerLowAskPaise = Math.min(confirming.triggerLowAskPaise ?? row.askPaise, row.askPaise);
        confirming.distanceTicks = Math.ceil((row.askPaise - shadow.limitPricePaise) / tick);
        const elapsed = nowMs - (confirming.triggerTs ?? nowMs);
        if (elapsed >= params.shadowConfirmTimeoutMs) {
          this.shadowEntry = freshCandidate === undefined
            ? undefined
            : this.newWatchingShadow(freshCandidate, nowMs);
          return { desired: exits, waitReason: 'SHADOW_ENTRY_WAIT', waitDetail: 'confirmation timed out' };
        }
        const protectedLimit = shadow.limitPricePaise + params.shadowProtectionTicks * tick;
        const recovered =
          row.bidPaise >= (confirming.triggerLowAskPaise ?? row.askPaise) + params.shadowConfirmBounceTicks * tick &&
          row.askPaise <= protectedLimit;
        if (freshCandidate !== undefined && elapsed >= params.shadowConfirmMs && recovered) {
          releaseCandidate = freshCandidate;
          releaseState = confirming;
        } else {
          return {
            desired: exits,
            waitReason: 'SHADOW_ENTRY_CONFIRM',
            waitDetail: freshCandidate === undefined ? 'awaiting entry gate recovery' : 'awaiting premium rebound',
          };
        }
      } else {
        return { desired: exits, waitReason: 'SHADOW_ENTRY_CONFIRM', waitDetail: 'awaiting valid touch' };
      }
    }

    if (releaseCandidate === undefined) {
      if (freshCandidate === undefined) {
        const watching = this.shadowEntry?.phase === 'WATCHING' ? this.shadowEntry : undefined;
        const shadow = watching?.order;
        const row = watching?.instrumentId === undefined
          ? undefined
          : this.opts.view.optionRows().get(watching.instrumentId);
        if (watching === undefined || shadow?.limitPricePaise === undefined || row === undefined || row.askPaise <= 0) {
          this.shadowEntry = undefined;
          return { desired: exits };
        }
        const distanceTicks = Math.ceil((row.askPaise - shadow.limitPricePaise) / tick);
        watching.distanceTicks = distanceTicks;
        if (this.shadowWouldFill(watching, row)) {
          this.shadowEntry = {
            ...watching,
            phase: 'CONFIRMING',
            triggerTs: nowMs,
            triggerLowAskPaise: row.askPaise,
          };
          return { desired: exits, waitReason: 'SHADOW_ENTRY_CONFIRM', waitDetail: 'shadow fill observed; awaiting gate recovery' };
        }
        return {
          desired: exits,
          waitReason: 'SHADOW_ENTRY_WAIT',
          waitDetail: distanceTicks <= params.shadowTriggerTicks
            ? 'near shadow; awaiting executable fill'
            : 'awaiting entry gate recovery',
        };
      }

      const candidateChanged =
        this.shadowEntry?.phase !== 'WATCHING' ||
        this.shadowEntry.instrumentId !== freshCandidate.instrumentId ||
        this.shadowEntry.order?.reason !== freshCandidate.reason;
      const shadowExpired =
        this.shadowEntry?.shadowStartedTs === undefined ||
        nowMs - this.shadowEntry.shadowStartedTs >= params.shadowQuoteTtlMs;
      if (candidateChanged || shadowExpired) {
        this.shadowEntry = this.newWatchingShadow(freshCandidate, nowMs);
      }

      const watching = this.shadowEntry;
      const shadow = watching?.order;
      const row = this.opts.view.optionRows().get(freshCandidate.instrumentId);
      if (watching === undefined || shadow?.limitPricePaise === undefined || row === undefined || row.askPaise <= 0) {
        return { desired: exits, waitReason: 'SHADOW_ENTRY_WAIT', waitDetail: 'awaiting valid touch' };
      }
      const distanceTicks = Math.ceil((row.askPaise - shadow.limitPricePaise) / tick);
      watching.distanceTicks = distanceTicks;
      if (!this.shadowWouldFill(watching, row)) {
        return {
          desired: exits,
          waitReason: 'SHADOW_ENTRY_WAIT',
          waitDetail: distanceTicks <= params.shadowTriggerTicks
            ? 'near shadow; awaiting executable fill'
            : `${distanceTicks} ticks from ${String(freshCandidate.instrumentId)} shadow`,
        };
      }
      this.shadowEntry = {
        ...watching,
        phase: 'CONFIRMING',
        triggerTs: nowMs,
        triggerLowAskPaise: row.askPaise,
      };
      return { desired: exits, waitReason: 'SHADOW_ENTRY_CONFIRM', waitDetail: 'shadow fill observed; awaiting premium rebound' };
    }

    const candidate = releaseCandidate;
    const watchingState = releaseState;
    if (watchingState === undefined) return { desired: exits };
    const shadow = watchingState.order;
    if (shadow?.limitPricePaise === undefined) return { desired: exits };

    if (
      params.maxEntrySubmissionsPerDay > 0 &&
      this.entrySubmissionsToday >= params.maxEntrySubmissionsPerDay
    ) {
      this.shadowEntry = { phase: 'CAP_REACHED', instrumentId: candidate.instrumentId };
      return {
        desired: exits,
        waitReason: 'ENTRY_DAILY_CAP',
        waitDetail: `${this.entrySubmissionsToday}/${params.maxEntrySubmissionsPerDay} broker entry submissions`,
      };
    }

    const protectedLimit = shadow.limitPricePaise + params.shadowProtectionTicks * tick;
    const hardStop = Math.min(
      protectedLimit - tick,
      floorToTick(protectedLimit * (1 - params.hardStopPct / 100), tick),
    );
    const released: MmDesiredOrder = {
      ...cloneDesiredOrder(shadow),
      limitPricePaise: protectedLimit,
      ...(candidate.entryFeatures !== undefined
        ? { entryFeatures: { ...candidate.entryFeatures } }
        : {}),
      ...(shadow.stopPlan !== undefined
        ? { stopPlan: { ...shadow.stopPlan, hardStopPremiumPaise: hardStop } }
        : {}),
    };
    watchingState.order = released;
    return { desired: [...exits, released] };
  }

  private newWatchingShadow(order: MmDesiredOrder, nowMs: number): ShadowEntryState {
    const row = this.opts.view.optionRows().get(order.instrumentId);
    const limit = order.limitPricePaise;
    const displayedQty = row !== undefined && limit !== undefined && row.bidPaise === limit ? row.bidQty : 0;
    const rawQueueLots = Number(this.params.paperQueueAheadLots ?? 2);
    const queueLots = Number.isFinite(rawQueueLots) ? Math.max(0, rawQueueLots) : 2;
    return {
      phase: 'WATCHING',
      instrumentId: order.instrumentId,
      order: cloneDesiredOrder(order),
      shadowStartedTs: nowMs,
      ...(row !== undefined ? { lastObservedVolume: row.volume } : {}),
      queueAheadQty: Math.max(displayedQty, Math.ceil(order.qty * queueLots)),
    };
  }

  /** Mirrors the ALL_OP paper broker's conservative passive-fill semantics. */
  private shadowWouldFill(state: ShadowEntryState, row: OptionChainRow): boolean {
    const limit = state.order?.limitPricePaise;
    if (limit === undefined) return false;
    if (row.askPaise > 0 && row.askPaise <= limit) return true;

    const previousVolume = state.lastObservedVolume;
    state.lastObservedVolume = Math.max(previousVolume ?? row.volume, row.volume);
    if (previousVolume === undefined) return false;
    const tradedQty = Math.max(0, row.volume - previousVolume);
    if (tradedQty <= 0 || row.ltpPaise > limit) return false;
    if (row.ltpPaise < limit) return true;

    const quantityAfterQueue = tradedQty - (state.queueAheadQty ?? 0);
    state.queueAheadQty = Math.max(0, (state.queueAheadQty ?? 0) - tradedQty);
    return quantityAfterQueue > 0;
  }

  private syncShadowEntryState(nowMs: number): void {
    const state = this.shadowEntry;
    if (state?.phase === 'COOLDOWN' && nowMs >= (state.cooldownUntilTs ?? 0)) {
      this.shadowEntry = undefined;
      return;
    }
    if (state?.phase !== 'LIVE' || state.clientOrderId === undefined) return;
    const order = this.opts.oms.getOrder(state.clientOrderId);
    if (order === undefined || !isTerminalOrderState(order.state)) return;
    if (order.state === 'FILLED') this.shadowEntry = undefined;
    else this.beginShadowCooldown(order.instrumentId, nowMs);
  }

  private noteShadowSubmission(order: MmDesiredOrder, clientOrderId: ClientOrderId, nowMs: number): void {
    const params = this.engine.activeParams();
    this.entrySubmissionsToday += 1;
    this.shadowEntry = {
      phase: 'LIVE',
      instrumentId: order.instrumentId,
      order: cloneDesiredOrder(order),
      clientOrderId,
      liveUntilTs: nowMs + params.shadowLiveOrderTtlMs,
      ...(this.shadowEntry?.distanceTicks !== undefined
        ? { distanceTicks: this.shadowEntry.distanceTicks }
        : {}),
    };
  }

  private beginShadowCooldown(instrumentId: InstrumentId, nowMs: number): void {
    if (!this.engine.activeParams().shadowEntryEnabled) return;
    this.shadowEntry = {
      phase: 'COOLDOWN',
      instrumentId,
      cooldownUntilTs: nowMs + this.engine.activeParams().shadowRetryCooldownMs,
    };
  }

  private buildInput(nowMs: number): MmQuoteInput {
    const view = this.opts.view;
    const rows = view.optionRows();
    const atm = view.atmStrikePaise();
    let atmCe: OptionChainRow | undefined;
    let atmPe: OptionChainRow | undefined;
    for (const row of rows.values()) {
      this.rightById.set(row.instrumentId, row.right);
      if (atm === undefined || row.strikePaise !== atm) continue;
      if (row.right === 'CE') atmCe = row;
      else atmPe = row;
    }

    const books: MmBookInput[] = [];
    for (const position of this.opts.oms.getPositions()) {
      if (position.state === 'CLOSED' || position.qty <= 0) continue;
      const right = rows.get(position.instrumentId)?.right ?? this.rightById.get(position.instrumentId);
      if (right === undefined) continue;
      const row = rows.get(position.instrumentId);
      const lots = this.opts.oms.getOpenLots(position.instrumentId)
        .filter((lot) => !this.reservedLotIds.has(lot.lotId))
        .map((lot) => ({
          lotId: lot.lotId,
          qty: lot.qty,
          entryPricePaise: lot.pricePaise,
          openedTs: lot.ts,
        }));
      books.push({
        instrumentId: position.instrumentId,
        right,
        qty: position.qty,
        avgEntryPricePaise: position.avgEntryPricePaise,
        openedTs: position.openedTs,
        lots,
        ...(row !== undefined ? { row } : {}),
      });
    }

    const spot = view.spotPaise();
    const latchedStop = this.opts.sessionRisk.current().latchedStop !== undefined;
    const entryBlockedInstruments = new Set<InstrumentId>();
    for (const [instrumentId, untilMs] of this.entryBlockedUntil) {
      if (untilMs > nowMs) entryBlockedInstruments.add(instrumentId);
      else this.entryBlockedUntil.delete(instrumentId);
    }
    return {
      nowMs,
      nowHHMM: formatHHMMIst(nowMs),
      ...(spot !== undefined ? { spotPaise: spot } : {}),
      ...(atmCe !== undefined ? { atmCe } : {}),
      ...(atmPe !== undefined ? { atmPe } : {}),
      books,
      latchedStop,
      allowRunnerCandidate: !latchedStop && this.opts.journalHealthy?.() !== false,
      ...(entryBlockedInstruments.size > 0 ? { entryBlockedInstruments } : {}),
      ...(this.activeRunner !== undefined ? { runner: this.activeRunner } : {}),
      ...(this.pendingRunnerLotId !== undefined ? { pendingRunnerLotId: this.pendingRunnerLotId } : {}),
    };
  }

  private captureRunnerCandidate(evaluation: MmEvaluation): void {
    const candidate = evaluation.runnerCandidateLotId;
    if (candidate === undefined) {
      if (evaluation.phase !== 'QUOTING') this.pendingRunnerLotId = undefined;
      return;
    }
    if (this.activeRunner !== undefined || this.pendingRunnerLotId === candidate) return;
    const lot = this.opts.oms.getOpenLots().find((openLot) => openLot.lotId === candidate);
    if (lot === undefined) return;
    this.pendingRunnerLotId = candidate;
    this.journal('mm.state', {
      event: 'RUNNER_PENDING',
      instrumentId: String(lot.instrumentId),
      lotId: candidate,
      detail: `entryPaise=${lot.pricePaise}`,
    });
  }

  private activatePendingRunner(nowMs: number): void {
    if (this.pendingRunnerLotId === undefined || this.activeRunner !== undefined) return;
    const lot = this.opts.oms.getOpenLots().find((openLot) => openLot.lotId === this.pendingRunnerLotId);
    if (lot === undefined) {
      this.pendingRunnerLotId = undefined;
      return;
    }
    const bid = this.opts.view.optionRows().get(lot.instrumentId)?.bidPaise ?? 0;
    const highWater = Math.max(lot.pricePaise, bid);
    this.activeRunner = {
      lotId: lot.lotId,
      instrumentId: lot.instrumentId,
      qty: lot.qty,
      entryPricePaise: lot.pricePaise,
      openedTs: lot.ts,
      activatedTs: nowMs,
      highWaterBidPaise: highWater,
      stopPaise: this.engine.runnerStopPaise(lot.pricePaise, highWater),
    };
    this.pendingRunnerLotId = undefined;
    this.journal('mm.state', {
      event: 'RUNNER_ACTIVE',
      instrumentId: String(lot.instrumentId),
      lotId: lot.lotId,
      detail: `entryPaise=${lot.pricePaise}; stopPaise=${this.activeRunner.stopPaise}`,
    });
  }

  private refreshRunner(_nowMs: number): void {
    const runner = this.activeRunner;
    if (runner === undefined) return;
    const lot = this.opts.oms.getOpenLots().find((openLot) => openLot.lotId === runner.lotId);
    if (lot === undefined) {
      this.syncInventoryState('runner lot missing');
      return;
    }
    const bid = this.opts.view.optionRows().get(runner.instrumentId)?.bidPaise ?? 0;
    const highWater = Math.max(runner.highWaterBidPaise, bid);
    this.activeRunner = {
      ...runner,
      qty: lot.qty,
      entryPricePaise: lot.pricePaise,
      openedTs: lot.ts,
      highWaterBidPaise: highWater,
      stopPaise: this.engine.runnerStopPaise(lot.pricePaise, highWater),
    };
  }

  private syncInventoryState(detail: string): void {
    const lots = this.opts.oms.getOpenLots();
    // Release reservations for lots that are no longer open (closed or never existed)
    // and have no live working exit order — handles the cancel-before-fill case.
    if (this.reservedLotIds.size > 0) {
      const openIds = new Set(lots.map((l) => l.lotId));
      const liveExitLotIds = new Set(
        this.liveOrders()
          .filter((o) => o.side === 'SELL')
          .flatMap((o) => o.closeLotIds ?? []),
      );
      for (const lotId of this.reservedLotIds) {
        if (!openIds.has(lotId) || !liveExitLotIds.has(lotId)) this.reservedLotIds.delete(lotId);
      }
    }
    if (this.pendingRunnerLotId !== undefined && !lots.some((lot) => lot.lotId === this.pendingRunnerLotId)) {
      this.pendingRunnerLotId = undefined;
    }
    const runner = this.activeRunner;
    if (runner !== undefined && !lots.some((lot) => lot.lotId === runner.lotId)) {
      this.activeRunner = undefined;
      this.journal('mm.state', {
        event: 'RUNNER_CLOSED',
        instrumentId: String(runner.instrumentId),
        lotId: runner.lotId,
        detail,
      });
    }
  }

  private liveOrders(): Order[] {
    const prefix = `${this.opts.strategyId}:`;
    return this.opts.oms
      .getOrders()
      .filter((order) => !isTerminalOrderState(order.state) && order.tag.startsWith(prefix));
  }

  private async cancelAllWorking(why: string, preserveEscalating = false): Promise<void> {
    for (const order of this.liveOrders()) {
      if (preserveEscalating && this.opts.escalator?.isTracked(order.clientOrderId)) continue;
      await this.opts.oms.cancel(order.clientOrderId).catch((err: unknown) => {
        this.journal('diag.error', { where: `mm.cancelAll(${why})`, message: String(err) });
      });
    }
  }

  private gateContext(nowMs: number): RiskGateContext {
    const atm = this.opts.view.atmStrikePaise();
    const gates = this.opts.quoteGates;
    return {
      nowMs,
      nowHHMM: formatHHMMIst(nowMs),
      allowedInstruments: this.opts.view.allowedInstruments(),
      optionRows: this.opts.view.optionRows(),
      ...(atm !== undefined ? { atmStrikePaise: atm } : {}),
      strikeBand: gates.strikeBand,
      maxSpreadPct: gates.maxSpreadPct,
      minOi: gates.minOi,
      minVolume: gates.minVolume,
      openPositions: this.opts.oms.getPositions(),
      session: this.opts.sessionRisk.current(),
      throttleAvailable: 1,
    };
  }

  private noteEntryReplacement(nowMs: number): void {
    this.entryReplacementTs.push(nowMs);
    this.pruneEntryReplacements(nowMs);
  }

  private entryChurnGuardActive(nowMs: number): boolean {
    this.pruneEntryReplacements(nowMs);
    const limit = this.engine.activeParams().maxEntryReplacementsPerMin;
    return limit > 0 && this.entryReplacementTs.length >= limit;
  }

  private pruneEntryReplacements(nowMs: number): void {
    const cutoff = nowMs - 60_000;
    this.entryReplacementTs = this.entryReplacementTs.filter((ts) => ts > cutoff);
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

function sameAllocation(left?: readonly string[], right?: readonly string[]): boolean {
  const a = [...(left ?? [])].sort();
  const b = [...(right ?? [])].sort();
  return a.length === b.length && a.every((lotId, index) => lotId === b[index]);
}

function entryResidenceStart(order: Order): number {
  return order.state === 'ACKED' ? order.updatedTs : order.createdTs;
}

function isUrgentExit(reason: MmDesiredOrder['reason']): boolean {
  return reason === 'HARD_STOP' || reason === 'SCALP_TIMEOUT' || reason === 'RUNNER_TRAIL' ||
    reason === 'RUNNER_TIMEOUT' || reason === 'RISK_EXIT';
}

function reasonMatches(order: Order, candidate: MmDesiredOrder): boolean {
  return order.tag.split(':')[1] === candidate.reason.toLowerCase();
}

function intentTypeMatchesOrder(intentType: OrderIntent['type'], orderType: Order['type']): boolean {
  return intentType === 'LIMIT' ? orderType === 'LIMIT' : orderType === 'MARKET';
}

function priceMatches(left: number | undefined, right: number | undefined, tolerance: number): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Math.abs(left - right) <= tolerance;
}

function cloneDesiredOrder(order: MmDesiredOrder): MmDesiredOrder {
  return {
    ...order,
    ...(order.stopPlan !== undefined ? { stopPlan: { ...order.stopPlan } } : {}),
    ...(order.closeLotIds !== undefined ? { closeLotIds: [...order.closeLotIds] } : {}),
    ...(order.entryFeatures !== undefined ? { entryFeatures: { ...order.entryFeatures } } : {}),
  };
}

function floorToTick(value: number, tick: number): number {
  return Math.floor(value / tick) * tick;
}

function broadLane(order: Pick<Order, 'instrumentId' | 'side'> | MmDesiredOrder): string {
  return `${String(order.instrumentId)}:${order.side}`;
}

function lotLane(instrumentId: InstrumentId, lotId: string): string {
  return `${String(instrumentId)}:${lotId}`;
}

function blockOrderAllocation(
  order: Order,
  broad: Set<string>,
  lots: Set<string>,
  allocatedSellInstruments: Set<string>,
): void {
  if (order.side === 'SELL' && (order.closeLotIds?.length ?? 0) > 0) {
    allocatedSellInstruments.add(String(order.instrumentId));
    for (const lotId of order.closeLotIds ?? []) lots.add(lotLane(order.instrumentId, lotId));
    return;
  }
  broad.add(broadLane(order));
}

function allocationBlocked(
  order: MmDesiredOrder,
  broad: ReadonlySet<string>,
  lots: ReadonlySet<string>,
  allocatedSellInstruments: ReadonlySet<string>,
): boolean {
  if (broad.has(broadLane(order))) return true;
  if (order.side !== 'SELL') return false;
  if ((order.closeLotIds?.length ?? 0) === 0) {
    return allocatedSellInstruments.has(String(order.instrumentId));
  }
  return (order.closeLotIds ?? []).some((lotId) => lots.has(lotLane(order.instrumentId, lotId)));
}
