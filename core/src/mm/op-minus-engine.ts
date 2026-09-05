import { computeCharges } from '../charges/engine.js';
import type { MarketProfile } from '../config/schemas.js';
import type { InstrumentId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { OptionChainRow } from '../domain/marketdata.js';
import type { UnderlyingFeatures } from '../marketdata/features/library.js';
import type { IntentType, StopPlan } from '../domain/orders.js';
import { numParam, type StrategyParams } from '../strategy/types.js';

export interface OpMinusParams {
  scalpLotsPerRight: number;
  /** Legacy fallback retained for old configuration files. */
  rewardRiskRatio: number;
  targetPremiumPct: number;
  hardStopPremiumPct: number;
  /** Manage the CE+PE scalp as one premium package instead of two directional legs. */
  pairedExitEnabled: boolean;
  /** Cross paired entries to the bid; false keeps the legacy passive quote. */
  pairedEntryAtBid: boolean;
  /** Ticks below the observed bid allowed on a paired SELL limit to survive quote movement. */
  pairedEntryProtectTicks: number;
  /** Choose the weekly ATM strike from call-put parity instead of monthly futures. */
  parityAtmEnabled: boolean;
  /** Profit trigger on the combined CE+PE entry premium. */
  combinedTargetPremiumPct: number;
  /** DTE-1 package target; defaults to the base/DTE-0 target. */
  dte1CombinedTargetPremiumPct: number;
  /**
   * Pair-level stop: when both rights are short, buy everything back once the
   * combined mark-to-market loss reaches this % of the combined entry
   * premium. Must be tighter than 2× the per-leg stop to add protection over
   * the leg stops (a both-legs-adverse vol spike is the naked straddle's
   * worst case). Set very high (e.g. 1000) to disable.
   */
  combinedStopPremiumPct: number;
  runnerLots: number;
  quoteTtlSec: number;
  minRequoteMs: number;
  maxHoldSec: number;
  /** DTE-1 hold cap; defaults to the base/DTE-0 hold cap. */
  dte1MaxHoldSec: number;
  /** Maximum time one entry leg may remain filled without its pair. */
  leggingTimeoutSec: number;
  defensiveCooldownSec: number;
  /** Pause the whole pair after every completed package cycle. */
  cycleCooldownSec: number;
  rangeFilterEnabled: boolean;
  maxAbsRet30Pct: number;
  maxVwapDistancePct: number;
  /**
   * ATR-relative VWAP stretch bound: spot must sit within mult × ATR(1m,14)
   * of session VWAP, on top of the fixed % cap. 0 disables. When enabled and
   * ATR has not warmed up yet, the range is NOT ready (conservative).
   */
  maxVwapDistanceAtrMult: number;
  /**
   * Trend-strength gate: ADX(1m,14) must be at or below this. 0 disables.
   * When enabled and ADX has not warmed up (~29 bars), range is NOT ready.
   */
  maxAdx: number;
  /**
   * IV-stability proxy: entries are blocked when the ATM straddle mid rose
   * more than this fraction over straddleTrendWindowSec (e.g. 0.02 = +2%).
   * A rising straddle with spot pinned near VWAP is a volatility bid — the
   * exact regime a premium seller must not enter. 0 disables. When enabled
   * and the runner has not yet accumulated a full window (boot or strike
   * re-center), range is NOT ready.
   */
  maxStraddleRisePct: number;
  straddleTrendWindowSec: number;
  /** Completed round trips allowed per right per day; 0 disables the cap. */
  maxCyclesPerRight: number;
  entryImprovementTicks: number;
  defensiveProtectTicks: number;
  repriceTicks: number;
  /** Latest calendar DTE on which new entries are allowed. */
  maxDaysToExpiry: number;
  quoteFrom: string;
  /** DTE-1 entry start; defaults to quoteFrom. */
  dte1QuoteFrom: string;
  entryCutoff: string;
  /** DTE-1 entry cutoff; defaults to entryCutoff. */
  dte1EntryCutoff: string;
}

function boundedParam(params: StrategyParams, key: string, dflt: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, numParam(params, key, dflt)));
}

function strParam(params: StrategyParams, key: string, dflt: string): string {
  const value = params[key];
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : dflt;
}

function boolParam(params: StrategyParams, key: string, dflt: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : dflt;
}

export function resolveOpMinusParams(params: StrategyParams): OpMinusParams {
  return {
    scalpLotsPerRight: Math.floor(boundedParam(params, 'scalpLotsPerRight', 2, 1, 20)),
    rewardRiskRatio: boundedParam(params, 'rewardRiskRatio', 2, 0.1, 20),
    targetPremiumPct: boundedParam(params, 'targetPremiumPct', 5, 0.1, 50),
    hardStopPremiumPct: boundedParam(params, 'hardStopPremiumPct', 9, 0.1, 100),
    pairedExitEnabled: boolParam(params, 'pairedExitEnabled', false),
    pairedEntryAtBid: boolParam(params, 'pairedEntryAtBid', true),
    pairedEntryProtectTicks: Math.floor(boundedParam(params, 'pairedEntryProtectTicks', 0, 0, 100)),
    parityAtmEnabled: boolParam(params, 'parityAtmEnabled', false),
    combinedTargetPremiumPct: boundedParam(params, 'combinedTargetPremiumPct', 1, 0.1, 50),
    dte1CombinedTargetPremiumPct: boundedParam(
      params,
      'dte1CombinedTargetPremiumPct',
      boundedParam(params, 'combinedTargetPremiumPct', 1, 0.1, 50),
      0.1,
      50,
    ),
    combinedStopPremiumPct: boundedParam(params, 'combinedStopPremiumPct', 6, 0.1, 1_000),
    runnerLots: Math.min(1, Math.floor(boundedParam(params, 'runnerLots', 1, 0, 1))),
    quoteTtlSec: boundedParam(params, 'quoteTtlSec', 20, 1, 86_400),
    minRequoteMs: Math.floor(boundedParam(params, 'minRequoteMs', 2_000, 0, 60_000)),
    maxHoldSec: boundedParam(params, 'maxHoldSec', 180, 1, 86_400),
    dte1MaxHoldSec: boundedParam(
      params,
      'dte1MaxHoldSec',
      boundedParam(params, 'maxHoldSec', 180, 1, 86_400),
      1,
      86_400,
    ),
    leggingTimeoutSec: boundedParam(params, 'leggingTimeoutSec', 5, 1, 300),
    defensiveCooldownSec: boundedParam(params, 'defensiveCooldownSec', 300, 0, 86_400),
    cycleCooldownSec: boundedParam(params, 'cycleCooldownSec', 0, 0, 86_400),
    rangeFilterEnabled: boolParam(params, 'rangeFilterEnabled', false),
    maxAbsRet30Pct: boundedParam(params, 'maxAbsRet30Pct', 0.001, 0.00001, 0.1),
    maxVwapDistancePct: boundedParam(params, 'maxVwapDistancePct', 0.0015, 0, 0.1),
    maxVwapDistanceAtrMult: boundedParam(params, 'maxVwapDistanceAtrMult', 0, 0, 100),
    maxAdx: boundedParam(params, 'maxAdx', 0, 0, 100),
    maxStraddleRisePct: boundedParam(params, 'maxStraddleRisePct', 0, 0, 1),
    straddleTrendWindowSec: boundedParam(params, 'straddleTrendWindowSec', 180, 10, 3_600),
    maxCyclesPerRight: Math.floor(boundedParam(params, 'maxCyclesPerRight', 0, 0, 1_000)),
    entryImprovementTicks: Math.floor(boundedParam(params, 'entryImprovementTicks', 1, 0, 20)),
    defensiveProtectTicks: Math.floor(boundedParam(params, 'defensiveProtectTicks', 10, 1, 100)),
    repriceTicks: Math.floor(boundedParam(params, 'repriceTicks', 2, 0, 100)),
    maxDaysToExpiry: Math.floor(boundedParam(params, 'maxDaysToExpiry', 365, 0, 365)),
    quoteFrom: strParam(params, 'quoteFrom', '09:20'),
    dte1QuoteFrom: strParam(params, 'dte1QuoteFrom', strParam(params, 'quoteFrom', '09:20')),
    entryCutoff: strParam(params, 'entryCutoff', '15:10'),
    dte1EntryCutoff: strParam(params, 'dte1EntryCutoff', strParam(params, 'entryCutoff', '15:10')),
  };
}

export interface OpMinusLotInput {
  lotId: string;
  qty: number;
  entryPricePaise: number;
  openedTs: number;
}

export interface OpMinusShortBookInput {
  instrumentId: InstrumentId;
  right: OptionRight;
  qty: number;
  lots: readonly OpMinusLotInput[];
  row?: OptionChainRow;
}

export interface OpMinusActiveRunnerInput extends OpMinusLotInput {
  instrumentId: InstrumentId;
  activatedTs: number;
  lowWaterAskPaise: number;
  stopPaise: number;
}

export interface OpMinusInput {
  nowMs: number;
  nowHHMM: string;
  /** Calendar days from the IST session date to the selected scalp expiry. */
  daysToExpiry?: number;
  scalpCe?: OptionChainRow;
  scalpPe?: OptionChainRow;
  spotPaise?: number;
  underlying?: UnderlyingFeatures;
  shortBooks: readonly OpMinusShortBookInput[];
  latchedStop: boolean;
  runner?: OpMinusActiveRunnerInput;
  pendingRunnerLotId?: string;
  allowRunnerCandidate?: boolean;
  /**
   * Fractional change of the cycle-strike ATM straddle mid over the trend
   * window (runner-supplied; positive = premium rising). Undefined while the
   * sample window is still filling.
   */
  straddleDriftPct?: number;
}

export type OpMinusReason =
  | 'SHORT_ENTRY'
  | 'TARGET'
  | 'COMBINED_TARGET'
  | 'HARD_STOP'
  | 'COMBINED_STOP'
  | 'PAIR_TIMEOUT'
  | 'UNPAIRED_TIMEOUT'
  | 'SCALP_TIMEOUT'
  | 'RUNNER_COST_STOP'
  | 'RISK_EXIT';

export interface OpMinusDesiredOrder {
  instrumentId: InstrumentId;
  side: 'BUY' | 'SELL';
  qty: number;
  type: IntentType;
  limitPricePaise?: number;
  protectTicks?: number;
  purpose: 'ENTRY' | 'EXIT';
  reason: OpMinusReason;
  stopPlan?: StopPlan;
  closeLotIds?: string[];
}

export interface OpMinusEvaluation {
  desired: OpMinusDesiredOrder[];
  phase: 'SCALPING' | 'EXIT_ONLY' | 'PAUSED_WINDOW' | 'PAUSED_LOCKOUT' | 'PAUSED_DTE' | 'PAUSED_REGIME';
  pauseReason?: string;
  /**
   * Stable machine code for the specific range-gate check that blocked entries
   * (only set when phase is PAUSED_REGIME). Lets the runtime de-duplicate and
   * journal *which* gate paused the desk — trend vs warm-up vs VWAP stretch —
   * instead of one opaque "outside range" line for the whole session.
   */
  pauseCode?: string;
  runnerCandidateLotId?: string;
}

/** Outcome of the range-regime gate: ready, or blocked with a specific cause. */
export interface RangeGateResult {
  ready: boolean;
  /** Stable category of the blocking check (undefined when ready). */
  code?: string;
  /** Human-readable detail with the measured value (undefined when ready). */
  detail?: string;
}

/** Pure decision engine for the intentionally naked OP(-) short desk. */
export class OpMinusEngine {
  private params: OpMinusParams;

  constructor(private readonly market: MarketProfile, params: StrategyParams) {
    this.params = resolveOpMinusParams(params);
  }

  setParams(params: StrategyParams): void {
    this.params = resolveOpMinusParams(params);
  }

  activeParams(): OpMinusParams {
    return { ...this.params };
  }

  costRiskPaise(entryPricePaise: number): number {
    const qty = this.market.contract.lotSize;
    const charges = computeCharges(
      [
        { side: 'SELL', qty, pricePaise: entryPricePaise },
        { side: 'BUY', qty, pricePaise: entryPricePaise },
      ],
      this.market,
    );
    return ceilTick(Math.max(this.market.tickSizePaise, charges.totalPaise / qty), this.market.tickSizePaise);
  }

  targetPaise(entryPricePaise: number): number {
    const percentageTarget = entryPricePaise * (1 - this.params.targetPremiumPct / 100);
    return floorTick(
      Math.max(
        this.market.tickSizePaise,
        Math.min(percentageTarget, entryPricePaise - this.params.rewardRiskRatio * this.costRiskPaise(entryPricePaise)),
      ),
      this.market.tickSizePaise,
    );
  }

  hardStopPaise(entryPricePaise: number): number {
    const percentageStop = entryPricePaise * (1 + this.params.hardStopPremiumPct / 100);
    return ceilTick(
      Math.max(percentageStop, entryPricePaise + this.costRiskPaise(entryPricePaise)),
      this.market.tickSizePaise,
    );
  }

  runnerCostStopPaise(entryPricePaise: number): number {
    return floorTick(
      Math.max(this.market.tickSizePaise, entryPricePaise - this.costRiskPaise(entryPricePaise)),
      this.market.tickSizePaise,
    );
  }

  evaluate(input: OpMinusInput): OpMinusEvaluation {
    const pairedPositionReady = this.pairedPositionReady(input);
    const pairExitReason = this.pairedExitReason(input);
    const desired = input.shortBooks.flatMap((book) => this.exitsForShortBook(
      book,
      input,
      this.selectRunnerCandidate(input),
      pairExitReason,
      pairedPositionReady,
    ));
    const candidate = this.selectRunnerCandidate(input);

    if (input.latchedStop) {
      const riskExits = this.forceAllShortsClosed(input);
      return {
        desired: riskExits.length > 0 ? riskExits : desired,
        phase: 'PAUSED_LOCKOUT',
        pauseReason: 'session stop latched',
        ...(candidate !== undefined ? { runnerCandidateLotId: candidate } : {}),
      };
    }

    const entryStart = this.entryStart(input);
    if (input.nowHHMM < entryStart) {
      return { desired, phase: 'PAUSED_WINDOW', pauseReason: `entries start ${entryStart}` };
    }

    const entryCutoff = this.entryCutoff(input);
    if (input.nowHHMM >= entryCutoff) {
      return {
        desired,
        phase: 'EXIT_ONLY',
        pauseReason: `entry cutoff ${entryCutoff}`,
        ...(candidate !== undefined ? { runnerCandidateLotId: candidate } : {}),
      };
    }

    if (
      input.daysToExpiry !== undefined &&
      (input.daysToExpiry < 0 || input.daysToExpiry > this.params.maxDaysToExpiry)
    ) {
      return {
        desired,
        phase: 'PAUSED_DTE',
        pauseReason: `DTE ${input.daysToExpiry} outside entry range 0-${this.params.maxDaysToExpiry}`,
      };
    }

    const range = this.rangeGate(input);
    if (!range.ready) {
      return {
        desired,
        phase: 'PAUSED_REGIME',
        pauseReason: range.detail ?? 'trend or VWAP stretch outside short-premium range',
        ...(range.code !== undefined ? { pauseCode: range.code } : {}),
        ...(candidate !== undefined ? { runnerCandidateLotId: candidate } : {}),
      };
    }

    const defensiveExitPending = desired.some((order) => order.purpose === 'EXIT' && blocksNewEntries(order.reason));
    return {
      desired: defensiveExitPending ? desired : [...desired, ...this.missingShortEntries(input)],
      phase: 'SCALPING',
      ...(candidate !== undefined ? { runnerCandidateLotId: candidate } : {}),
    };
  }

  private missingShortEntries(input: OpMinusInput): OpMinusDesiredOrder[] {
    const result: OpMinusDesiredOrder[] = [];
    const lot = this.market.contract.lotSize;
    const rows: Array<{ right: OptionRight; row?: OptionChainRow }> = [
      { right: 'CE', ...(input.scalpCe !== undefined ? { row: input.scalpCe } : {}) },
      { right: 'PE', ...(input.scalpPe !== undefined ? { row: input.scalpPe } : {}) },
    ];
    for (const { row } of rows) {
      if (row === undefined || row.bidPaise <= 0 || row.askPaise <= 0) continue;
      const heldLots = input.shortBooks
        .filter((book) => book.right === row.right)
        .reduce((sum, book) => sum + book.qty, 0) / lot;
      const missing = Math.max(0, this.params.scalpLotsPerRight - heldLots);
      for (let index = 0; index < Math.floor(missing); index++) {
        const entryPricePaise = this.params.pairedExitEnabled && this.params.pairedEntryAtBid
          // A package trade must fill both rights together. Crossing to the
          // bid costs the spread once, but avoids carrying a directional naked
          // leg while a passive quote waits (the observed source of repeated
          // UNPAIRED_TIMEOUT losses).
          ? Math.max(
              this.market.tickSizePaise,
              row.bidPaise - this.params.pairedEntryProtectTicks * this.market.tickSizePaise,
            )
          : Math.max(
              row.bidPaise + this.market.tickSizePaise,
              row.askPaise - this.params.entryImprovementTicks * this.market.tickSizePaise,
            );
        result.push({
          instrumentId: row.instrumentId,
          side: 'SELL',
          qty: lot,
          type: 'LIMIT',
          limitPricePaise: entryPricePaise,
          purpose: 'ENTRY',
          reason: 'SHORT_ENTRY',
          stopPlan: {
            hardStopPremiumPaise: this.hardStopPaise(entryPricePaise),
            timeStopSec: this.holdSec(input),
            targetPaise: this.targetPaise(entryPricePaise),
          },
        });
      }
    }
    return result;
  }

  private exitsForShortBook(
    book: OpMinusShortBookInput,
    input: OpMinusInput,
    candidateLotId: string | undefined,
    pairExitReason: 'COMBINED_TARGET' | 'HARD_STOP' | 'COMBINED_STOP' | 'PAIR_TIMEOUT' | undefined,
    pairedPositionReady: boolean,
  ): OpMinusDesiredOrder[] {
    const ask = book.row?.askPaise ?? 0;
    const result: OpMinusDesiredOrder[] = [];
    const heldLotsForRight = input.shortBooks
      .filter((candidate) => candidate.right === book.right)
      .reduce((sum, candidate) => sum + candidate.qty, 0) / this.market.contract.lotSize;
    const pairReady = heldLotsForRight >= this.params.scalpLotsPerRight;
    for (const lot of book.lots) {
      if (lot.lotId === input.runner?.lotId) {
        if (ask > 0 && ask >= input.runner.stopPaise) result.push(this.urgentBuy(book.instrumentId, lot, ask, 'RUNNER_COST_STOP'));
        continue;
      }
      if (pairExitReason !== undefined) {
        result.push(this.urgentBuy(book.instrumentId, lot, ask, pairExitReason));
        continue;
      }
      const stop = this.hardStopPaise(lot.entryPricePaise);
      if (ask > 0 && ask >= stop) {
        result.push(this.urgentBuy(book.instrumentId, lot, ask, 'HARD_STOP'));
        continue;
      }
      if (this.params.pairedExitEnabled) {
        if (!pairedPositionReady && input.nowMs - lot.openedTs >= this.params.leggingTimeoutSec * 1_000) {
          result.push(this.urgentBuy(book.instrumentId, lot, ask, 'UNPAIRED_TIMEOUT'));
        }
        continue;
      }
      if (input.nowMs - lot.openedTs >= this.holdSec(input) * 1_000) {
        result.push(this.urgentBuy(book.instrumentId, lot, ask, 'SCALP_TIMEOUT'));
        continue;
      }
      if (lot.lotId === candidateLotId || !pairReady) continue;
      result.push({
        instrumentId: book.instrumentId,
        side: 'BUY',
        qty: lot.qty,
        type: 'LIMIT',
        limitPricePaise: this.targetPaise(lot.entryPricePaise),
        purpose: 'EXIT',
        reason: 'TARGET',
        closeLotIds: [lot.lotId],
      });
    }
    return result;
  }

  private pairedExitReason(
    input: OpMinusInput,
  ): 'COMBINED_TARGET' | 'HARD_STOP' | 'COMBINED_STOP' | 'PAIR_TIMEOUT' | undefined {
    // The package-loss stop predates paired lifecycle management and remains
    // active for legacy runner configurations as well.
    if (this.combinedStopTripped(input)) return 'COMBINED_STOP';
    if (!this.params.pairedExitEnabled) return undefined;
    const lots = input.shortBooks.flatMap((book) =>
      book.lots
        .filter((lot) => lot.lotId !== input.runner?.lotId)
        .map((lot) => ({ book, lot, askPaise: book.row?.askPaise ?? 0 })));
    if (!this.pairedPositionReady(input)) return undefined;
    if (lots.some((entry) => entry.askPaise <= 0)) return undefined;
    if (lots.some((entry) => entry.askPaise >= this.hardStopPaise(entry.lot.entryPricePaise))) return 'HARD_STOP';

    const entryPaise = lots.reduce((sum, entry) => sum + entry.lot.entryPricePaise * entry.lot.qty, 0);
    const markPaise = lots.reduce((sum, entry) => sum + entry.askPaise * entry.lot.qty, 0);
    if (entryPaise > 0 && entryPaise - markPaise >= entryPaise * (this.combinedTargetPct(input) / 100)) {
      return 'COMBINED_TARGET';
    }
    const pairOpenedTs = Math.max(...lots.map((entry) => entry.lot.openedTs));
    if (input.nowMs - pairOpenedTs >= this.holdSec(input) * 1_000) return 'PAIR_TIMEOUT';
    return undefined;
  }

  private entryStart(input: OpMinusInput): string {
    return input.daysToExpiry === 1 ? this.params.dte1QuoteFrom : this.params.quoteFrom;
  }

  private combinedTargetPct(input: OpMinusInput): number {
    return input.daysToExpiry === 1
      ? this.params.dte1CombinedTargetPremiumPct
      : this.params.combinedTargetPremiumPct;
  }

  private holdSec(input: OpMinusInput): number {
    return input.daysToExpiry === 1 ? this.params.dte1MaxHoldSec : this.params.maxHoldSec;
  }

  private entryCutoff(input: OpMinusInput): string {
    return input.daysToExpiry === 1 ? this.params.dte1EntryCutoff : this.params.entryCutoff;
  }

  private pairedPositionReady(input: OpMinusInput): boolean {
    if (!this.params.pairedExitEnabled) return false;
    const heldLots = (right: OptionRight): number => input.shortBooks
      .filter((book) => book.right === right)
      .reduce((sum, book) => sum + book.qty, 0) / this.market.contract.lotSize;
    return heldLots('CE') >= this.params.scalpLotsPerRight && heldLots('PE') >= this.params.scalpLotsPerRight;
  }

  private selectRunnerCandidate(input: OpMinusInput): string | undefined {
    if (this.params.runnerLots === 0 || input.runner !== undefined || input.allowRunnerCandidate === false ||
      input.latchedStop || input.nowHHMM < this.entryStart(input) || input.nowHHMM >= this.entryCutoff(input)) return undefined;
    if (input.pendingRunnerLotId !== undefined && input.shortBooks.some((book) => book.lots.some((lot) => lot.lotId === input.pendingRunnerLotId))) {
      return input.pendingRunnerLotId;
    }
    const candidates = input.shortBooks
      .filter((book) => book.lots.length >= 2)
      .flatMap((book) => book.lots.map((lot) => {
        const ask = book.row?.askPaise ?? lot.entryPricePaise;
        return { lot, progress: lot.entryPricePaise > 0 ? (lot.entryPricePaise - ask) / lot.entryPricePaise : -Infinity };
      }))
      .sort((a, b) => b.progress - a.progress || a.lot.openedTs - b.lot.openedTs);
    return candidates[0]?.lot.lotId;
  }

  /**
   * Pair-level stop for the naked straddle. Trips only when BOTH rights hold
   * scalp shorts and every scalp lot has a live ask to mark against (an
   * unmarkable leg falls back to per-lot stops + timeout). The runner lot is
   * excluded — it carries its own cost stop.
   */
  private combinedStopTripped(input: OpMinusInput): boolean {
    const scalpLots = input.shortBooks.flatMap((book) =>
      book.lots
        .filter((lot) => lot.lotId !== input.runner?.lotId)
        .map((lot) => ({ right: book.right, askPaise: book.row?.askPaise ?? 0, lot })));
    if (scalpLots.length === 0) return false;
    if (!scalpLots.some((entry) => entry.right === 'CE') || !scalpLots.some((entry) => entry.right === 'PE')) return false;
    if (scalpLots.some((entry) => entry.askPaise <= 0)) return false;
    const entryPaise = scalpLots.reduce((sum, entry) => sum + entry.lot.entryPricePaise * entry.lot.qty, 0);
    const markPaise = scalpLots.reduce((sum, entry) => sum + entry.askPaise * entry.lot.qty, 0);
    if (entryPaise <= 0) return false;
    return markPaise - entryPaise >= entryPaise * (this.params.combinedStopPremiumPct / 100);
  }

  /**
   * Range-regime gate. Returns a specific, stable code plus a measured-value
   * detail for the first check that blocks, so the runtime can journal *why*
   * the desk paused (genuine trend vs an unwarmed input vs VWAP stretch)
   * instead of one opaque line. Optional gates treat a missing warmed-up input
   * as NOT range-bound: selling premium on an unmeasured regime is the mistake,
   * not the miss.
   */
  private rangeGate(input: OpMinusInput): RangeGateResult {
    if (!this.params.rangeFilterEnabled) return { ready: true };
    const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
    const spot = input.spotPaise;
    const features = input.underlying;
    const vwap = features?.vwapPaise;
    const ret30 = features?.ret30s;
    if (spot === undefined || spot <= 0 || vwap === undefined || vwap <= 0 || ret30 === undefined) {
      return { ready: false, code: 'FEATURES_WARMUP', detail: 'underlying features not ready (spot/VWAP/ret30)' };
    }
    if (Math.abs(ret30) > this.params.maxAbsRet30Pct) {
      return { ready: false, code: 'RET30', detail: `30s move ${pct(Math.abs(ret30))} > ${pct(this.params.maxAbsRet30Pct)}` };
    }
    const stretchPaise = Math.abs(spot - vwap);
    if (this.params.maxVwapDistancePct > 0 && stretchPaise / vwap > this.params.maxVwapDistancePct) {
      return { ready: false, code: 'VWAP', detail: `VWAP stretch ${pct(stretchPaise / vwap)} > ${pct(this.params.maxVwapDistancePct)}` };
    }
    if (this.params.maxVwapDistanceAtrMult > 0) {
      const atr = features?.atr1mPaise;
      if (atr === undefined || atr <= 0) {
        return { ready: false, code: 'ATR_WARMUP', detail: 'ATR(1m,14) warming up' };
      }
      if (stretchPaise > this.params.maxVwapDistanceAtrMult * atr) {
        return {
          ready: false,
          code: 'VWAP_ATR',
          detail: `VWAP stretch ${(stretchPaise / 100).toFixed(0)}p > ${this.params.maxVwapDistanceAtrMult}x ATR(${(atr / 100).toFixed(0)}p)`,
        };
      }
    }
    if (this.params.maxAdx > 0) {
      const adx = features?.adx1m;
      if (adx === undefined) {
        return { ready: false, code: 'ADX_WARMUP', detail: 'ADX(1m,14) warming up (~29 bars)' };
      }
      if (adx > this.params.maxAdx) {
        return { ready: false, code: 'ADX', detail: `ADX ${adx.toFixed(1)} > ${this.params.maxAdx} (trending)` };
      }
    }
    if (this.params.maxStraddleRisePct > 0) {
      const drift = input.straddleDriftPct;
      if (drift === undefined) {
        return { ready: false, code: 'STRADDLE_WARMUP', detail: `straddle window warming up (${this.params.straddleTrendWindowSec}s)` };
      }
      if (drift > this.params.maxStraddleRisePct) {
        return { ready: false, code: 'STRADDLE', detail: `straddle mid +${pct(drift)} > +${pct(this.params.maxStraddleRisePct)} (IV rising)` };
      }
    }
    return { ready: true };
  }

  private forceAllShortsClosed(input: OpMinusInput): OpMinusDesiredOrder[] {
    return input.shortBooks.flatMap((book) => book.lots.map((lot) => this.urgentBuy(
      book.instrumentId,
      lot,
      book.row?.askPaise ?? 0,
      'RISK_EXIT',
    )));
  }

  private urgentBuy(
    instrumentId: InstrumentId,
    lot: OpMinusLotInput,
    askPaise: number,
    reason: 'COMBINED_TARGET' | 'HARD_STOP' | 'COMBINED_STOP' | 'PAIR_TIMEOUT' | 'UNPAIRED_TIMEOUT' |
      'SCALP_TIMEOUT' | 'RUNNER_COST_STOP' | 'RISK_EXIT',
  ): OpMinusDesiredOrder {
    return {
      instrumentId,
      side: 'BUY',
      qty: lot.qty,
      type: askPaise > 0 ? 'LIMIT' : 'MARKET_PROTECT',
      ...(askPaise > 0 ? { limitPricePaise: askPaise + this.params.defensiveProtectTicks * this.market.tickSizePaise } : {}),
      protectTicks: this.params.defensiveProtectTicks,
      purpose: 'EXIT',
      reason,
      closeLotIds: [lot.lotId],
    };
  }
}

function blocksNewEntries(reason: OpMinusReason): boolean {
  return reason !== 'TARGET';
}

function floorTick(pricePaise: number, tick: number): number {
  return Math.floor(pricePaise / tick) * tick;
}

function ceilTick(pricePaise: number, tick: number): number {
  return Math.ceil(pricePaise / tick) * tick;
}
