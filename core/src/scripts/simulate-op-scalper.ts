/**
 * OP-Scalper feasibility simulator.
 *
 * Replays recorded NIFTY option ticks through the proposed inventory-anchored
 * two-sided scalper WITHOUT the OMS / risk / escalation stack, so the design can
 * be measured before it is built. Charges come from the production charge
 * engine, so cost numbers are the real ones.
 *
 * The machine under test, per right (CE and PE run independently):
 *
 *   FLAT ──buy──▶ LONG(anchor)  ──sell @ anchor+target──▶ FLAT   (+costMult x cost)
 *                    │
 *                    └─ price falls flipTicks away ──▶ COVERED (anchor + short, net 0)
 *                                                        └─ buy @ short-target ──▶ LONG
 *
 * The anchor is never sold at a loss; the desk scalps around it until the anchor
 * target fills. Rule 5 (underlying moves switchPct) squares everything off and
 * re-centres the ATM strike.
 *
 * The TRADED UNIT is either a naked ATM option (--anchor naked) or an ATM/OTM
 * debit vertical (--anchor vertical --wing N), which caps the anchor's loss at
 * the debit by construction instead of with a stop. Both are priced and charged
 * leg by leg, so the vertical correctly pays charges on the SUM of the leg
 * premia while targeting the much smaller spread value.
 *
 * Usage:
 *   node dist/scripts/simulate-op-scalper.js [--days 30] [--end YYYY-MM-DD]
 *     [--cost-mult 3] [--sweep] [--entry passive|cross]
 *     [--anchor naked|vertical] [--wing 2]
 *     [--anchor-stop-ticks N] [--anchor-time-stop-sec N]
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { computeCharges } from '../charges/engine.js';
import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, type MarketProfile } from '../config/schemas.js';
import type { InstrumentId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { Side } from '../domain/orders.js';
import type { Tick } from '../domain/marketdata.js';
import { istDayStartMs } from '../domain/time.js';
import {
  discoverPlainRecording,
  listTickParts,
  loadTicksForDate,
  resolveScripMasterPath,
} from './backtest-recording.js';

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_DIR = join(SCALPER_ROOT, 'config');
const CORPUS_ROOTS = [
  join(SCALPER_ROOT, 'data', 'dhan', 'ticks-op-minus-atm-short'),
  join(SCALPER_ROOT, 'data', 'dhan', 'ticks-allop-atm-mm'),
  join(SCALPER_ROOT, 'data', 'dhan', 'ticks-s1-momentum-burst'),
  join(SCALPER_ROOT, 'data', 'dhan', 'ticks-s2-vwap-fade'),
  join(SCALPER_ROOT, 'data', 'dhan', 'ticks'),
];
const IST_OFFSET_MS = 330 * 60_000;

// ── knobs ────────────────────────────────────────────────────────────────────

interface SimConfig {
  /** Net profit target as a multiple of round-trip cost (rule 3). */
  costMult: number;
  /** Ticks the unit bid must fall below the anchor before flipping to sell-first. */
  flipTicks: number;
  /** Underlying move that forces square-off + ATM re-centre (rule 5), fraction. */
  switchPct: number;
  /** Trading days to expiry below which the desk does not trade (rule 1). */
  minTradingDte: number;
  /** Naked ATM option, or ATM/OTM debit vertical (loss capped at the debit). */
  anchorMode: 'naked' | 'vertical';
  /** Strikes out for the vertical's short wing. */
  wing: number;
  /**
   * Standing hedge bought once at session start and held: long 1 OTM CE and
   * long 1 OTM PE (a strangle). Unlike the vertical's short wing this is a
   * separate position that GAINS on the large directional moves which produce
   * the covered-scalp machine's forced unwinds.
   */
  hedgeMode: 'none' | 'strangle';
  hedgeWing: number;
  entry: 'passive' | 'cross';
  entryImproveTicks: number;
  /** 0 disables: hard stop on the anchor, in ticks against. */
  anchorStopTicks: number;
  /** 0 disables: cut the anchor after this long unresolved. */
  anchorTimeStopSec: number;
  /** 0 disables: cut a covered short this far against. */
  coveredStopTicks: number;
  quoteFrom: string;
  entryCutoff: string;
  squareOff: string;
  /** Skip quoting when the unit spread is wider than this fraction of mid. */
  maxSpreadPct: number;
  lots: number;
}

// ── the traded unit ──────────────────────────────────────────────────────────

interface LegFill {
  side: Side;
  pricePaise: number;
}

/**
 * A tradeable unit (one option, or one vertical) as a two-sided quote.
 * `legsToBuy` / `legsToSell` are what actually hits the exchange, and are what
 * statutory charges are computed on — for a vertical that is BOTH legs, so
 * turnover is the sum of the premia even though the unit's value is the
 * difference. That asymmetry is the whole point of measuring this.
 */
interface UnitQuote {
  bidPaise: number;
  askPaise: number;
  legsToBuy: LegFill[];
  legsToSell: LegFill[];
}

function nakedUnit(b: { bidPaise: number; askPaise: number }): UnitQuote {
  return {
    bidPaise: b.bidPaise,
    askPaise: b.askPaise,
    legsToBuy: [{ side: 'BUY', pricePaise: b.askPaise }],
    legsToSell: [{ side: 'SELL', pricePaise: b.bidPaise }],
  };
}

/** Long the near leg, short the wing: buy at nearAsk - wingBid, sell at nearBid - wingAsk. */
function verticalUnit(
  near: { bidPaise: number; askPaise: number },
  wing: { bidPaise: number; askPaise: number },
): UnitQuote {
  return {
    bidPaise: near.bidPaise - wing.askPaise,
    askPaise: near.askPaise - wing.bidPaise,
    legsToBuy: [
      { side: 'BUY', pricePaise: near.askPaise },
      { side: 'SELL', pricePaise: wing.bidPaise },
    ],
    legsToSell: [
      { side: 'SELL', pricePaise: near.bidPaise },
      { side: 'BUY', pricePaise: wing.askPaise },
    ],
  };
}

// ── per-episode bookkeeping ──────────────────────────────────────────────────

type AnchorOutcome = 'TARGET' | 'STOP' | 'TIME' | 'SWITCH' | 'EOD';

interface AnchorEpisode {
  date: string;
  right: OptionRight;
  entryPaise: number;
  targetIncPaise: number;
  mfePaise: number;
  maePaise: number;
  outcome: AnchorOutcome;
  durationMs: number;
  coveredScalps: number;
}

type TradeKind =
  | 'ANCHOR_TARGET'
  | 'COVERED_SCALP'
  /** Covered short unwound by force (switch / EOD / stop) rather than at its target. */
  | 'COVERED_FORCED'
  | 'ANCHOR_STOP'
  | 'ANCHOR_TIME'
  | 'SWITCH'
  | 'EOD'
  /** Standing long OTM wing held as a hedge, not scalped. */
  | 'HEDGE';

interface SimTrade {
  date: string;
  right: OptionRight;
  kind: TradeKind;
  qty: number;
  entryPaise: number;
  exitPaise: number;
  grossPaise: number;
  chargesPaise: number;
  netPaise: number;
  holdMs: number;
}

interface DayResult {
  date: string;
  expiry: string;
  tradingDte: number;
  ticks: number;
  trades: SimTrade[];
  episodes: AnchorEpisode[];
  switches: number;
  /** Median entry debit of the traded unit — what a vertical would cap loss at. */
  medianEntryPaise: number;
  skipped?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function istDate(nowMs = Date.now()): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addCalendarDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function listLookbackDays(endDate: string, days: number): string[] {
  const out: string[] = [];
  for (let i = Math.max(1, days) - 1; i >= 0; i -= 1) out.push(addCalendarDays(endDate, -i));
  return out;
}

/**
 * Trading days strictly between `from` and `to` (rule 1 counts trading days,
 * not calendar days). Weekends only — NSE has no holiday calendar in this repo,
 * so a mid-week holiday overstates DTE by one. Flagged in the report.
 */
function tradingDaysBetween(from: string, to: string): number {
  let count = 0;
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function hhmmToMs(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return ((h ?? 0) * 60 + (m ?? 0)) * 60_000;
}

function statIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pickSourceDay(date: string): string | undefined {
  for (const root of CORPUS_ROOTS) {
    const dir = join(root, date);
    if (statIsDir(dir) && listTickParts(dir).length > 0) return dir;
  }
  return undefined;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx] ?? 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return percentile([...values].sort((a, b) => a - b), 50);
}

function inr(paise: number): string {
  return `${paise < 0 ? '-' : ''}₹${Math.abs(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function chargesFor(market: MarketProfile, qty: number, legs: readonly LegFill[]): number {
  return computeCharges(
    legs.map((leg, i) => ({ side: leg.side, qty, pricePaise: leg.pricePaise, orderId: `l${i}` })),
    market,
  ).totalPaise;
}

/**
 * Per-unit move needed so that net profit = costMult x round-trip cost.
 * Rounded up to a tick — you cannot quote between ticks.
 */
function targetIncrementPaise(
  market: MarketProfile,
  qty: number,
  roundTripCostPaise: number,
  costMult: number,
): number {
  const perUnit = ((costMult + 1) * roundTripCostPaise) / qty;
  const tick = market.tickSizePaise;
  return Math.max(tick, Math.ceil(perUnit / tick) * tick);
}

/** Round-trip cost of entering and exiting `q` once, at the current book. */
function roundTripCost(market: MarketProfile, qty: number, q: UnitQuote): number {
  return chargesFor(market, qty, [...q.legsToBuy, ...q.legsToSell]);
}

// ── the machine ──────────────────────────────────────────────────────────────

type Phase = 'FLAT' | 'LONG' | 'COVERED';

/** One right's inventory-anchored scalper over an abstract traded unit. */
class RightScalper {
  phase: Phase = 'FLAT';
  anchorPaise = 0;
  anchorTs = 0;
  anchorTargetInc = 0;
  anchorMfe = 0;
  anchorMae = 0;
  anchorScalps = 0;
  private anchorLegs: LegFill[] = [];
  shortPaise = 0;
  shortTs = 0;
  shortTargetInc = 0;
  private shortLegs: LegFill[] = [];
  /** Working passive entry limit; repriced as the book moves, like a real quote. */
  private restingEntry: number | undefined;
  readonly entryPrices: number[] = [];

  constructor(
    readonly right: OptionRight,
    private readonly cfg: SimConfig,
    private readonly market: MarketProfile,
    private readonly qty: number,
    private readonly onTrade: (t: Omit<SimTrade, 'date' | 'right'>) => void,
    private readonly onEpisode: (e: Omit<AnchorEpisode, 'date' | 'right'>) => void,
  ) {}

  private quotable(q: UnitQuote): boolean {
    if (q.askPaise <= 0 || q.askPaise <= q.bidPaise) return false;
    // A vertical's bid can legitimately be <= 0; only the ask must be positive.
    if (this.cfg.anchorMode === 'naked' && q.bidPaise <= 0) return false;
    const mid = (q.bidPaise + q.askPaise) / 2;
    if (mid <= 0) return false;
    return (q.askPaise - q.bidPaise) / mid <= this.cfg.maxSpreadPct;
  }

  /** Long round trip: bought via `entryLegs`, sold via `exitLegs`. */
  private record(
    kind: TradeKind,
    entryPaise: number,
    exitPaise: number,
    entryLegs: readonly LegFill[],
    exitLegs: readonly LegFill[],
    holdMs: number,
  ): void {
    const gross = (exitPaise - entryPaise) * this.qty;
    const charges = chargesFor(this.market, this.qty, [...entryLegs, ...exitLegs]);
    this.onTrade({
      kind,
      qty: this.qty,
      entryPaise,
      exitPaise,
      grossPaise: gross,
      chargesPaise: charges,
      netPaise: gross - charges,
      holdMs,
    });
  }

  /** Short scalp: sold the unit first, bought it back. */
  private recordShort(
    entryPaise: number,
    exitPaise: number,
    entryLegs: readonly LegFill[],
    exitLegs: readonly LegFill[],
    holdMs: number,
    kind: TradeKind = 'COVERED_SCALP',
  ): void {
    const gross = (entryPaise - exitPaise) * this.qty;
    const charges = chargesFor(this.market, this.qty, [...entryLegs, ...exitLegs]);
    this.onTrade({
      kind,
      qty: this.qty,
      entryPaise,
      exitPaise,
      grossPaise: gross,
      chargesPaise: charges,
      netPaise: gross - charges,
      holdMs,
    });
  }

  private closeEpisode(outcome: AnchorOutcome, nowMs: number): void {
    this.onEpisode({
      entryPaise: this.anchorPaise,
      targetIncPaise: this.anchorTargetInc,
      mfePaise: this.anchorMfe,
      maePaise: this.anchorMae,
      outcome,
      durationMs: nowMs - this.anchorTs,
      coveredScalps: this.anchorScalps,
    });
  }

  step(q: UnitQuote, nowMs: number, entriesOpen: boolean): void {
    if (!this.quotable(q)) return;
    const tick = this.market.tickSizePaise;

    if (this.phase === 'FLAT') {
      if (!entriesOpen) {
        this.restingEntry = undefined;
        return;
      }
      if (this.cfg.entry === 'cross') {
        this.openAnchor(q.askPaise, q, nowMs);
        return;
      }
      // A resting buy only fills when a seller crosses down onto it. Checking
      // the fill BEFORE repricing is what makes the adverse selection real:
      // we get filled on the way down, never at the moment we quote.
      if (this.restingEntry !== undefined && q.askPaise <= this.restingEntry) {
        this.openAnchor(this.restingEntry, q, nowMs);
        return;
      }
      const limit = q.bidPaise + this.cfg.entryImproveTicks * tick;
      this.restingEntry = limit < q.askPaise ? limit : q.askPaise - tick;
      return;
    }

    if (this.phase === 'LONG') {
      this.restingEntry = undefined;
      this.anchorMfe = Math.max(this.anchorMfe, q.bidPaise - this.anchorPaise);
      this.anchorMae = Math.min(this.anchorMae, q.bidPaise - this.anchorPaise);

      const target = this.anchorPaise + this.anchorTargetInc;
      if (q.bidPaise >= target) {
        this.record('ANCHOR_TARGET', this.anchorPaise, target, this.anchorLegs, q.legsToSell, nowMs - this.anchorTs);
        this.closeEpisode('TARGET', nowMs);
        this.phase = 'FLAT';
        return;
      }
      if (this.cfg.anchorStopTicks > 0 && q.bidPaise <= this.anchorPaise - this.cfg.anchorStopTicks * tick) {
        this.record('ANCHOR_STOP', this.anchorPaise, q.bidPaise, this.anchorLegs, q.legsToSell, nowMs - this.anchorTs);
        this.closeEpisode('STOP', nowMs);
        this.phase = 'FLAT';
        return;
      }
      if (this.cfg.anchorTimeStopSec > 0 && nowMs - this.anchorTs >= this.cfg.anchorTimeStopSec * 1_000) {
        this.record('ANCHOR_TIME', this.anchorPaise, q.bidPaise, this.anchorLegs, q.legsToSell, nowMs - this.anchorTs);
        this.closeEpisode('TIME', nowMs);
        this.phase = 'FLAT';
        return;
      }
      // Rule 7: the unit has walked away from the anchor — flip to sell-first,
      // covered by the inventory we already hold (never net short).
      if (q.bidPaise <= this.anchorPaise - this.cfg.flipTicks * tick && entriesOpen) {
        this.shortPaise = q.bidPaise;
        this.shortLegs = q.legsToSell;
        this.shortTs = nowMs;
        this.shortTargetInc = targetIncrementPaise(
          this.market,
          this.qty,
          roundTripCost(this.market, this.qty, q),
          this.cfg.costMult,
        );
        this.phase = 'COVERED';
      }
      return;
    }

    // COVERED: anchor long + scalp short = net 0. Buy the short back lower.
    this.anchorMfe = Math.max(this.anchorMfe, q.bidPaise - this.anchorPaise);
    this.anchorMae = Math.min(this.anchorMae, q.bidPaise - this.anchorPaise);

    const buyBack = this.shortPaise - this.shortTargetInc;
    if (q.askPaise <= buyBack) {
      this.recordShort(this.shortPaise, buyBack, this.shortLegs, q.legsToBuy, nowMs - this.shortTs);
      this.anchorScalps++;
      this.phase = 'LONG';
      return;
    }
    if (this.cfg.coveredStopTicks > 0 && q.askPaise >= this.shortPaise + this.cfg.coveredStopTicks * tick) {
      this.recordShort(this.shortPaise, q.askPaise, this.shortLegs, q.legsToBuy, nowMs - this.shortTs, 'COVERED_FORCED');
      this.anchorScalps++;
      this.phase = 'LONG';
    }
  }

  private openAnchor(pricePaise: number, q: UnitQuote, nowMs: number): void {
    this.restingEntry = undefined;
    this.anchorPaise = pricePaise;
    this.anchorLegs = q.legsToBuy;
    this.anchorTs = nowMs;
    this.anchorTargetInc = targetIncrementPaise(
      this.market,
      this.qty,
      roundTripCost(this.market, this.qty, q),
      this.cfg.costMult,
    );
    this.anchorMfe = 0;
    this.anchorMae = 0;
    this.anchorScalps = 0;
    this.entryPrices.push(pricePaise);
    this.phase = 'LONG';
  }

  /** Force flat at the current book (rule 5 switch, or end of day). */
  flatten(q: UnitQuote, nowMs: number, kind: 'SWITCH' | 'EOD'): void {
    if (this.phase === 'COVERED') {
      this.recordShort(this.shortPaise, q.askPaise, this.shortLegs, q.legsToBuy, nowMs - this.shortTs, 'COVERED_FORCED');
      this.anchorScalps++;
      this.phase = 'LONG';
    }
    if (this.phase === 'LONG') {
      this.record(kind, this.anchorPaise, q.bidPaise, this.anchorLegs, q.legsToSell, nowMs - this.anchorTs);
      this.closeEpisode(kind, nowMs);
      this.phase = 'FLAT';
    }
  }
}

/**
 * Long OTM strangle held as a standing hedge: bought once when the desk opens,
 * squared off on a rule-5 switch (and re-established at the new strike) and at
 * end of day. It is never scalped — its whole job is to be long the tails that
 * the ATM covered-scalp machine is short.
 */
class StrangleHedge {
  private legs: { id: InstrumentId; right: OptionRight; entryPaise: number }[] = [];
  private entryTs = 0;
  active = false;

  constructor(
    private readonly market: MarketProfile,
    private readonly qty: number,
    private readonly onTrade: (right: OptionRight, t: Omit<SimTrade, 'date' | 'right'>) => void,
  ) {}

  establish(
    books: ReadonlyMap<InstrumentId, { bidPaise: number; askPaise: number }>,
    ceId: InstrumentId | undefined,
    peId: InstrumentId | undefined,
    nowMs: number,
  ): void {
    if (this.active || ceId === undefined || peId === undefined) return;
    const ce = books.get(ceId);
    const pe = books.get(peId);
    if (ce === undefined || pe === undefined || ce.askPaise <= 0 || pe.askPaise <= 0) return;
    // Pay the offer on both wings — a hedge you want on gets taken, not rested.
    this.legs = [
      { id: ceId, right: 'CE', entryPaise: ce.askPaise },
      { id: peId, right: 'PE', entryPaise: pe.askPaise },
    ];
    this.entryTs = nowMs;
    this.active = true;
  }

  unwind(
    books: ReadonlyMap<InstrumentId, { bidPaise: number; askPaise: number }>,
    nowMs: number,
  ): void {
    if (!this.active) return;
    for (const leg of this.legs) {
      const exit = books.get(leg.id)?.bidPaise ?? 0;
      const gross = (exit - leg.entryPaise) * this.qty;
      const charges = chargesFor(this.market, this.qty, [
        { side: 'BUY', pricePaise: leg.entryPaise },
        { side: 'SELL', pricePaise: Math.max(0, exit) },
      ]);
      this.onTrade(leg.right, {
        kind: 'HEDGE',
        qty: this.qty,
        entryPaise: leg.entryPaise,
        exitPaise: exit,
        grossPaise: gross,
        chargesPaise: charges,
        netPaise: gross - charges,
        holdMs: nowMs - this.entryTs,
      });
    }
    this.active = false;
    this.legs = [];
  }
}

// ── one day ──────────────────────────────────────────────────────────────────

async function simulateDay(date: string, dir: string, market: MarketProfile, cfg: SimConfig): Promise<DayResult> {
  const ticks = await loadTicksForDate(dir);
  if (ticks.length === 0) return emptyDay(date, 'no ticks');

  const recording = discoverPlainRecording(ticks, resolveScripMasterPath(date));
  const dayStart = istDayStartMs(date);
  const inSession = recording.feedTicks.filter((t) => t.ts >= dayStart && t.ts < dayStart + 86_400_000);
  if (inSession.length === 0) return emptyDay(date, 'no in-session ticks');

  // Rule 1: nearest expiry with at least minTradingDte trading days left.
  const expiries = [...new Set(recording.optionSpecs.map((s) => s.expiry))].sort();
  const expiry = expiries.find((e) => tradingDaysBetween(date, e) >= cfg.minTradingDte);
  if (expiry === undefined) {
    return emptyDay(date, `no expiry with DTE>=${cfg.minTradingDte} (have ${expiries.join(',') || 'none'})`);
  }
  const tradingDte = tradingDaysBetween(date, expiry);

  const specs = recording.optionSpecs.filter((s) => s.expiry === expiry);
  const idByStrikeRight = new Map<string, InstrumentId>();
  const specById = new Map<InstrumentId, { strikePaise: number; right: OptionRight }>();
  for (const s of specs) {
    idByStrikeRight.set(`${s.strikePaise}:${s.right}`, s.instrumentId);
    specById.set(s.instrumentId, { strikePaise: s.strikePaise, right: s.right });
  }

  const step = market.contract.strikeStepPaise;
  const qty = market.contract.lotSize * cfg.lots;
  const trades: SimTrade[] = [];
  const episodes: AnchorEpisode[] = [];
  const books = new Map<InstrumentId, { bidPaise: number; askPaise: number }>();

  let spotPaise = 0;
  let atmStrike = 0;
  let strikeAnchorSpot = 0;
  let switches = 0;

  const push = (right: OptionRight) => (t: Omit<SimTrade, 'date' | 'right'>) => trades.push({ date, right, ...t });
  const pushEp = (right: OptionRight) => (e: Omit<AnchorEpisode, 'date' | 'right'>) => episodes.push({ date, right, ...e });
  const make = (right: OptionRight): RightScalper =>
    new RightScalper(right, cfg, market, qty, push(right), pushEp(right));
  let legs: Record<OptionRight, RightScalper> = { CE: make('CE'), PE: make('PE') };
  const entryPrices: number[] = [];

  /** Wing strike for the vertical: OTM for the right being traded. */
  const wingStrike = (right: OptionRight): number =>
    right === 'CE' ? atmStrike + cfg.wing * step : atmStrike - cfg.wing * step;

  /** Current tradeable unit for a right, or undefined when a leg is missing. */
  const unitFor = (right: OptionRight): UnitQuote | undefined => {
    const nearId = idByStrikeRight.get(`${atmStrike}:${right}`);
    const near = nearId === undefined ? undefined : books.get(nearId);
    if (near === undefined) return undefined;
    if (cfg.anchorMode === 'naked') return nakedUnit(near);
    const wingId = idByStrikeRight.get(`${wingStrike(right)}:${right}`);
    const wing = wingId === undefined ? undefined : books.get(wingId);
    if (wing === undefined) return undefined;
    return verticalUnit(near, wing);
  };

  const fromMs = hhmmToMs(cfg.quoteFrom);
  const cutoffMs = hhmmToMs(cfg.entryCutoff);
  const squareMs = hhmmToMs(cfg.squareOff);

  const hedge = new StrangleHedge(market, qty, (right, t) => trades.push({ date, right, ...t }));
  /** Long wings sit `hedgeWing` strikes OTM on each side of the current ATM. */
  const hedgeIds = (): { ce: InstrumentId | undefined; pe: InstrumentId | undefined } => ({
    ce: idByStrikeRight.get(`${atmStrike + cfg.hedgeWing * step}:CE`),
    pe: idByStrikeRight.get(`${atmStrike - cfg.hedgeWing * step}:PE`),
  });

  const flattenAll = (nowMs: number, kind: 'SWITCH' | 'EOD'): void => {
    for (const right of ['CE', 'PE'] as const) {
      const u = unitFor(right);
      if (u !== undefined) legs[right].flatten(u, nowMs, kind);
    }
    if (cfg.hedgeMode === 'strangle') hedge.unwind(books, nowMs);
  };

  for (const t of inSession) {
    const intoDay = t.ts - dayStart;

    if (t.instrumentId === recording.spotInstrumentId) {
      spotPaise = t.ltpPaise;
      if (atmStrike === 0 && spotPaise > 0) {
        atmStrike = Math.round(spotPaise / step) * step;
        strikeAnchorSpot = spotPaise;
      }
      // Rule 5: underlying has moved — square off and re-centre the strike.
      if (
        strikeAnchorSpot > 0 &&
        Math.abs(spotPaise - strikeAnchorSpot) / strikeAnchorSpot > cfg.switchPct &&
        intoDay < squareMs
      ) {
        flattenAll(t.ts, 'SWITCH');
        for (const l of [legs.CE, legs.PE]) entryPrices.push(...l.entryPrices);
        atmStrike = Math.round(spotPaise / step) * step;
        strikeAnchorSpot = spotPaise;
        legs = { CE: make('CE'), PE: make('PE') };
        switches++;
      }
      continue;
    }

    if (t.bidPaise > 0 && t.askPaise > 0) {
      books.set(t.instrumentId, { bidPaise: t.bidPaise, askPaise: t.askPaise });
    }
    if (atmStrike === 0 || intoDay >= squareMs) {
      if (intoDay >= squareMs) break;
      continue;
    }

    const entriesOpen = intoDay >= fromMs && intoDay < cutoffMs;
    // "Hedge at the start itself": put the wings on as soon as the desk opens,
    // and again at the new strike after a switch squared them off.
    if (cfg.hedgeMode === 'strangle' && entriesOpen) {
      const h = hedgeIds();
      hedge.establish(books, h.ce, h.pe, t.ts);
    }

    // Only step the right whose book just moved — either its near or wing leg.
    const spec = specById.get(t.instrumentId);
    if (spec === undefined) continue;
    const relevant =
      spec.strikePaise === atmStrike ||
      (cfg.anchorMode === 'vertical' && spec.strikePaise === wingStrike(spec.right));
    if (!relevant) continue;

    const unit = unitFor(spec.right);
    if (unit === undefined) continue;
    legs[spec.right].step(unit, t.ts, entriesOpen);
  }

  flattenAll(dayStart + squareMs, 'EOD');
  for (const l of [legs.CE, legs.PE]) entryPrices.push(...l.entryPrices);

  return {
    date,
    expiry,
    tradingDte,
    ticks: inSession.length,
    trades,
    episodes,
    switches,
    medianEntryPaise: median(entryPrices),
  };
}

function emptyDay(date: string, why: string): DayResult {
  return {
    date,
    expiry: '',
    tradingDte: 0,
    ticks: 0,
    trades: [],
    episodes: [],
    switches: 0,
    medianEntryPaise: 0,
    skipped: why,
  };
}

// ── reporting ────────────────────────────────────────────────────────────────

interface Totals {
  trades: number;
  wins: number;
  gross: number;
  charges: number;
  net: number;
}

function totalsOf(trades: readonly SimTrade[]): Totals {
  return {
    trades: trades.length,
    wins: trades.filter((t) => t.netPaise > 0).length,
    gross: trades.reduce((s, t) => s + t.grossPaise, 0),
    charges: trades.reduce((s, t) => s + t.chargesPaise, 0),
    net: trades.reduce((s, t) => s + t.netPaise, 0),
  };
}

function renderRun(days: readonly DayResult[], cfg: SimConfig): string {
  const all = days.flatMap((d) => d.trades);
  const eps = days.flatMap((d) => d.episodes);
  const t = totalsOf(all);
  const L: string[] = [];

  L.push(`# OP-Scalper simulation`);
  L.push('');
  L.push(`- unit: ${cfg.anchorMode}${cfg.anchorMode === 'vertical' ? ` (ATM / ATM±${cfg.wing} debit vertical)` : ' ATM option'}`);
  L.push(`- hedge: ${cfg.hedgeMode === 'strangle' ? `long ATM±${cfg.hedgeWing} strangle, 1 unit each, held` : 'none'}`);
  L.push(`- costMult: ${cfg.costMult}x round-trip cost`);
  L.push(`- entry: ${cfg.entry}${cfg.entry === 'passive' ? ` (bid + ${cfg.entryImproveTicks} tick)` : ''}`);
  L.push(`- flipTicks: ${cfg.flipTicks} · switchPct: ${(cfg.switchPct * 100).toFixed(2)}% · minTradingDte: ${cfg.minTradingDte}`);
  L.push(`- anchorStopTicks: ${cfg.anchorStopTicks || 'off'} · anchorTimeStopSec: ${cfg.anchorTimeStopSec || 'off'} · coveredStopTicks: ${cfg.coveredStopTicks || 'off'}`);
  L.push(`- days simulated: ${days.filter((d) => d.skipped === undefined).length} / ${days.length}`);
  L.push('');

  L.push(`## Result`);
  L.push('');
  L.push(`| Metric | Value |`);
  L.push(`| --- | ---: |`);
  L.push(`| Trades | ${t.trades} |`);
  L.push(`| Win rate | ${t.trades > 0 ? ((100 * t.wins) / t.trades).toFixed(1) : '0.0'}% |`);
  L.push(`| Gross | ${inr(t.gross)} |`);
  L.push(`| Charges | ${inr(-t.charges)} |`);
  L.push(`| **Net** | **${inr(t.net)}** |`);
  L.push(`| Net / trade | ${t.trades > 0 ? inr(Math.round(t.net / t.trades)) : '-'} |`);
  L.push('');

  const byKind = new Map<TradeKind, SimTrade[]>();
  for (const tr of all) byKind.set(tr.kind, [...(byKind.get(tr.kind) ?? []), tr]);
  L.push(`## By exit kind`);
  L.push('');
  L.push(`| Kind | Trades | Gross | Charges | Net | Net/trade |`);
  L.push(`| --- | ---: | ---: | ---: | ---: | ---: |`);
  for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const k = totalsOf(list);
    L.push(
      `| ${kind} | ${k.trades} | ${inr(k.gross)} | ${inr(-k.charges)} | ${inr(k.net)} | ${inr(Math.round(k.net / Math.max(1, k.trades)))} |`,
    );
  }
  L.push('');

  // Would a structural debit cap bind? Compare realised losses against the
  // median entry debit — a vertical can never lose more than what it cost.
  const losses = all.filter((x) => x.netPaise < 0).map((x) => -x.netPaise).sort((a, b) => a - b);
  const medDebit = median(days.filter((d) => d.skipped === undefined).map((d) => d.medianEntryPaise));
  L.push(`## Loss distribution — does a debit cap bind?`);
  L.push('');
  if (losses.length > 0) {
    L.push(`| Percentile | Loss per trade |`);
    L.push(`| --- | ---: |`);
    for (const p of [50, 75, 90, 95, 99]) L.push(`| p${p} | ${inr(percentile(losses, p))} |`);
    L.push(`| max | ${inr(losses[losses.length - 1] ?? 0)} |`);
    L.push('');
    const capPaise = medDebit * (cfg.lots * 65);
    L.push(`Median entry debit per unit: ${inr(medDebit)}/unit → max structural loss ≈ ${inr(capPaise)} per lot.`);
    const over = losses.filter((v) => v > capPaise).length;
    L.push('');
    L.push(`Losing trades already smaller than that cap: ${losses.length - over} / ${losses.length} (${((100 * (losses.length - over)) / losses.length).toFixed(1)}%)`);
    L.push('');
  }

  L.push(`## MFE — can the target even be reached?`);
  L.push('');
  const withEntry = eps.filter((e) => e.entryPaise > 0);
  const mfePct = withEntry.map((e) => (e.mfePaise / e.entryPaise) * 100).sort((a, b) => a - b);
  const maePct = withEntry.map((e) => (e.maePaise / e.entryPaise) * 100).sort((a, b) => a - b);
  const needPct = withEntry.map((e) => (e.targetIncPaise / e.entryPaise) * 100).sort((a, b) => a - b);
  if (mfePct.length > 0) {
    L.push(`Anchor episodes: ${eps.length}`);
    L.push('');
    L.push(`| Percentile | MFE (% of entry) | MAE (% of entry) |`);
    L.push(`| --- | ---: | ---: |`);
    for (const p of [10, 25, 50, 75, 90, 99]) {
      L.push(`| p${p} | ${percentile(mfePct, p).toFixed(3)}% | ${percentile(maePct, 100 - p).toFixed(3)}% |`);
    }
    L.push('');
    L.push(`**Target needed (median): ${percentile(needPct, 50).toFixed(3)}% of entry value**`);
    const reached = eps.filter((e) => e.mfePaise >= e.targetIncPaise).length;
    L.push('');
    L.push(`Episodes whose MFE reached their own target: ${reached} / ${eps.length} (${eps.length > 0 ? ((100 * reached) / eps.length).toFixed(1) : '0'}%)`);
    L.push(`Episodes that actually exited at target: ${eps.filter((e) => e.outcome === 'TARGET').length} / ${eps.length}`);
    L.push('');
  }

  const outcomes = new Map<AnchorOutcome, number>();
  for (const e of eps) outcomes.set(e.outcome, (outcomes.get(e.outcome) ?? 0) + 1);
  L.push(`## Anchor outcomes`);
  L.push('');
  L.push(`| Outcome | Count | Share |`);
  L.push(`| --- | ---: | ---: |`);
  for (const [o, c] of [...outcomes.entries()].sort((a, b) => b[1] - a[1])) {
    L.push(`| ${o} | ${c} | ${eps.length > 0 ? ((100 * c) / eps.length).toFixed(1) : '0'}% |`);
  }
  L.push('');

  const stuckMs = eps.filter((e) => e.outcome !== 'TARGET').map((e) => e.durationMs).sort((a, b) => a - b);
  if (stuckMs.length > 0) {
    L.push(`Stuck-anchor duration — p50 ${(percentile(stuckMs, 50) / 60_000).toFixed(1)}m · p90 ${(percentile(stuckMs, 90) / 60_000).toFixed(1)}m`);
    const scalps = eps.map((e) => e.coveredScalps);
    L.push('');
    L.push(`Covered scalps — total ${scalps.reduce((s, v) => s + v, 0)} · max/episode ${scalps.length > 0 ? Math.max(...scalps) : 0}`);
    L.push('');
  }

  L.push(`## Day by day`);
  L.push('');
  L.push(`| Date | DTE | Expiry | Trades | Switches | Scalp | Hedge | Net |`);
  L.push(`| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |`);
  for (const d of days) {
    if (d.skipped !== undefined) {
      L.push(`| ${d.date} | - | - | - | - | - | - | _${d.skipped}_ |`);
      continue;
    }
    const sc = totalsOf(d.trades.filter((x) => x.kind !== 'HEDGE'));
    const hg = totalsOf(d.trades.filter((x) => x.kind === 'HEDGE'));
    L.push(
      `| ${d.date} | ${d.tradingDte} | ${d.expiry} | ${d.trades.length} | ${d.switches} | ${inr(sc.net)} | ${inr(hg.net)} | ${inr(sc.net + hg.net)} |`,
    );
  }
  L.push('');
  L.push(`_DTE counts weekdays only — no NSE holiday calendar in this repo, so a holiday week overstates DTE by one._`);
  L.push('');
  return L.join('\n');
}

// ── entry point ──────────────────────────────────────────────────────────────

function parseNum(argv: string[], flag: string, dflt: number): number {
  const i = argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}

function parseStr(argv: string[], flag: string, dflt: string): string {
  const i = argv.indexOf(flag);
  return i < 0 ? dflt : String(argv[i + 1] ?? dflt);
}

function parseArgs(argv: string[]): { days: number; endDate: string; sweep: boolean; cfg: SimConfig } {
  return {
    days: parseNum(argv, '--days', 30),
    endDate: parseStr(argv, '--end', istDate()),
    sweep: argv.includes('--sweep'),
    cfg: {
      costMult: parseNum(argv, '--cost-mult', 3),
      flipTicks: parseNum(argv, '--flip-ticks', 20),
      switchPct: parseNum(argv, '--switch-pct', 0.5) / 100,
      minTradingDte: parseNum(argv, '--min-dte', 2),
      anchorMode: parseStr(argv, '--anchor', 'naked') === 'vertical' ? 'vertical' : 'naked',
      wing: parseNum(argv, '--wing', 2),
      hedgeMode: parseStr(argv, '--hedge', 'none') === 'strangle' ? 'strangle' : 'none',
      hedgeWing: parseNum(argv, '--hedge-wing', 2),
      entry: parseStr(argv, '--entry', 'passive') === 'cross' ? 'cross' : 'passive',
      entryImproveTicks: parseNum(argv, '--entry-improve-ticks', 1),
      anchorStopTicks: parseNum(argv, '--anchor-stop-ticks', 0),
      anchorTimeStopSec: parseNum(argv, '--anchor-time-stop-sec', 0),
      coveredStopTicks: parseNum(argv, '--covered-stop-ticks', 0),
      quoteFrom: '09:45',
      entryCutoff: '15:10',
      squareOff: '15:15',
      maxSpreadPct: parseNum(argv, '--max-spread-pct', 5) / 100,
      lots: parseNum(argv, '--lots', 1),
    },
  };
}

async function main(): Promise<void> {
  const { days, endDate, sweep, cfg } = parseArgs(process.argv.slice(2));
  const market = loadConfig(MarketProfileSchema, join(CONFIG_DIR, 'market', 'allop-nse-options.json')).value;

  const sources: { date: string; dir: string }[] = [];
  for (const date of listLookbackDays(endDate, days)) {
    const dir = pickSourceDay(date);
    if (dir !== undefined) sources.push({ date, dir });
  }

  console.log(`OP-Scalper simulator`);
  console.log(`  End date   : ${endDate}`);
  console.log(`  Lookback   : ${days} days (${sources.length} with recordings)`);
  console.log(`  Unit       : ${cfg.anchorMode}${cfg.anchorMode === 'vertical' ? ` (ATM / ATM±${cfg.wing})` : ''}`);
  console.log('');

  const outDir = join(SCALPER_ROOT, 'journals', 'op-scalper-sim');
  mkdirSync(outDir, { recursive: true });

  for (const mult of sweep ? [1, 1.5, 2, 2.5, 3, 4] : [cfg.costMult]) {
    const armCfg: SimConfig = { ...cfg, costMult: mult };
    const results: DayResult[] = [];
    for (const { date, dir } of sources) {
      try {
        results.push(await simulateDay(date, dir, market, armCfg));
      } catch (err) {
        results.push(emptyDay(date, err instanceof Error ? err.message : String(err)));
      }
    }
    // Stop config must be in the name: without it, two runs that differ only by
    // stops silently overwrite each other's report.
    const stops = `as${armCfg.anchorStopTicks}-cs${armCfg.coveredStopTicks}-ts${armCfg.anchorTimeStopSec}`;
    const unit = armCfg.anchorMode === 'vertical' ? `vert${armCfg.wing}` : 'naked';
    const hedged = armCfg.hedgeMode === 'strangle' ? `-hedge${armCfg.hedgeWing}` : '';
    writeFileSync(
      join(outDir, `sim-${endDate}-${days}d-${unit}${hedged}-mult${mult}-${armCfg.entry}-flip${armCfg.flipTicks}-${stops}.md`),
      renderRun(results, armCfg),
      'utf8',
    );

    const allTrades = results.flatMap((d) => d.trades);
    const t = totalsOf(allTrades);
    // Split scalp from hedge: the whole question is whether the wings pay for
    // themselves out of the losses they are supposed to offset.
    const scalp = totalsOf(allTrades.filter((x) => x.kind !== 'HEDGE'));
    const hedgeT = totalsOf(allTrades.filter((x) => x.kind === 'HEDGE'));
    const hedgeCol = cfg.hedgeMode === 'strangle' ? ` | hedge ${inr(hedgeT.net).padStart(14)}` : '';
    console.log(
      `  ${String(mult).padStart(4)}x | trades ${String(t.trades).padStart(6)} | win ${(t.trades > 0 ? (100 * t.wins) / t.trades : 0).toFixed(1).padStart(5)}% | scalp ${inr(scalp.net).padStart(14)}${hedgeCol} | net ${inr(t.net).padStart(15)}`,
    );
  }

  console.log('');
  console.log(`Reports written to ${outDir}`);
}

void main().catch((err) => {
  console.error('simulate-op-scalper failed:', err);
  process.exitCode = 1;
});

export { RightScalper, targetIncrementPaise, tradingDaysBetween, verticalUnit, nakedUnit };
