import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import type { IdFactory, InstrumentId, SessionId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { OptionChainRow } from '../domain/marketdata.js';
import { isTerminalOrderState, type Order, type OrderIntent } from '../domain/orders.js';
import type { Trade } from '../domain/positions.js';
import type { SessionStopKind } from '../domain/risk.js';
import { formatHHMMIst, type Clock } from '../domain/time.js';
import type { GatewayMmState } from '../gateway/protocol.js';
import type { ExitEscalator } from '../oms/escalation.js';
import type { Oms } from '../oms/oms.js';
import type { RiskGate, RiskGateContext } from '../risk/risk-gate.js';
import type { SessionRiskState } from '../risk/session-risk.js';
import type { MarketViewProvider } from '../strategy/runner.js';
import type { StrategyLifecycle, StrategyParams } from '../strategy/types.js';
import {
  OpMinusEngine,
  type OpMinusActiveRunnerInput,
  type OpMinusDesiredOrder,
  type OpMinusEvaluation,
  type OpMinusInput,
  type OpMinusShortBookInput,
} from './op-minus-engine.js';

type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

export interface OpMinusQuoteGates {
  maxSpreadPct: number;
  minOi: number;
  minVolume: number;
  strikeBand: number;
}

export interface OpMinusRunnerOptions {
  sessionId: SessionId;
  strategyId: string;
  params: StrategyParams;
  market: MarketProfile;
  scalpExpiry: string;
  gate: RiskGate;
  oms: Oms;
  escalator?: ExitEscalator;
  sessionRisk: SessionRiskState;
  ids: IdFactory;
  clock: Clock;
  view: MarketViewProvider;
  quoteGates: OpMinusQuoteGates;
  journal?: JournalSink;
  journalHealthy?: () => boolean;
  evalIntervalMs?: number;
}

/** Impure runtime shell for the intentionally naked OP(-) decision engine. */
export class OpMinusRunner {
  private lifecycle: StrategyLifecycle = 'DISARMED';
  private params: StrategyParams;
  private readonly engine: OpMinusEngine;
  private readonly evalIntervalMs: number;
  private lastEvalMs = Number.NEGATIVE_INFINITY;
  private evaluating = false;
  private forceReconcileRequested = false;
  private lastNoTradeReason: string | undefined;
  private activeRunner: OpMinusActiveRunnerInput | undefined;
  private pendingRunnerLotId: string | undefined;
  private quotePhase = 'IDLE';
  private readonly cooldownUntilByRight = new Map<OptionRight, number>();
  private readonly reservedLotIds = new Set<string>();

  constructor(private readonly opts: OpMinusRunnerOptions) {
    this.params = { ...opts.params };
    this.engine = new OpMinusEngine(opts.market, this.params);
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
    this.refreshRunner();
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
    const lotSize = this.opts.market.contract.lotSize;
    const rows = this.opts.view.optionRows();
    const shortUnits = this.opts.oms.getPositions()
      .filter((position) => position.state !== 'CLOSED' && position.side === 'SELL' && rows.get(position.instrumentId)?.expiry === this.opts.scalpExpiry)
      .reduce((sum, position) => sum + position.qty, 0);
    const workingShortUnits = this.liveOrders()
      .filter((order) => order.purpose === 'ENTRY' && order.side === 'SELL')
      .reduce((sum, order) => sum + Math.max(0, order.qty - order.filledQty), 0);
    const runner = this.activeRunner;
    const pendingRunnerInstrumentId = this.pendingRunnerInstrumentId();
    return {
      quotePhase: this.quotePhase,
      direction: 'SHORT',
      scalpSlotsUsed: (shortUnits + workingShortUnits) / lotSize,
      scalpSlotsMax: this.engine.activeParams().scalpLotsPerRight * 2,
      expiryDate: this.opts.scalpExpiry,
      runnerStatus: runner !== undefined ? 'ACTIVE' : this.pendingRunnerLotId !== undefined ? 'PENDING' : 'AVAILABLE',
      ...(pendingRunnerInstrumentId !== undefined ? { pendingRunnerInstrumentId } : {}),
      ...(runner !== undefined
        ? {
            runner: {
              instrumentId: String(runner.instrumentId),
              entryPricePaise: runner.entryPricePaise,
              lowWaterAskPaise: runner.lowWaterAskPaise,
              stopPaise: runner.stopPaise,
              openedTs: runner.openedTs,
              activatedTs: runner.activatedTs,
            },
          }
        : {}),
      defences: [],
    };
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
    const exitOrder = this.opts.oms.getOrder(trade.exit.clientOrderId);
    const exitTag = exitOrder?.tag.split(':')[1];
    const right = this.opts.view.optionRows().get(trade.instrumentId)?.right;
    for (const lotId of exitOrder?.closeLotIds ?? []) this.reservedLotIds.delete(lotId);

    if (exitTag === 'target' && this.pendingRunnerLotId !== undefined) {
      const pending = this.opts.oms.getOpenLots().find((lot) => lot.lotId === this.pendingRunnerLotId);
      if (pending?.instrumentId === trade.instrumentId) {
        if (trade.netPnlPaise > 0) this.activatePendingRunner(trade.exit.ts);
        else this.pendingRunnerLotId = undefined;
      }
    }
    if (
      right !== undefined &&
      trade.netPnlPaise < 0 &&
      (exitTag === 'hard_stop' || exitTag === 'scalp_timeout' || exitTag === 'risk_exit')
    ) {
      this.cooldownUntilByRight.set(
        right,
        trade.exit.ts + this.engine.activeParams().defensiveCooldownSec * 1_000,
      );
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
      this.refreshRunner();
      const evaluation = this.engine.evaluate(this.buildInput(nowMs));
      this.quotePhase = evaluation.phase;
      this.captureRunnerCandidate(evaluation);
      let desired = evaluation.desired.filter((order) => {
        if (order.purpose !== 'ENTRY') return true;
        const right = this.opts.view.optionRows().get(order.instrumentId)?.right;
        return right === undefined || (this.cooldownUntilByRight.get(right) ?? 0) <= nowMs;
      });

      if (this.opts.journalHealthy?.() === false) {
        desired = desired.filter((order) => order.purpose !== 'ENTRY');
        this.noTrade('JOURNAL_UNHEALTHY');
      } else if (evaluation.pauseReason !== undefined) {
        this.noTrade(evaluation.phase, evaluation.pauseReason);
      } else if (desired.some((order) => order.purpose === 'ENTRY')) {
        this.lastNoTradeReason = undefined;
      } else if (desired.length === 0) {
        this.noTrade('NO_QUOTABLE_MARKET');
      }

      const live = this.liveOrders();
      const tolerance = this.engine.activeParams().repriceTicks * this.opts.market.tickSizePaise;
      const matched = new Set<OpMinusDesiredOrder>();
      const blockedBroad = new Set<string>();
      const blockedLots = new Set<string>();
      for (const order of live) {
        const remainingQty = Math.max(0, order.qty - order.filledQty);
        if (this.opts.escalator?.isTracked(order.clientOrderId)) {
          const allocated = desired.find((candidate) =>
            !matched.has(candidate) && candidate.instrumentId === order.instrumentId && candidate.side === order.side &&
            candidate.qty === remainingQty && sameAllocation(candidate.closeLotIds, order.closeLotIds));
          if (allocated !== undefined) matched.add(allocated);
          blockOrder(order, blockedBroad, blockedLots);
          continue;
        }
        const match = desired.find((candidate) =>
          !matched.has(candidate) && candidate.instrumentId === order.instrumentId && candidate.side === order.side &&
          candidate.qty === remainingQty && intentTypeMatchesOrder(candidate.type, order.type) &&
          reasonMatches(order, candidate) && sameAllocation(candidate.closeLotIds, order.closeLotIds) &&
          priceMatches(order.limitPricePaise, candidate.limitPricePaise, tolerance));
        if (match !== undefined) matched.add(match);
        else {
          if (
            order.purpose === 'ENTRY' &&
            nowMs - order.createdTs < this.engine.activeParams().minRequoteMs
          ) {
            blockOrder(order, blockedBroad, blockedLots);
            continue;
          }
          blockOrder(order, blockedBroad, blockedLots);
          await this.opts.oms.cancel(order.clientOrderId).catch((error: unknown) => {
            this.journal('diag.error', { where: 'op-minus.cancel', message: String(error) });
          });
        }
      }

      for (const order of desired) {
        if (matched.has(order) || orderBlocked(order, blockedBroad, blockedLots)) continue;
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

  private async place(order: OpMinusDesiredOrder, nowMs: number): Promise<void> {
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
      ttlMs: isUrgent(order.reason) ? 2_000 : this.engine.activeParams().quoteTtlSec * 1_000,
      tag: `${this.opts.strategyId}:${order.reason.toLowerCase()}`,
      purpose: order.purpose,
      ...(order.stopPlan !== undefined ? { stopPlan: order.stopPlan } : {}),
      ...(order.closeLotIds !== undefined ? { closeLotIds: [...order.closeLotIds] } : {}),
    };
    this.journal('intent.proposed', { intent });
    const verdict = this.opts.gate.evaluate(intent, this.gateContext(nowMs));
    this.journal('risk.verdict', { verdict });
    if (!verdict.approved) {
      if (order.purpose === 'ENTRY') this.noTrade(`GATE_${verdict.reason ?? 'REJECTED'}`);
      return;
    }
    const result = await this.opts.oms.submit(intent, verdict);
    if (!result.accepted) {
      this.journal('diag.error', {
        where: 'op-minus.place',
        message: `submit not accepted (${result.reason ?? 'unknown'}) for ${order.reason} ${order.side} ${String(order.instrumentId)}`,
      });
      return;
    }
    if (isUrgent(order.reason)) this.opts.escalator?.track(result.order, intent);
    for (const lotId of order.closeLotIds ?? []) this.reservedLotIds.add(lotId);
  }

  private buildInput(nowMs: number): OpMinusInput {
    const rows = this.opts.view.optionRows();
    const strategyView = this.opts.view.strategyView(nowMs);
    const positions = this.opts.oms.getPositions().filter((position) => position.state !== 'CLOSED' && position.qty > 0);
    const existingCycleRow = positions
      .map((position) => rows.get(position.instrumentId))
      .find((row) => row?.expiry === this.opts.scalpExpiry);
    const cycleStrike = existingCycleRow?.strikePaise ?? this.opts.view.atmStrikePaise();
    const rowFor = (expiry: string, right: OptionRight): OptionChainRow | undefined => {
      if (cycleStrike === undefined) return undefined;
      return [...rows.values()].find((row) => row.expiry === expiry && row.right === right && row.strikePaise === cycleStrike);
    };
    const shortBooks: OpMinusShortBookInput[] = [];
    for (const position of positions) {
      const row = rows.get(position.instrumentId);
      if (row === undefined) continue;
      const lots = this.opts.oms.getOpenLots(position.instrumentId)
        .filter((lot) => !this.reservedLotIds.has(lot.lotId))
        .map((lot) => ({ lotId: lot.lotId, qty: lot.qty, entryPricePaise: lot.pricePaise, openedTs: lot.ts }));
      if (position.side === 'SELL' && row.expiry === this.opts.scalpExpiry) {
        shortBooks.push({ instrumentId: position.instrumentId, right: row.right, qty: position.qty, lots, row });
      }
    }
    const scalpCe = rowFor(this.opts.scalpExpiry, 'CE');
    const scalpPe = rowFor(this.opts.scalpExpiry, 'PE');
    const latchedStop = this.opts.sessionRisk.current().latchedStop !== undefined;
    return {
      nowMs,
      nowHHMM: formatHHMMIst(nowMs),
      ...(strategyView.spotPaise !== undefined ? { spotPaise: strategyView.spotPaise } : {}),
      ...(strategyView.underlyingFeatures !== undefined ? { underlying: strategyView.underlyingFeatures } : {}),
      ...(scalpCe !== undefined ? { scalpCe } : {}),
      ...(scalpPe !== undefined ? { scalpPe } : {}),
      shortBooks,
      latchedStop,
      allowRunnerCandidate: !latchedStop && this.opts.journalHealthy?.() !== false,
      ...(this.activeRunner !== undefined ? { runner: this.activeRunner } : {}),
      ...(this.pendingRunnerLotId !== undefined ? { pendingRunnerLotId: this.pendingRunnerLotId } : {}),
    };
  }

  private captureRunnerCandidate(evaluation: OpMinusEvaluation): void {
    const candidate = evaluation.runnerCandidateLotId;
    if (candidate === undefined) {
      if (evaluation.phase !== 'SCALPING') this.pendingRunnerLotId = undefined;
      return;
    }
    if (this.activeRunner !== undefined || this.pendingRunnerLotId === candidate) return;
    const lot = this.opts.oms.getOpenLots().find((openLot) => openLot.lotId === candidate);
    if (lot === undefined) return;
    this.pendingRunnerLotId = candidate;
    this.journal('mm.state', {
      event: 'RUNNER_PENDING', instrumentId: String(lot.instrumentId), lotId: candidate,
      detail: `shortEntryPaise=${lot.pricePaise}`,
    });
  }

  private activatePendingRunner(nowMs: number): void {
    if (this.pendingRunnerLotId === undefined || this.activeRunner !== undefined) return;
    const lot = this.opts.oms.getOpenLots().find((openLot) => openLot.lotId === this.pendingRunnerLotId);
    if (lot === undefined) {
      this.pendingRunnerLotId = undefined;
      return;
    }
    const ask = this.opts.view.optionRows().get(lot.instrumentId)?.askPaise ?? lot.pricePaise;
    this.activeRunner = {
      lotId: lot.lotId,
      instrumentId: lot.instrumentId,
      qty: lot.qty,
      entryPricePaise: lot.pricePaise,
      openedTs: lot.ts,
      activatedTs: nowMs,
      lowWaterAskPaise: Math.min(lot.pricePaise, ask > 0 ? ask : lot.pricePaise),
      stopPaise: this.engine.runnerCostStopPaise(lot.pricePaise),
    };
    this.pendingRunnerLotId = undefined;
    this.journal('mm.state', {
      event: 'RUNNER_ACTIVE', instrumentId: String(lot.instrumentId), lotId: lot.lotId,
      detail: `shortEntryPaise=${lot.pricePaise}; costStopPaise=${this.activeRunner.stopPaise}`,
    });
  }

  private refreshRunner(): void {
    const runner = this.activeRunner;
    if (runner === undefined) return;
    const lot = this.opts.oms.getOpenLots().find((openLot) => openLot.lotId === runner.lotId);
    if (lot === undefined) {
      this.syncInventoryState('runner lot missing');
      return;
    }
    const ask = this.opts.view.optionRows().get(runner.instrumentId)?.askPaise ?? runner.lowWaterAskPaise;
    this.activeRunner = {
      ...runner,
      qty: lot.qty,
      entryPricePaise: lot.pricePaise,
      openedTs: lot.ts,
      lowWaterAskPaise: ask > 0 ? Math.min(runner.lowWaterAskPaise, ask) : runner.lowWaterAskPaise,
      stopPaise: this.engine.runnerCostStopPaise(lot.pricePaise),
    };
  }

  private syncInventoryState(detail: string): void {
    const lots = this.opts.oms.getOpenLots();
    const openIds = new Set(lots.map((lot) => lot.lotId));
    const liveExitIds = new Set(this.liveOrders().filter((order) => order.purpose !== 'ENTRY').flatMap((order) => order.closeLotIds ?? []));
    for (const lotId of this.reservedLotIds) {
      if (!openIds.has(lotId) || !liveExitIds.has(lotId)) this.reservedLotIds.delete(lotId);
    }
    if (this.pendingRunnerLotId !== undefined && !openIds.has(this.pendingRunnerLotId)) this.pendingRunnerLotId = undefined;
    const runner = this.activeRunner;
    if (runner !== undefined && !openIds.has(runner.lotId)) {
      this.activeRunner = undefined;
      this.journal('mm.state', {
        event: 'RUNNER_CLOSED', instrumentId: String(runner.instrumentId), lotId: runner.lotId, detail,
      });
    }
  }

  private pendingRunnerInstrumentId(): string | undefined {
    const lot = this.opts.oms.getOpenLots().find((candidate) => candidate.lotId === this.pendingRunnerLotId);
    return lot === undefined ? undefined : String(lot.instrumentId);
  }

  private liveOrders(): Order[] {
    const prefix = `${this.opts.strategyId}:`;
    return this.opts.oms.getOrders().filter((order) => !isTerminalOrderState(order.state) && order.tag.startsWith(prefix));
  }

  private async cancelAllWorking(why: string, preserveEscalating = false): Promise<void> {
    for (const order of this.liveOrders()) {
      if (preserveEscalating && this.opts.escalator?.isTracked(order.clientOrderId)) continue;
      await this.opts.oms.cancel(order.clientOrderId).catch((error: unknown) => {
        this.journal('diag.error', { where: `op-minus.cancelAll(${why})`, message: String(error) });
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
    this.journal('strategy.noTrade', { strategyId: this.opts.strategyId, reason, ...(detail !== undefined ? { detail } : {}) });
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

function isUrgent(reason: OpMinusDesiredOrder['reason']): boolean {
  return reason === 'HARD_STOP' || reason === 'SCALP_TIMEOUT' || reason === 'RUNNER_COST_STOP' || reason === 'RISK_EXIT';
}

function reasonMatches(order: Order, candidate: OpMinusDesiredOrder): boolean {
  return order.tag.split(':')[1] === candidate.reason.toLowerCase();
}

function intentTypeMatchesOrder(intentType: OrderIntent['type'], orderType: Order['type']): boolean {
  return intentType === 'LIMIT' ? orderType === 'LIMIT' : orderType === 'MARKET';
}

function priceMatches(left: number | undefined, right: number | undefined, tolerance: number): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Math.abs(left - right) <= tolerance;
}

function broadLane(order: Pick<Order, 'instrumentId' | 'side'> | OpMinusDesiredOrder): string {
  return `${String(order.instrumentId)}:${order.side}`;
}

function lotLane(instrumentId: InstrumentId, lotId: string): string {
  return `${String(instrumentId)}:${lotId}`;
}

function blockOrder(order: Order, broad: Set<string>, lots: Set<string>): void {
  if ((order.closeLotIds?.length ?? 0) > 0) {
    for (const lotId of order.closeLotIds ?? []) lots.add(lotLane(order.instrumentId, lotId));
    return;
  }
  broad.add(broadLane(order));
}

function orderBlocked(order: OpMinusDesiredOrder, broad: ReadonlySet<string>, lots: ReadonlySet<string>): boolean {
  if (broad.has(broadLane(order))) return true;
  return (order.closeLotIds ?? []).some((lotId) => lots.has(lotLane(order.instrumentId, lotId)));
}
