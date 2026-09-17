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
 * Usage:
 *   node dist/scripts/simulate-op-scalper.js [--days 30] [--end YYYY-MM-DD]
 *     [--cost-mult 3] [--sweep] [--entry passive|cross]
 *     [--anchor-stop-ticks N] [--anchor-time-stop-sec N]
 *
 * The headline diagnostic is the MFE distribution: how far an entry actually
 * travels in its favour, against how far it must travel to clear costMult x cost.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { computeCharges } from '../charges/engine.js';
import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, type MarketProfile } from '../config/schemas.js';
import type { InstrumentId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { Tick } from '../domain/marketdata.js';
import { istDayStartMs } from '../domain/time.js';
import { loadScripMaster } from '../marketdata/instrument-master.js';
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
  join(SCALPER_ROOT, 'data', 'dhan', 'ticks'),
];
const IST_OFFSET_MS = 330 * 60_000;

// ── knobs ────────────────────────────────────────────────────────────────────

interface SimConfig {
  /** Net profit target as a multiple of round-trip cost (rule 3). */
  costMult: number;
  /** Ticks the bid must fall below the anchor before flipping to sell-first. */
  flipTicks: number;
  /** Underlying move that forces square-off + ATM re-centre (rule 5), fraction. */
  switchPct: number;
  /** Trading days to expiry below which the desk does not trade (rule 1). */
  minTradingDte: number;
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
  /** Skip quoting when the spread is wider than this fraction of mid. */
  maxSpreadPct: number;
  lots: number;
}

// ── per-episode bookkeeping ──────────────────────────────────────────────────

type AnchorOutcome = 'TARGET' | 'STOP' | 'TIME' | 'SWITCH' | 'EOD';

interface AnchorEpisode {
  date: string;
  right: OptionRight;
  entryPaise: number;
  targetIncPaise: number;
  /** Best favourable excursion over the anchor's life, per unit, paise. */
  mfePaise: number;
  /** Worst adverse excursion over the anchor's life, per unit, paise. */
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
  | 'EOD';

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

function inr(paise: number): string {
  return `${paise < 0 ? '-' : ''}₹${Math.abs(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Round-trip statutory cost, total paise, for `qty` at roughly `pricePaise`. */
function roundTripCostPaise(market: MarketProfile, qty: number, pricePaise: number): number {
  return computeCharges(
    [
      { side: 'BUY', qty, pricePaise, orderId: 'in' },
      { side: 'SELL', qty, pricePaise, orderId: 'out' },
    ],
    market,
  ).totalPaise;
}

/**
 * Per-unit premium move needed so that net profit = costMult x round-trip cost.
 * Rounded up to a tick — you cannot quote between ticks.
 */
function targetIncrementPaise(
  market: MarketProfile,
  qty: number,
  entryPaise: number,
  costMult: number,
): number {
  const cost = roundTripCostPaise(market, qty, entryPaise);
  const grossNeeded = (costMult + 1) * cost;
  const perUnit = grossNeeded / qty;
  const tick = market.tickSizePaise;
  return Math.max(tick, Math.ceil(perUnit / tick) * tick);
}

// ── the machine ──────────────────────────────────────────────────────────────

interface Book {
  bidPaise: number;
  askPaise: number;
}

type Phase = 'FLAT' | 'LONG' | 'COVERED';

/** One right's inventory-anchored scalper. */
class RightScalper {
  phase: Phase = 'FLAT';
  anchorPaise = 0;
  anchorTs = 0;
  anchorTargetInc = 0;
  anchorMfe = 0;
  anchorMae = 0;
  anchorScalps = 0;
  shortPaise = 0;
  shortTs = 0;
  shortTargetInc = 0;
  /** Working passive entry limit; repriced as the book moves, like a real quote. */
  private restingEntry: number | undefined;

  constructor(
    readonly right: OptionRight,
    private readonly cfg: SimConfig,
    private readonly market: MarketProfile,
    private readonly qty: number,
    private readonly onTrade: (t: Omit<SimTrade, 'date' | 'right'>) => void,
    private readonly onEpisode: (e: Omit<AnchorEpisode, 'date' | 'right'>) => void,
  ) {}

  private book(tick: Book): boolean {
    if (tick.bidPaise <= 0 || tick.askPaise <= 0) return false;
    if (tick.askPaise <= tick.bidPaise) return false;
    const mid = (tick.bidPaise + tick.askPaise) / 2;
    return (tick.askPaise - tick.bidPaise) / mid <= this.cfg.maxSpreadPct;
  }

  private record(kind: TradeKind, entryPaise: number, exitPaise: number, holdMs: number): void {
    const gross = (exitPaise - entryPaise) * this.qty;
    const charges = computeCharges(
      [
        { side: 'BUY', qty: this.qty, pricePaise: entryPaise, orderId: 'in' },
        { side: 'SELL', qty: this.qty, pricePaise: exitPaise, orderId: 'out' },
      ],
      this.market,
    ).totalPaise;
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

  /** Short scalp: sold first at `shortPaise`, bought back at `exitPaise`. */
  private recordShort(entryPaise: number, exitPaise: number, holdMs: number, kind: TradeKind = 'COVERED_SCALP'): void {
    const gross = (entryPaise - exitPaise) * this.qty;
    const charges = computeCharges(
      [
        { side: 'SELL', qty: this.qty, pricePaise: entryPaise, orderId: 'in' },
        { side: 'BUY', qty: this.qty, pricePaise: exitPaise, orderId: 'out' },
      ],
      this.market,
    ).totalPaise;
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

  /** Advance one quote update. `entriesOpen` gates new anchors by the clock. */
  step(b: Book, nowMs: number, entriesOpen: boolean): void {
    if (!this.book(b)) return;
    const tick = this.market.tickSizePaise;

    if (this.phase === 'FLAT') {
      if (!entriesOpen) {
        this.restingEntry = undefined;
        return;
      }
      if (this.cfg.entry === 'cross') {
        this.openAnchor(b.askPaise, nowMs);
        return;
      }
      // A resting buy only fills when a seller crosses down onto it. Checking
      // the fill BEFORE repricing is what makes the adverse selection real:
      // we get filled on the way down, never at the moment we quote.
      if (this.restingEntry !== undefined && b.askPaise <= this.restingEntry) {
        this.openAnchor(this.restingEntry, nowMs);
        return;
      }
      const limit = b.bidPaise + this.cfg.entryImproveTicks * tick;
      this.restingEntry = limit < b.askPaise ? limit : b.askPaise - tick;
      return;
    }

    if (this.phase === 'LONG') {
      this.restingEntry = undefined;
      this.anchorMfe = Math.max(this.anchorMfe, b.bidPaise - this.anchorPaise);
      this.anchorMae = Math.min(this.anchorMae, b.bidPaise - this.anchorPaise);

      const target = this.anchorPaise + this.anchorTargetInc;
      if (b.bidPaise >= target) {
        this.record('ANCHOR_TARGET', this.anchorPaise, target, nowMs - this.anchorTs);
        this.closeEpisode('TARGET', nowMs);
        this.phase = 'FLAT';
        return;
      }
      if (this.cfg.anchorStopTicks > 0 && b.bidPaise <= this.anchorPaise - this.cfg.anchorStopTicks * tick) {
        this.record('ANCHOR_STOP', this.anchorPaise, b.bidPaise, nowMs - this.anchorTs);
        this.closeEpisode('STOP', nowMs);
        this.phase = 'FLAT';
        return;
      }
      if (this.cfg.anchorTimeStopSec > 0 && nowMs - this.anchorTs >= this.cfg.anchorTimeStopSec * 1_000) {
        this.record('ANCHOR_TIME', this.anchorPaise, b.bidPaise, nowMs - this.anchorTs);
        this.closeEpisode('TIME', nowMs);
        this.phase = 'FLAT';
        return;
      }
      // Rule 7: price has walked away from the anchor — flip to sell-first,
      // covered by the inventory we already hold (never net short).
      if (b.bidPaise <= this.anchorPaise - this.cfg.flipTicks * tick && entriesOpen) {
        this.shortPaise = b.bidPaise;
        this.shortTs = nowMs;
        this.shortTargetInc = targetIncrementPaise(this.market, this.qty, this.shortPaise, this.cfg.costMult);
        this.phase = 'COVERED';
      }
      return;
    }

    // COVERED: anchor long + scalp short = net 0. Buy the short back lower.
    this.anchorMfe = Math.max(this.anchorMfe, b.bidPaise - this.anchorPaise);
    this.anchorMae = Math.min(this.anchorMae, b.bidPaise - this.anchorPaise);

    const buyBack = this.shortPaise - this.shortTargetInc;
    if (b.askPaise <= buyBack) {
      this.recordShort(this.shortPaise, buyBack, nowMs - this.shortTs);
      this.anchorScalps++;
      this.phase = 'LONG';
      return;
    }
    if (this.cfg.coveredStopTicks > 0 && b.askPaise >= this.shortPaise + this.cfg.coveredStopTicks * tick) {
      this.recordShort(this.shortPaise, b.askPaise, nowMs - this.shortTs, 'COVERED_FORCED');
      this.anchorScalps++;
      this.phase = 'LONG';
    }
  }

  private openAnchor(pricePaise: number, nowMs: number): void {
    this.restingEntry = undefined;
    this.anchorPaise = pricePaise;
    this.anchorTs = nowMs;
    this.anchorTargetInc = targetIncrementPaise(this.market, this.qty, pricePaise, this.cfg.costMult);
    this.anchorMfe = 0;
    this.anchorMae = 0;
    this.anchorScalps = 0;
    this.phase = 'LONG';
  }

  /** Force flat at the current book (rule 5 switch, or end of day). */
  flatten(b: Book, nowMs: number, kind: 'SWITCH' | 'EOD'): void {
    if (this.phase === 'COVERED') {
      const exit = b.askPaise > 0 ? b.askPaise : this.shortPaise;
      this.recordShort(this.shortPaise, exit, nowMs - this.shortTs, 'COVERED_FORCED');
      this.anchorScalps++;
      this.phase = 'LONG';
    }
    if (this.phase === 'LONG') {
      const exit = b.bidPaise > 0 ? b.bidPaise : this.anchorPaise;
      this.record(kind, this.anchorPaise, exit, nowMs - this.anchorTs);
      this.closeEpisode(kind, nowMs);
      this.phase = 'FLAT';
    }
  }
}

// ── one day ──────────────────────────────────────────────────────────────────

async function simulateDay(date: string, dir: string, market: MarketProfile, cfg: SimConfig): Promise<DayResult> {
  const ticks = await loadTicksForDate(dir);
  if (ticks.length === 0) return emptyDay(date, 'no ticks');

  const masterPath = resolveScripMasterPath(date);
  const recording = discoverPlainRecording(ticks, masterPath);
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
  const byStrikeRight = new Map<string, InstrumentId>();
  for (const s of specs) byStrikeRight.set(`${s.strikePaise}:${s.right}`, s.instrumentId);

  const step = market.contract.strikeStepPaise;
  const qty = market.contract.lotSize * cfg.lots;
  const trades: SimTrade[] = [];
  const episodes: AnchorEpisode[] = [];
  const books = new Map<InstrumentId, Book>();

  let spotPaise = 0;
  let atmStrike = 0;
  let strikeAnchorSpot = 0;
  let switches = 0;

  const push = (right: OptionRight) => (t: Omit<SimTrade, 'date' | 'right'>) =>
    trades.push({ date, right, ...t });
  const pushEp = (right: OptionRight) => (e: Omit<AnchorEpisode, 'date' | 'right'>) =>
    episodes.push({ date, right, ...e });

  const make = (right: OptionRight): RightScalper =>
    new RightScalper(right, cfg, market, qty, push(right), pushEp(right));
  let legs: Record<OptionRight, RightScalper> = { CE: make('CE'), PE: make('PE') };

  const bookOf = (right: OptionRight): Book => {
    const id = byStrikeRight.get(`${atmStrike}:${right}`);
    const b = id === undefined ? undefined : books.get(id);
    return b ?? { bidPaise: 0, askPaise: 0 };
  };

  const fromMs = hhmmToMs(cfg.quoteFrom);
  const cutoffMs = hhmmToMs(cfg.entryCutoff);
  const squareMs = hhmmToMs(cfg.squareOff);

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
        legs.CE.flatten(bookOf('CE'), t.ts, 'SWITCH');
        legs.PE.flatten(bookOf('PE'), t.ts, 'SWITCH');
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
    if (atmStrike === 0) continue;

    if (intoDay >= squareMs) break;
    const entriesOpen = intoDay >= fromMs && intoDay < cutoffMs;

    const spec = specs.find((s) => s.instrumentId === t.instrumentId);
    if (spec === undefined || spec.strikePaise !== atmStrike) continue;
    legs[spec.right].step({ bidPaise: t.bidPaise, askPaise: t.askPaise }, t.ts, entriesOpen);
  }

  const endTs = dayStart + squareMs;
  legs.CE.flatten(bookOf('CE'), endTs, 'EOD');
  legs.PE.flatten(bookOf('PE'), endTs, 'EOD');

  return { date, expiry, tradingDte, ticks: inSession.length, trades, episodes, switches };
}

function emptyDay(date: string, why: string): DayResult {
  return { date, expiry: '', tradingDte: 0, ticks: 0, trades: [], episodes: [], switches: 0, skipped: why };
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
  L.push(`| Kind | Trades | Gross | Charges | Net |`);
  L.push(`| --- | ---: | ---: | ---: | ---: |`);
  for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const k = totalsOf(list);
    L.push(`| ${kind} | ${k.trades} | ${inr(k.gross)} | ${inr(-k.charges)} | ${inr(k.net)} |`);
  }
  L.push('');

  // The headline diagnostic: how far entries actually travel, vs how far they
  // must travel to pay costMult x cost.
  L.push(`## MFE — can the target even be reached?`);
  L.push('');
  const mfePct = eps
    .filter((e) => e.entryPaise > 0)
    .map((e) => (e.mfePaise / e.entryPaise) * 100)
    .sort((a, b) => a - b);
  const needPct = eps
    .filter((e) => e.entryPaise > 0)
    .map((e) => (e.targetIncPaise / e.entryPaise) * 100)
    .sort((a, b) => a - b);
  const maePct = eps
    .filter((e) => e.entryPaise > 0)
    .map((e) => (e.maePaise / e.entryPaise) * 100)
    .sort((a, b) => a - b);

  if (mfePct.length > 0) {
    L.push(`Anchor episodes: ${eps.length}`);
    L.push('');
    L.push(`| Percentile | MFE (% of premium) | MAE (% of premium) |`);
    L.push(`| --- | ---: | ---: |`);
    for (const p of [10, 25, 50, 75, 90, 99]) {
      L.push(`| p${p} | ${percentile(mfePct, p).toFixed(3)}% | ${percentile(maePct, 100 - p).toFixed(3)}% |`);
    }
    L.push('');
    L.push(`**Target needed (median): ${percentile(needPct, 50).toFixed(3)}% of premium**`);
    // Per-episode, not percentile-vs-percentile: MFE and target must be
    // compared on the SAME episode or the answer is meaningless.
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
    L.push(`Stuck-anchor duration — p50 ${(percentile(stuckMs, 50) / 60_000).toFixed(1)}m · p90 ${(percentile(stuckMs, 90) / 60_000).toFixed(1)}m · max ${(Math.max(...stuckMs) / 60_000).toFixed(1)}m`);
    const scalps = eps.map((e) => e.coveredScalps);
    L.push('');
    L.push(`Covered scalps per episode — total ${scalps.reduce((s, v) => s + v, 0)} · max ${scalps.length > 0 ? Math.max(...scalps) : 0}`);
    L.push('');
  }

  L.push(`## Day by day`);
  L.push('');
  L.push(`| Date | DTE | Expiry | Ticks | Trades | Switches | Net |`);
  L.push(`| --- | ---: | --- | ---: | ---: | ---: | ---: |`);
  for (const d of days) {
    if (d.skipped !== undefined) {
      L.push(`| ${d.date} | - | - | - | - | - | _${d.skipped}_ |`);
      continue;
    }
    L.push(
      `| ${d.date} | ${d.tradingDte} | ${d.expiry} | ${d.ticks} | ${d.trades.length} | ${d.switches} | ${inr(totalsOf(d.trades).net)} |`,
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

function parseArgs(argv: string[]): { days: number; endDate: string; sweep: boolean; cfg: SimConfig } {
  const endIdx = argv.indexOf('--end');
  const entryIdx = argv.indexOf('--entry');
  return {
    days: parseNum(argv, '--days', 30),
    endDate: endIdx >= 0 ? String(argv[endIdx + 1] ?? istDate()) : istDate(),
    sweep: argv.includes('--sweep'),
    cfg: {
      costMult: parseNum(argv, '--cost-mult', 3),
      flipTicks: parseNum(argv, '--flip-ticks', 20),
      switchPct: parseNum(argv, '--switch-pct', 0.5) / 100,
      minTradingDte: parseNum(argv, '--min-dte', 2),
      entry: String(argv[entryIdx + 1] ?? '') === 'cross' ? 'cross' : 'passive',
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
  const marketCfg = loadConfig(MarketProfileSchema, join(CONFIG_DIR, 'market', 'allop-nse-options.json'));
  const market = marketCfg.value;

  // Resolve the corpus once; every sweep arm replays the same days.
  const sources: { date: string; dir: string }[] = [];
  for (const date of listLookbackDays(endDate, days)) {
    const dir = pickSourceDay(date);
    if (dir !== undefined) sources.push({ date, dir });
  }

  console.log(`OP-Scalper simulator`);
  console.log(`  End date   : ${endDate}`);
  console.log(`  Lookback   : ${days} days (${sources.length} with recordings)`);
  const sampleCost = roundTripCostPaise(market, market.contract.lotSize * cfg.lots, 10_000);
  console.log(`  Round-trip cost @ ₹100 premium, ${cfg.lots} lot: ${inr(sampleCost)}`);
  console.log(`  Target @ ${cfg.costMult}x: ${inr(sampleCost * cfg.costMult)} net → needs ${((targetIncrementPaise(market, market.contract.lotSize * cfg.lots, 10_000, cfg.costMult) / 10_000) * 100).toFixed(3)}% premium move`);
  console.log('');

  const outDir = join(SCALPER_ROOT, 'journals', 'op-scalper-sim');
  mkdirSync(outDir, { recursive: true });

  const arms = sweep ? [1, 1.5, 2, 2.5, 3, 4] : [cfg.costMult];
  const summary: string[] = [];

  for (const mult of arms) {
    const armCfg: SimConfig = { ...cfg, costMult: mult };
    const results: DayResult[] = [];
    for (const { date, dir } of sources) {
      try {
        results.push(await simulateDay(date, dir, market, armCfg));
      } catch (err) {
        results.push(emptyDay(date, err instanceof Error ? err.message : String(err)));
      }
    }
    const report = renderRun(results, armCfg);
    // Stop config must be in the name: without it, two runs that differ only by
    // stops silently overwrite each other's report.
    const stops = `as${armCfg.anchorStopTicks}-cs${armCfg.coveredStopTicks}-ts${armCfg.anchorTimeStopSec}`;
    const path = join(outDir, `sim-${endDate}-${days}d-mult${mult}-${armCfg.entry}-flip${armCfg.flipTicks}-${stops}.md`);
    writeFileSync(path, report, 'utf8');

    const t = totalsOf(results.flatMap((d) => d.trades));
    const eps = results.flatMap((d) => d.episodes);
    const hit = eps.filter((e) => e.outcome === 'TARGET').length;
    summary.push(
      `  ${String(mult).padStart(4)}x | trades ${String(t.trades).padStart(5)} | win ${(t.trades > 0 ? (100 * t.wins) / t.trades : 0).toFixed(1).padStart(5)}% | target-hit ${(eps.length > 0 ? (100 * hit) / eps.length : 0).toFixed(1).padStart(5)}% | net ${inr(t.net).padStart(14)}`,
    );
    console.log(summary[summary.length - 1]);
  }

  console.log('');
  console.log(`Reports written to ${outDir}`);
}

void main().catch((err) => {
  console.error('simulate-op-scalper failed:', err);
  process.exitCode = 1;
});

export { RightScalper, targetIncrementPaise, tradingDaysBetween, roundTripCostPaise };
