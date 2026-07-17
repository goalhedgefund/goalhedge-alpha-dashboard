import { computeCharges } from '../charges/engine.js';
import type { MarketProfile } from '../config/schemas.js';
import type { InstrumentId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { OptionChainRow } from '../domain/marketdata.js';
import type { StopPlan } from '../domain/orders.js';
import { numParam, type StrategyParams } from '../strategy/types.js';

/**
 * ALL_OP quoting engine — pure decision core of the ATM option market maker
 * (design: D:\Claude\workstation\docs\ALLOP_DESIGN.md §4).
 *
 * Every evaluation returns the COMPLETE desired working-order set for this
 * instant; the MmRunner diffs it against live orders (cancel-before-replace).
 * The engine never touches the OMS, the clock, or the gate — it is driven
 * entirely by the inputs, which keeps every invariant unit-testable:
 *
 *  - long-only: sells never exceed held quantity, never appear without a book
 *  - inventory cap: held lots + desired bid lots <= maxLotsInventory
 *  - spread rule: a QUOTE_ASK is never below avgCost x (1 + minSpread),
 *    where minSpread = spreadCostMultiple x statutory round-trip on premium
 *    (SCRATCH / HARD_STOP exits are the tagged, journaled exceptions)
 *  - bids pause on: window, latched session stop, falling knife, delta skew
 */

export interface MmParams {
  spreadCostMultiple: number;
  maxLotsInventory: number;
  lotsPerOrder: number;
  ladderLevels: number;
  /** % of premium between ladder bid levels. */
  ladderGapPct: number;
  /** Re-quote tolerance in ticks (used by the runner's diff). */
  repriceTicks: number;
  /** Working-quote TTL (runner sets intent ttlMs from this). */
  quoteTtlSec: number;
  /** Theta ageing: a book older than this scratches at best bid. */
  maxHoldSec: number;
  /** Hard stop, % below avgCost (premium space). */
  hardStopPct: number;
  /** Stop bidding the heavier right when it leads by this many lots. */
  deltaSkewLots: number;
  /** Underlying % move within 5 minutes that pauses bidding. */
  knifePct: number;
  knifeCooldownMin: number;
  /** HH:MM IST window for new bids. */
  quoteFrom: string;
  bidCutoff: string;
}

function strParam(params: StrategyParams, key: string, dflt: string): string {
  const v = params[key];
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : dflt;
}

export function resolveMmParams(params: StrategyParams): MmParams {
  return {
    spreadCostMultiple: numParam(params, 'spreadCostMultiple', 3),
    maxLotsInventory: numParam(params, 'maxLotsInventory', 5),
    lotsPerOrder: numParam(params, 'lotsPerOrder', 1),
    ladderLevels: numParam(params, 'ladderLevels', 2),
    ladderGapPct: numParam(params, 'ladderGapPct', 0.4),
    repriceTicks: numParam(params, 'repriceTicks', 2),
    quoteTtlSec: numParam(params, 'quoteTtlSec', 20),
    maxHoldSec: numParam(params, 'maxHoldSec', 600),
    hardStopPct: numParam(params, 'hardStopPct', 20),
    deltaSkewLots: numParam(params, 'deltaSkewLots', 3),
    knifePct: numParam(params, 'knifePct', 0.35),
    knifeCooldownMin: numParam(params, 'knifeCooldownMin', 10),
    quoteFrom: strParam(params, 'quoteFrom', '09:20'),
    bidCutoff: strParam(params, 'bidCutoff', '15:10'),
  };
}

/** One held inventory book (a long option position), as the engine sees it. */
export interface MmBookInput {
  instrumentId: InstrumentId;
  right: OptionRight;
  /** Held units (multiple of lot size); books with qty 0 are ignored. */
  qty: number;
  avgEntryPricePaise: number;
  openedTs: number;
  /** Latest chain row for this instrument (may be an off-ATM strike). */
  row?: OptionChainRow;
}

export interface MmQuoteInput {
  nowMs: number;
  /** HH:MM IST. */
  nowHHMM: string;
  spotPaise?: number;
  /** Current ATM rows (re-centred by the feed as spot moves). */
  atmCe?: OptionChainRow;
  atmPe?: OptionChainRow;
  books: readonly MmBookInput[];
  /** Session risk latch (day loss / give-back): pauses bids, never asks. */
  latchedStop: boolean;
}

export type MmDesiredReason = 'QUOTE_BID' | 'QUOTE_ASK' | 'SCRATCH' | 'HARD_STOP';

export interface MmDesiredOrder {
  instrumentId: InstrumentId;
  side: 'BUY' | 'SELL';
  qty: number;
  limitPricePaise: number;
  purpose: 'ENTRY' | 'EXIT';
  reason: MmDesiredReason;
  /** Present on every ENTRY (the Risk Gate demands a complete risk definition). */
  stopPlan?: StopPlan;
}

export type MmQuotePhase = 'QUOTING' | 'ASK_ONLY' | 'PAUSED_WINDOW' | 'PAUSED_KNIFE' | 'PAUSED_LOCKOUT';

export interface MmEvaluation {
  desired: MmDesiredOrder[];
  phase: MmQuotePhase;
  pauseReason?: string;
  /** Representative min spread (at ATM CE mid), % of premium, for the UI. */
  minSpreadPct?: number;
}

const KNIFE_WINDOW_MS = 5 * 60_000;

interface SpotPoint {
  ts: number;
  spotPaise: number;
}

export class QuotingEngine {
  private params: MmParams;
  private spotHistory: SpotPoint[] = [];
  private knifeUntilMs = 0;

  constructor(
    private readonly market: MarketProfile,
    params: StrategyParams,
  ) {
    this.params = resolveMmParams(params);
  }

  setParams(params: StrategyParams): void {
    this.params = resolveMmParams(params);
  }

  activeParams(): MmParams {
    return { ...this.params };
  }

  /** Statutory buy+sell charges at one price, as % of one-side notional. */
  roundTripCostPct(pricePaise: number): number {
    const qty = this.market.contract.lotSize;
    const charges = computeCharges(
      [
        { side: 'BUY', qty, pricePaise },
        { side: 'SELL', qty, pricePaise },
      ],
      this.market,
    );
    return (charges.totalPaise / (pricePaise * qty)) * 100;
  }

  /** The operator's rule: quoted spread = spreadCostMultiple x round-trip cost. */
  minSpreadPct(pricePaise: number): number {
    return this.params.spreadCostMultiple * this.roundTripCostPct(pricePaise);
  }

  evaluate(input: MmQuoteInput): MmEvaluation {
    this.trackKnife(input);
    const p = this.params;
    const tick = this.market.tickSizePaise;
    const lotSize = this.market.contract.lotSize;
    const desired: MmDesiredOrder[] = [];

    // ---- asks first: they reduce risk and are never paused ----
    for (const book of input.books) {
      if (book.qty <= 0) continue;
      const ask = this.askFor(book, input.nowMs, tick);
      if (ask !== undefined) desired.push(ask);
    }

    // ---- bid gating (first pause wins) ----
    const pause = this.bidPause(input);
    if (pause !== undefined) {
      const rep = this.representativeSpread(input);
      return {
        desired,
        phase: pause.phase,
        pauseReason: pause.reason,
        ...(rep !== undefined ? { minSpreadPct: rep } : {}),
      };
    }

    // ---- bids: ladder on both ATM rights, capped, skew-aware ----
    const heldLots = input.books.reduce((s, b) => s + Math.max(0, b.qty), 0) / lotSize;
    let remainingLots = Math.floor(p.maxLotsInventory - heldLots);
    const ceLots = this.heldLots(input.books, 'CE', lotSize);
    const peLots = this.heldLots(input.books, 'PE', lotSize);
    const skip: Record<OptionRight, boolean> = {
      CE: ceLots - peLots >= p.deltaSkewLots,
      PE: peLots - ceLots >= p.deltaSkewLots,
    };

    const rights: Array<{ right: OptionRight; row?: OptionChainRow }> = [
      { right: 'CE', ...(input.atmCe !== undefined ? { row: input.atmCe } : {}) },
      { right: 'PE', ...(input.atmPe !== undefined ? { row: input.atmPe } : {}) },
    ];

    // Interleave levels (CE L1, PE L1, CE L2, ...) so a tight cap is shared.
    for (let level = 0; level < p.ladderLevels; level++) {
      for (const { right, row } of rights) {
        if (remainingLots < p.lotsPerOrder) break;
        if (skip[right] || row === undefined) continue;
        if (row.bidPaise <= 0 || row.askPaise <= 0) continue; // one-sided book: never bid into vanished liquidity
        const mid = (row.bidPaise + row.askPaise) / 2;
        const ms = this.minSpreadPct(mid);
        const l1 = mid * (1 - ms / 200); // half the quoted spread below mid
        const price = floorTick(l1 * (1 - (p.ladderGapPct / 100) * level), tick);
        if (price < 2 * tick) continue; // too cheap to carry a valid stop below entry
        const hardStop = Math.min(price - tick, floorTick(price * (1 - p.hardStopPct / 100), tick));
        if (hardStop <= 0) continue;
        desired.push({
          instrumentId: row.instrumentId,
          side: 'BUY',
          qty: p.lotsPerOrder * lotSize,
          limitPricePaise: price,
          purpose: 'ENTRY',
          reason: 'QUOTE_BID',
          stopPlan: { hardStopPremiumPaise: hardStop, timeStopSec: p.maxHoldSec },
        });
        remainingLots -= p.lotsPerOrder;
      }
    }

    const rep = this.representativeSpread(input);
    return { desired, phase: 'QUOTING', ...(rep !== undefined ? { minSpreadPct: rep } : {}) };
  }

  // ------------------------------------------------------------------ internals

  private askFor(book: MmBookInput, nowMs: number, tick: number): MmDesiredOrder | undefined {
    const p = this.params;
    const row = book.row;
    if (row === undefined) return undefined;
    const mark =
      row.bidPaise > 0 && row.askPaise > 0 ? (row.bidPaise + row.askPaise) / 2 : row.ltpPaise > 0 ? row.ltpPaise : 0;

    // L1 hard stop — the book is bleeding; exit at best bid, tagged.
    if (mark > 0 && row.bidPaise > 0 && mark <= book.avgEntryPricePaise * (1 - p.hardStopPct / 100)) {
      return sell(book, row.bidPaise, 'HARD_STOP');
    }
    // Theta ageing — waiting is not free in premium space; scratch at best bid.
    if (row.bidPaise > 0 && nowMs - book.openedTs > p.maxHoldSec * 1_000) {
      return sell(book, row.bidPaise, 'SCRATCH');
    }
    // Normal inventory work: never below cost + the operator's 3x-cost spread.
    const ms = this.minSpreadPct(book.avgEntryPricePaise);
    const floor = book.avgEntryPricePaise * (1 + ms / 100);
    const price = ceilTick(Math.max(floor, mark), tick);
    if (price <= 0) return undefined;
    return sell(book, price, 'QUOTE_ASK');
  }

  private bidPause(input: MmQuoteInput): { phase: MmQuotePhase; reason: string } | undefined {
    const p = this.params;
    if (input.latchedStop) return { phase: 'PAUSED_LOCKOUT', reason: 'session stop latched' };
    if (input.nowHHMM < p.quoteFrom) return { phase: 'PAUSED_WINDOW', reason: `bids start ${p.quoteFrom}` };
    if (input.nowHHMM >= p.bidCutoff) return { phase: 'ASK_ONLY', reason: `bid cutoff ${p.bidCutoff}` };
    if (input.nowMs < this.knifeUntilMs) {
      return { phase: 'PAUSED_KNIFE', reason: `falling knife; bids resume ${new Date(this.knifeUntilMs).toISOString()}` };
    }
    return undefined;
  }

  private trackKnife(input: MmQuoteInput): void {
    const spot = input.spotPaise;
    if (spot === undefined || spot <= 0) return;
    this.spotHistory.push({ ts: input.nowMs, spotPaise: spot });
    const cutoff = input.nowMs - KNIFE_WINDOW_MS;
    while (this.spotHistory.length > 0 && (this.spotHistory[0] as SpotPoint).ts < cutoff) {
      this.spotHistory.shift();
    }
    const oldest = this.spotHistory[0];
    if (oldest === undefined || oldest.spotPaise <= 0) return;
    const movePct = (Math.abs(spot - oldest.spotPaise) / oldest.spotPaise) * 100;
    if (movePct >= this.params.knifePct) {
      this.knifeUntilMs = input.nowMs + this.params.knifeCooldownMin * 60_000;
    }
  }

  private heldLots(books: readonly MmBookInput[], right: OptionRight, lotSize: number): number {
    return books.filter((b) => b.right === right).reduce((s, b) => s + Math.max(0, b.qty), 0) / lotSize;
  }

  private representativeSpread(input: MmQuoteInput): number | undefined {
    const row = input.atmCe ?? input.atmPe;
    if (row === undefined || row.bidPaise <= 0 || row.askPaise <= 0) return undefined;
    return this.minSpreadPct((row.bidPaise + row.askPaise) / 2);
  }
}

function sell(book: MmBookInput, pricePaise: number, reason: MmDesiredReason): MmDesiredOrder {
  return {
    instrumentId: book.instrumentId,
    side: 'SELL',
    qty: book.qty,
    limitPricePaise: pricePaise,
    purpose: 'EXIT',
    reason,
  };
}

function floorTick(pricePaise: number, tick: number): number {
  return Math.floor(pricePaise / tick) * tick;
}

function ceilTick(pricePaise: number, tick: number): number {
  return Math.ceil(pricePaise / tick) * tick;
}
