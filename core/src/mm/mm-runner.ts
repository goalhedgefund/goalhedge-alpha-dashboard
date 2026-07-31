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
    void this.cancelAllWorking('disarm');
  }

  setParams(params: StrategyParams): void {
    this.params = { ...params };
    this.engine.setParams(this.params);
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
    const expiryInfo = this.expirySnapshot();
    return {
      quotePhase: this.quotePhase,
      scalpSlotsUsed: (scalpHeldUnits + workingBidUnits) / lotSize,
      scalpSlotsMax: params.maxScalpLots,
      trendRegime: trend.regime,
      trendDriftPct: trend.driftPct,
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

      if (this.opts.journalHealthy?.() === false) {
        desired = desired.filter((order) => order.side === 'SELL');
        this.noTrade('JOURNAL_UNHEALTHY');
      } else if (evaluation.pauseReason !== undefined) {
        this.noTrade(evaluation.phase, evaluation.pauseReason);
      } else if (desired.some((order) => order.side === 'BUY')) {
        this.lastNoTradeReason = undefined;
      } else if (desired.length === 0) {
        this.noTrade('NO_QUOTABLE_MARKET');
      }

      const live = this.liveOrders();
      const tolerance = this.engine.activeParams().repriceTicks * this.opts.market.tickSizePaise;
      const matchedDesired = new Set<MmDesiredOrder>();
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
          const entryStillEligible = desired.some(
            (candidate) =>
              candidate.purpose === 'ENTRY' &&
              candidate.instrumentId === order.instrumentId &&
              candidate.side === order.side,
          );
          // Keep passive entry quotes on the book long enough to earn queue
          // position, but never retain an order once its directional setup
          // has disappeared.
          if (
            order.purpose === 'ENTRY' &&
            entryStillEligible &&
            nowMs - order.createdTs < this.engine.activeParams().minRequoteMs
          ) {
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
          await this.opts.oms.cancel(order.clientOrderId).catch((err: unknown) => {
            this.journal('diag.error', { where: 'mm.cancel', message: String(err) });
          });
        }
      }

      for (const order of desired) {
        if (matchedDesired.has(order)) continue;
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
        await this.place(order, nowMs);
      }
    } finally {
      this.evaluating = false;
      if (this.forceReconcileRequested) {
        this.forceReconcileRequested = false;
        await this.reconcile(this.opts.clock.now(), true);
      }
    }
  }

  private async place(order: MmDesiredOrder, nowMs: number): Promise<void> {
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
      ttlMs: isUrgentExit(order.reason) ? 2_000 : this.engine.activeParams().quoteTtlSec * 1_000,
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
      return;
    }
    const result = await this.opts.oms.submit(intent, verdict);
    if (!result.accepted) {
      this.journal('diag.error', {
        where: 'mm.place',
        message: `submit not accepted (${result.reason ?? 'unknown'}) for ${order.reason} ${order.side} ${String(order.instrumentId)}`,
      });
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
    }
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
