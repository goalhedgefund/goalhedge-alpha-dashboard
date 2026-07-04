import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JournalEvent } from '../domain/events.js';
import type { Tick } from '../domain/marketdata.js';
import type { Trade } from '../domain/positions.js';
import { readJournal } from '../journal/reader.js';

/**
 * Daily digest (01-DESIGN §8, 04-RUNBOOK §1). A pure reduction of a session
 * journal into the post-close report: trades, hit rate, gross→charges→net
 * waterfall, per-strategy attribution, latency stats, and max adverse
 * excursion (MAE). Rendered to markdown (human) + CSV (spreadsheet). A true
 * .xlsx is a later thin wrapper over the same DigestReport.
 *
 * All money is integer paise; MAE needs tick coverage (md.tick in the journal)
 * and degrades gracefully to "N/A" per trade when the session didn't record
 * ticks — never a fabricated number.
 */

export interface DigestTradeRow {
  tradeId: string;
  strategyId: string;
  instrumentId: string;
  qty: number;
  entryTs: number;
  exitTs: number;
  entryPricePaise: number;
  exitPricePaise: number;
  grossPnlPaise: number;
  chargesPaise: number;
  netPnlPaise: number;
  exitReason: string;
  holdMs: number;
  /** Adverse-excursion magnitude in paise (≥0), undefined when no tick coverage. */
  maePaise?: number;
}

export interface WaterfallRow {
  label: string;
  paise: number;
  kind: 'gross' | 'charge' | 'net';
}

export interface StrategyAttribution {
  strategyId: string;
  trades: number;
  wins: number;
  hitRate: number;
  grossPaise: number;
  chargesPaise: number;
  netPaise: number;
}

export interface ExitReasonRow {
  reason: string;
  count: number;
  netPaise: number;
}

export interface LatencyDigest {
  samples: number;
  totalP50Ms: number;
  totalP99Ms: number;
  totalMaxMs: number;
  /** Mean of each hop across order decisions, microseconds. */
  hopAvgMicros: { features: number; signal: number; risk: number; sent: number };
}

export interface MaeDigest {
  covered: number;
  uncovered: number;
  worstPaise: number;
  avgPaise: number;
}

export interface DigestSummary {
  tradeCount: number;
  wins: number;
  losses: number;
  scratches: number;
  hitRate: number;
  grossPaise: number;
  chargesPaise: number;
  netPaise: number;
  avgHoldMs: number;
  /** Largest realized give-back from the running peak net P&L. */
  maxGiveBackPaise: number;
}

export interface DigestReport {
  sessionId: string;
  date: string;
  mode: string;
  generatedTs: number;
  summary: DigestSummary;
  waterfall: WaterfallRow[];
  byStrategy: StrategyAttribution[];
  byExitReason: ExitReasonRow[];
  latency: LatencyDigest | undefined;
  mae: MaeDigest | undefined;
  trades: DigestTradeRow[];
}

export interface DigestMeta {
  sessionId?: string;
  date?: string;
  mode?: string;
  generatedTs?: number;
}

/** Nearest-rank percentile over an unsorted array. `q` in [0,1]. */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] as number;
}

/** Build the digest from an in-memory journal event stream. */
export function buildDigest(events: readonly JournalEvent[], meta: DigestMeta = {}): DigestReport {
  const trades: Trade[] = [];
  const latencyTotalsMs: number[] = [];
  const hopSums = { features: 0, signal: 0, risk: 0, sent: 0 };
  let latencyCount = 0;
  const ticksByInstrument = new Map<string, Tick[]>();
  let sessionId = meta.sessionId ?? 'unknown';
  let date = meta.date ?? 'unknown';
  let mode = meta.mode ?? 'unknown';

  for (const ev of events) {
    switch (ev.type) {
      case 'session.started':
        sessionId = meta.sessionId ?? ev.payload.session.sessionId;
        date = meta.date ?? ev.payload.session.date;
        mode = meta.mode ?? ev.payload.session.mode;
        break;
      case 'trade.completed':
        trades.push(ev.payload.trade);
        break;
      case 'latency.sample': {
        const h = ev.payload.hops;
        latencyCount++;
        if (typeof h.total === 'number') latencyTotalsMs.push(h.total / 1000); // micros → ms
        hopSums.features += h.features ?? 0;
        hopSums.signal += h.signal ?? 0;
        hopSums.risk += h.risk ?? 0;
        hopSums.sent += h.sent ?? 0;
        break;
      }
      case 'md.tick': {
        const t = ev.payload.tick;
        let arr = ticksByInstrument.get(t.instrumentId);
        if (arr === undefined) {
          arr = [];
          ticksByInstrument.set(t.instrumentId, arr);
        }
        arr.push(t);
        break;
      }
      default:
        break;
    }
  }

  const tradeRows = trades.map((t) => toTradeRow(t, ticksByInstrument.get(t.instrumentId)));
  const summary = summarize(tradeRows);

  return {
    sessionId,
    date,
    mode,
    generatedTs: meta.generatedTs ?? Date.now(),
    summary,
    waterfall: buildWaterfall(trades),
    byStrategy: attributeByStrategy(tradeRows),
    byExitReason: attributeByExitReason(tradeRows),
    latency: latencyCount > 0 ? buildLatencyDigest(latencyCount, latencyTotalsMs, hopSums) : undefined,
    mae: buildMaeDigest(tradeRows),
    trades: tradeRows,
  };
}

/** Read a journal file and build the digest. Tolerant of a torn tail. */
export async function buildDigestFromFile(path: string, meta: DigestMeta = {}): Promise<DigestReport> {
  const { events } = await readJournal(path, { strictSeq: false });
  return buildDigest(events, meta);
}

function toTradeRow(t: Trade, ticks: Tick[] | undefined): DigestTradeRow {
  const mae = maeForTrade(t, ticks);
  return {
    tradeId: t.tradeId,
    strategyId: t.strategyId,
    instrumentId: t.instrumentId,
    qty: t.qty,
    entryTs: t.entry.ts,
    exitTs: t.exit.ts,
    entryPricePaise: t.entry.pricePaise,
    exitPricePaise: t.exit.pricePaise,
    grossPnlPaise: t.grossPnlPaise,
    chargesPaise: t.charges.totalPaise,
    netPnlPaise: t.netPnlPaise,
    exitReason: t.exitReason,
    holdMs: t.holdMs,
    ...(mae !== undefined ? { maePaise: mae } : {}),
  };
}

/**
 * Max adverse excursion for a long-option trade: the worst mark-to-market loss
 * during the hold. Needs ticks for the instrument within [entryTs, exitTs];
 * undefined (→ "N/A") when the session recorded none.
 */
function maeForTrade(t: Trade, ticks: Tick[] | undefined): number | undefined {
  if (ticks === undefined || ticks.length === 0) return undefined;
  let minPremium = Infinity;
  let seen = false;
  for (const tick of ticks) {
    if (tick.ts < t.entry.ts || tick.ts > t.exit.ts) continue;
    if (tick.ltpPaise <= 0) continue;
    seen = true;
    if (tick.ltpPaise < minPremium) minPremium = tick.ltpPaise;
  }
  if (!seen) return undefined;
  // Long premium: adverse = premium below entry. Floor at 0 (never went red).
  return Math.max(0, (t.entry.pricePaise - minPremium) * t.qty);
}

function summarize(rows: DigestTradeRow[]): DigestSummary {
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let grossPaise = 0;
  let chargesPaise = 0;
  let netPaise = 0;
  let holdMsTotal = 0;
  for (const r of rows) {
    if (r.netPnlPaise > 0) wins++;
    else if (r.netPnlPaise < 0) losses++;
    else scratches++;
    grossPaise += r.grossPnlPaise;
    chargesPaise += r.chargesPaise;
    netPaise += r.netPnlPaise;
    holdMsTotal += r.holdMs;
  }
  return {
    tradeCount: rows.length,
    wins,
    losses,
    scratches,
    hitRate: rows.length > 0 ? wins / rows.length : 0,
    grossPaise,
    chargesPaise,
    netPaise,
    avgHoldMs: rows.length > 0 ? Math.round(holdMsTotal / rows.length) : 0,
    maxGiveBackPaise: maxGiveBack(rows),
  };
}

/** Largest drop of running net P&L from its peak, over trades in exit order. */
function maxGiveBack(rows: DigestTradeRow[]): number {
  const ordered = [...rows].sort((a, b) => a.exitTs - b.exitTs);
  let cum = 0;
  let peak = 0;
  let worst = 0;
  for (const r of ordered) {
    cum += r.netPnlPaise;
    if (cum > peak) peak = cum;
    const giveBack = peak - cum;
    if (giveBack > worst) worst = giveBack;
  }
  return worst;
}

/** Aggregate the per-trade charge components by name into a gross→net waterfall. */
function buildWaterfall(trades: Trade[]): WaterfallRow[] {
  let gross = 0;
  let net = 0;
  const componentOrder: string[] = [];
  const componentSums = new Map<string, number>();
  for (const t of trades) {
    gross += t.grossPnlPaise;
    net += t.netPnlPaise;
    for (const c of t.charges.components) {
      if (!componentSums.has(c.name)) componentOrder.push(c.name);
      componentSums.set(c.name, (componentSums.get(c.name) ?? 0) + c.paise);
    }
  }
  const rows: WaterfallRow[] = [{ label: 'Gross P&L', paise: gross, kind: 'gross' }];
  for (const name of componentOrder) {
    rows.push({ label: name, paise: -(componentSums.get(name) ?? 0), kind: 'charge' });
  }
  rows.push({ label: 'Net P&L', paise: net, kind: 'net' });
  return rows;
}

function attributeByStrategy(rows: DigestTradeRow[]): StrategyAttribution[] {
  const map = new Map<string, StrategyAttribution>();
  for (const r of rows) {
    let a = map.get(r.strategyId);
    if (a === undefined) {
      a = { strategyId: r.strategyId, trades: 0, wins: 0, hitRate: 0, grossPaise: 0, chargesPaise: 0, netPaise: 0 };
      map.set(r.strategyId, a);
    }
    a.trades++;
    if (r.netPnlPaise > 0) a.wins++;
    a.grossPaise += r.grossPnlPaise;
    a.chargesPaise += r.chargesPaise;
    a.netPaise += r.netPnlPaise;
  }
  const out = [...map.values()];
  for (const a of out) a.hitRate = a.trades > 0 ? a.wins / a.trades : 0;
  return out.sort((x, y) => y.netPaise - x.netPaise);
}

function attributeByExitReason(rows: DigestTradeRow[]): ExitReasonRow[] {
  const map = new Map<string, ExitReasonRow>();
  for (const r of rows) {
    let e = map.get(r.exitReason);
    if (e === undefined) {
      e = { reason: r.exitReason, count: 0, netPaise: 0 };
      map.set(r.exitReason, e);
    }
    e.count++;
    e.netPaise += r.netPnlPaise;
  }
  return [...map.values()].sort((x, y) => y.count - x.count);
}

function buildLatencyDigest(
  count: number,
  totalsMs: number[],
  hopSums: { features: number; signal: number; risk: number; sent: number },
): LatencyDigest {
  return {
    samples: count,
    totalP50Ms: round3(percentile(totalsMs, 0.5)),
    totalP99Ms: round3(percentile(totalsMs, 0.99)),
    totalMaxMs: round3(totalsMs.length > 0 ? Math.max(...totalsMs) : 0),
    hopAvgMicros: {
      features: Math.round(hopSums.features / count),
      signal: Math.round(hopSums.signal / count),
      risk: Math.round(hopSums.risk / count),
      sent: Math.round(hopSums.sent / count),
    },
  };
}

function buildMaeDigest(rows: DigestTradeRow[]): MaeDigest | undefined {
  const covered = rows.filter((r) => r.maePaise !== undefined);
  if (rows.length === 0) return undefined;
  const values = covered.map((r) => r.maePaise as number);
  return {
    covered: covered.length,
    uncovered: rows.length - covered.length,
    worstPaise: values.length > 0 ? Math.max(...values) : 0,
    avgPaise: values.length > 0 ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : 0,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ------------------------------------------------------------------ rendering

/** Paise → ₹ string with 2 decimals and Indian-style grouping. */
export function inr(paise: number): string {
  const neg = paise < 0;
  const rupees = Math.abs(paise) / 100;
  const [whole, frac] = rupees.toFixed(2).split('.');
  // Indian grouping: last 3 digits, then pairs.
  const s = whole as string;
  const head = s.length > 3 ? s.slice(0, s.length - 3) : '';
  const tail = s.slice(-3);
  const grouped = head !== '' ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail : tail;
  return `${neg ? '-' : ''}₹${grouped}.${frac ?? '00'}`;
}

function pct(frac: number): string {
  return `${(frac * 100).toFixed(1)}%`;
}

export function renderDigestMarkdown(r: DigestReport): string {
  const L: string[] = [];
  L.push(`# Daily Digest — ${r.date} (${r.mode.toUpperCase()})`);
  L.push('');
  L.push(`Session \`${r.sessionId}\` · generated ${new Date(r.generatedTs).toISOString()}`);
  L.push('');

  L.push('## Summary');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|---|---|');
  L.push(`| Trades | ${r.summary.tradeCount} |`);
  L.push(`| Hit rate | ${pct(r.summary.hitRate)} (${r.summary.wins}W / ${r.summary.losses}L / ${r.summary.scratches}S) |`);
  L.push(`| Gross P&L | ${inr(r.summary.grossPaise)} |`);
  L.push(`| Charges | ${inr(r.summary.chargesPaise)} |`);
  L.push(`| **Net P&L** | **${inr(r.summary.netPaise)}** |`);
  L.push(`| Avg hold | ${(r.summary.avgHoldMs / 1000).toFixed(1)}s |`);
  L.push(`| Max give-back | ${inr(r.summary.maxGiveBackPaise)} |`);
  L.push('');

  L.push('## Gross → Charges → Net waterfall');
  L.push('');
  L.push('| Line | Amount |');
  L.push('|---|---|');
  for (const w of r.waterfall) {
    const label = w.kind === 'net' ? `**${w.label}**` : w.label;
    const amount = w.kind === 'net' ? `**${inr(w.paise)}**` : inr(w.paise);
    L.push(`| ${label} | ${amount} |`);
  }
  L.push('');

  L.push('## Per-strategy attribution');
  L.push('');
  L.push('| Strategy | Trades | Hit | Gross | Charges | Net |');
  L.push('|---|--:|--:|--:|--:|--:|');
  for (const a of r.byStrategy) {
    L.push(`| ${a.strategyId} | ${a.trades} | ${pct(a.hitRate)} | ${inr(a.grossPaise)} | ${inr(a.chargesPaise)} | ${inr(a.netPaise)} |`);
  }
  if (r.byStrategy.length === 0) L.push('| _(no trades)_ | | | | | |');
  L.push('');

  L.push('## Exits');
  L.push('');
  L.push('| Reason | Count | Net |');
  L.push('|---|--:|--:|');
  for (const e of r.byExitReason) L.push(`| ${e.reason} | ${e.count} | ${inr(e.netPaise)} |`);
  if (r.byExitReason.length === 0) L.push('| _(none)_ | | |');
  L.push('');

  L.push('## Latency (internal tick→order)');
  L.push('');
  if (r.latency !== undefined) {
    const h = r.latency.hopAvgMicros;
    L.push(`- samples: ${r.latency.samples}`);
    L.push(`- total p50 / p99 / max: ${r.latency.totalP50Ms} / ${r.latency.totalP99Ms} / ${r.latency.totalMaxMs} ms`);
    L.push(`- hop avg (µs): features ${h.features} · signal ${h.signal} · risk ${h.risk} · sent ${h.sent}`);
  } else {
    L.push('_No latency samples (no orders reached t_sent this session)._');
  }
  L.push('');

  L.push('## Max adverse excursion');
  L.push('');
  if (r.mae !== undefined) {
    L.push(`- worst single-trade MAE: ${inr(r.mae.worstPaise)}`);
    L.push(`- average MAE: ${inr(r.mae.avgPaise)}`);
    L.push(`- coverage: ${r.mae.covered}/${r.mae.covered + r.mae.uncovered} trades had tick data`);
    if (r.mae.uncovered > 0) L.push(`  - ${r.mae.uncovered} trade(s) N/A — session recorded no ticks for the instrument.`);
  } else {
    L.push('_No trades._');
  }
  L.push('');

  L.push('## Trades');
  L.push('');
  L.push('| # | Strategy | Instrument | Qty | Entry | Exit | Gross | Charges | Net | MAE | Exit | Hold |');
  L.push('|--:|---|---|--:|--:|--:|--:|--:|--:|--:|---|--:|');
  r.trades.forEach((t, i) => {
    const mae = t.maePaise !== undefined ? inr(t.maePaise) : 'N/A';
    L.push(
      `| ${i + 1} | ${t.strategyId} | ${t.instrumentId} | ${t.qty} | ${inr(t.entryPricePaise)} | ${inr(t.exitPricePaise)} | ` +
        `${inr(t.grossPnlPaise)} | ${inr(t.chargesPaise)} | ${inr(t.netPnlPaise)} | ${mae} | ${t.exitReason} | ${(t.holdMs / 1000).toFixed(1)}s |`,
    );
  });
  if (r.trades.length === 0) L.push('| _(no trades)_ | | | | | | | | | | | |');
  L.push('');

  return L.join('\n');
}

const CSV_HEADER = [
  'tradeId',
  'strategyId',
  'instrumentId',
  'qty',
  'entryTs',
  'exitTs',
  'entryPricePaise',
  'exitPricePaise',
  'grossPnlPaise',
  'chargesPaise',
  'netPnlPaise',
  'maePaise',
  'exitReason',
  'holdMs',
];

export function renderTradesCsv(r: DigestReport): string {
  const lines = [CSV_HEADER.join(',')];
  for (const t of r.trades) {
    lines.push(
      [
        t.tradeId,
        t.strategyId,
        t.instrumentId,
        t.qty,
        t.entryTs,
        t.exitTs,
        t.entryPricePaise,
        t.exitPricePaise,
        t.grossPnlPaise,
        t.chargesPaise,
        t.netPnlPaise,
        t.maePaise ?? '',
        csvField(t.exitReason),
        t.holdMs,
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface DigestArtifacts {
  mdPath: string;
  csvPath: string;
}

/** Write digest.md + trades.csv into `dir` (created if missing). */
export async function writeDigest(report: DigestReport, dir: string): Promise<DigestArtifacts> {
  await mkdir(dir, { recursive: true });
  const mdPath = join(dir, 'digest.md');
  const csvPath = join(dir, 'trades.csv');
  await writeFile(mdPath, renderDigestMarkdown(report), 'utf8');
  await writeFile(csvPath, renderTradesCsv(report), 'utf8');
  return { mdPath, csvPath };
}
