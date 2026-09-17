/**
 * Tick-corpus audit.
 *
 * Before widening a backtest across corpora, check each one actually carries
 * what the study needs and is REAL recorded book rather than candle-derived
 * synthetic ticks. The backfill helper (fetch_dhan_atm4_history.py) fabricates
 * quotes as ltp±5 paise, so a corpus built from it has a constant 10-paise
 * spread and would silently erase the transaction-cost effect under study.
 *
 * Usage:
 *   node dist/scripts/audit-corpus.js [--dates 3] [--corpus NAME]
 */

import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type { InstrumentId } from '../domain/ids.js';
import { loadScripMaster, type ScripRow } from '../marketdata/instrument-master.js';
import { makeInstrumentId } from '../domain/ids.js';
import { listTickParts, loadTicksForDate, resolveScripMasterPath } from './backtest-recording.js';

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DATA_ROOT = join(SCALPER_ROOT, 'data', 'dhan');

interface DayAudit {
  date: string;
  ticks: number;
  optionTicks: number;
  instruments: number;
  strikes: number;
  strikeSpanPts: number;
  expiries: string[];
  quotedPct: number;
  spreadP50Pct: number;
  distinctSpreads: number;
  /** Candle-derived corpora show one constant spread and no depth. */
  looksSynthetic: boolean;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function sampleDates(dir: string, want: number): string[] {
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && listTickParts(join(dir, n)).length > 0)
    .sort();
  if (all.length <= want) return all;
  // First, last, and evenly spaced between — a corpus can change format midway.
  const out = new Set<string>([all[0]!, all[all.length - 1]!]);
  for (let i = 1; i < want - 1; i++) {
    out.add(all[Math.floor((i * (all.length - 1)) / (want - 1))]!);
  }
  return [...out].sort();
}

async function auditDay(dir: string, date: string): Promise<DayAudit> {
  const ticks = await loadTicksForDate(join(dir, date));
  const master: ScripRow[] = loadScripMaster(resolveScripMasterPath(date));
  const rowsById = new Map(master.map((r) => [makeInstrumentId('NSE', r.securityId), r]));

  const instruments = new Set<InstrumentId>();
  const strikes = new Set<number>();
  const expiries = new Set<string>();
  const spreadPct: number[] = [];
  const spreadsAbs = new Set<number>();
  let optionTicks = 0;
  let quoted = 0;

  for (const t of ticks) {
    const row = rowsById.get(t.instrumentId);
    if (row === undefined || (row.optionType !== 'CE' && row.optionType !== 'PE')) continue;
    optionTicks++;
    instruments.add(t.instrumentId);
    strikes.add(row.strikePaise);
    expiries.add(row.expiryDate);
    if (t.bidPaise > 0 && t.askPaise > t.bidPaise) {
      quoted++;
      const mid = (t.bidPaise + t.askPaise) / 2;
      spreadPct.push(((t.askPaise - t.bidPaise) / mid) * 100);
      if (spreadsAbs.size < 5_000) spreadsAbs.add(t.askPaise - t.bidPaise);
    }
  }

  spreadPct.sort((a, b) => a - b);
  const strikeList = [...strikes].sort((a, b) => a - b);
  const span =
    strikeList.length > 1 ? ((strikeList[strikeList.length - 1]! - strikeList[0]!) / 100) : 0;

  return {
    date,
    ticks: ticks.length,
    optionTicks,
    instruments: instruments.size,
    strikes: strikes.size,
    strikeSpanPts: span,
    expiries: [...expiries].sort(),
    quotedPct: optionTicks > 0 ? (100 * quoted) / optionTicks : 0,
    spreadP50Pct: percentile(spreadPct, 50),
    distinctSpreads: spreadsAbs.size,
    // The backfill writes bid=ltp-5, ask=ltp+5 for every tick: exactly one
    // distinct absolute spread across a whole session is the fingerprint.
    looksSynthetic: spreadsAbs.size <= 2 && quoted > 0,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantIdx = argv.indexOf('--dates');
  const want = wantIdx >= 0 ? Number(argv[wantIdx + 1] ?? 3) : 3;
  const onlyIdx = argv.indexOf('--corpus');
  const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] ?? '') : undefined;

  const corpora = readdirSync(DATA_ROOT)
    .filter((n) => n.startsWith('ticks'))
    .filter((n) => only === undefined || n === only)
    .sort();

  for (const corpus of corpora) {
    const dir = join(DATA_ROOT, corpus);
    const dates = sampleDates(dir, want);
    const all = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    console.log('');
    console.log(`## ${corpus} — ${all.length} days [${all[0] ?? '-'} .. ${all[all.length - 1] ?? '-'}]`);
    if (dates.length === 0) {
      console.log('   (no loadable days)');
      continue;
    }
    console.log(`   date        optTicks  instr  strikes  span  quoted%  spreadP50  distinct  verdict`);
    for (const date of dates) {
      try {
        const a = await auditDay(dir, date);
        console.log(
          `   ${a.date}  ${String(a.optionTicks).padStart(8)}  ${String(a.instruments).padStart(5)}  ` +
            `${String(a.strikes).padStart(7)}  ${String(a.strikeSpanPts).padStart(4)}  ` +
            `${a.quotedPct.toFixed(1).padStart(6)}%  ${a.spreadP50Pct.toFixed(3).padStart(8)}%  ` +
            `${String(a.distinctSpreads).padStart(8)}  ${a.looksSynthetic ? 'SYNTHETIC' : 'real'}`,
        );
      } catch (err) {
        console.log(`   ${date}  — failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log('');
}

void main().catch((err) => {
  console.error('audit-corpus failed:', err);
  process.exitCode = 1;
});
