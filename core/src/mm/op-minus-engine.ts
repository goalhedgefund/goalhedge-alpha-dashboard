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
  runnerLots: number;
  quoteTtlSec: number;
  minRequoteMs: number;
  maxHoldSec: number;
  defensiveCooldownSec: number;
  rangeFilterEnabled: boolean;
  maxAbsRet30Pct: number;
  maxVwapDistancePct: number;
  entryImprovementTicks: number;
  defensiveProtectTicks: number;
  repriceTicks: number;
  quoteFrom: string;
  entryCutoff: string;
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
    runnerLots: Math.min(1, Math.floor(boundedParam(params, 'runnerLots', 1, 0, 1))),
    quoteTtlSec: boundedParam(params, 'quoteTtlSec', 20, 1, 86_400),
    minRequoteMs: Math.floor(boundedParam(params, 'minRequoteMs', 2_000, 0, 60_000)),
    maxHoldSec: boundedParam(params, 'maxHoldSec', 180, 1, 86_400),
    defensiveCooldownSec: boundedParam(params, 'defensiveCooldownSec', 300, 0, 86_400),
    rangeFilterEnabled: boolParam(params, 'rangeFilterEnabled', false),
    maxAbsRet30Pct: boundedParam(params, 'maxAbsRet30Pct', 0.001, 0.00001, 0.1),
    maxVwapDistancePct: boundedParam(params, 'maxVwapDistancePct', 0.0015, 0.00001, 0.1),
    entryImprovementTicks: Math.floor(boundedParam(params, 'entryImprovementTicks', 1, 0, 20)),
    defensiveProtectTicks: Math.floor(boundedParam(params, 'defensiveProtectTicks', 10, 1, 100)),
    repriceTicks: Math.floor(boundedParam(params, 'repriceTicks', 2, 0, 100)),
    quoteFrom: strParam(params, 'quoteFrom', '09:20'),
    entryCutoff: strParam(params, 'entryCutoff', '15:10'),
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
  scalpCe?: OptionChainRow;
  scalpPe?: OptionChainRow;
  spotPaise?: number;
  underlying?: UnderlyingFeatures;
  shortBooks: readonly OpMinusShortBookInput[];
  latchedStop: boolean;
  runner?: OpMinusActiveRunnerInput;
  pendingRunnerLotId?: string;
  allowRunnerCandidate?: boolean;
}

export type OpMinusReason =
  | 'SHORT_ENTRY'
  | 'TARGET'
  | 'HARD_STOP'
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
  phase: 'SCALPING' | 'EXIT_ONLY' | 'PAUSED_WINDOW' | 'PAUSED_LOCKOUT' | 'PAUSED_REGIME';
  pauseReason?: string;
  runnerCandidateLotId?: string;
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
    const desired = input.shortBooks.flatMap((book) => this.exitsForShortBook(
      book,
      input,
      this.selectRunnerCandidate(input),
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

    if (input.nowHHMM < this.params.quoteFrom) {
      return { desired, phase: 'PAUSED_WINDOW', pauseReason: `entries start ${this.params.quoteFrom}` };
    }

    if (input.nowHHMM >= this.params.entryCutoff) {
      return {
        desired,
        phase: 'EXIT_ONLY',
        pauseReason: `entry cutoff ${this.params.entryCutoff}`,
        ...(candidate !== undefined ? { runnerCandidateLotId: candidate } : {}),
      };
    }

    if (!this.rangeReady(input)) {
      return {
        desired,
        phase: 'PAUSED_REGIME',
        pauseReason: 'trend or VWAP stretch outside short-premium range',
        ...(candidate !== undefined ? { runnerCandidateLotId: candidate } : {}),
      };
    }

    return {
      desired: [...desired, ...this.missingShortEntries(input)],
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
        result.push({
          instrumentId: row.instrumentId,
          side: 'SELL',
          qty: lot,
          type: 'LIMIT',
          // Do not cross the whole spread on a naked short entry. Rest just
          // inside the ask and let the market trade through the quote.
          limitPricePaise: Math.max(
            row.bidPaise,
            row.askPaise - this.params.entryImprovementTicks * this.market.tickSizePaise,
          ),
          purpose: 'ENTRY',
          reason: 'SHORT_ENTRY',
          stopPlan: {
            hardStopPremiumPaise: this.hardStopPaise(row.bidPaise),
            timeStopSec: this.params.maxHoldSec,
            targetPaise: this.targetPaise(row.bidPaise),
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
      const stop = this.hardStopPaise(lot.entryPricePaise);
      if (ask > 0 && ask >= stop) {
        result.push(this.urgentBuy(book.instrumentId, lot, ask, 'HARD_STOP'));
        continue;
      }
      if (input.nowMs - lot.openedTs >= this.params.maxHoldSec * 1_000) {
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

  private selectRunnerCandidate(input: OpMinusInput): string | undefined {
    if (this.params.runnerLots === 0 || input.runner !== undefined || input.allowRunnerCandidate === false ||
      input.latchedStop || input.nowHHMM < this.params.quoteFrom || input.nowHHMM >= this.params.entryCutoff) return undefined;
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

  private rangeReady(input: OpMinusInput): boolean {
    if (!this.params.rangeFilterEnabled) return true;
    const spot = input.spotPaise;
    const features = input.underlying;
    const vwap = features?.vwapPaise;
    const ret30 = features?.ret30s;
    if (spot === undefined || spot <= 0 || vwap === undefined || vwap <= 0 || ret30 === undefined) return false;
    return (
      Math.abs(ret30) <= this.params.maxAbsRet30Pct &&
      Math.abs((spot - vwap) / vwap) <= this.params.maxVwapDistancePct
    );
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
    reason: 'HARD_STOP' | 'SCALP_TIMEOUT' | 'RUNNER_COST_STOP' | 'RISK_EXIT',
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

function floorTick(pricePaise: number, tick: number): number {
  return Math.floor(pricePaise / tick) * tick;
}

function ceilTick(pricePaise: number, tick: number): number {
  return Math.ceil(pricePaise / tick) * tick;
}
