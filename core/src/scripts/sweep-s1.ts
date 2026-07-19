/**
 * Phase C: Parameter sweep for S1 Momentum-Burst.
 *
 * Sweeps the 4-dimensional param grid over the clean recorded days.
 * Pre-loads tick arrays once per day, then runs each combo via a fresh host.
 *
 * Output: journals/s1-sweep/sweep-results.json
 *
 * Usage: node dist/scripts/sweep-s1.js [--days 2026-07-16]
 *
 * ⚠  HONESTY CAVEAT: only 1 clean replayable day (Jul 16) exists.
 *    All results are IN-SAMPLE (at most 1 trade per combo).
 *    Do not promote any combo to production without 2-week forward paper validation.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadTicksFromGz, runReplay } from './replay-s1.js';

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SWEEP_ROOT = join(SCALPER_ROOT, 'journals', 's1-sweep');

// ─── sweep grid ───────────────────────────────────────────────────────────────

const CLEAN_DAYS = ['2026-07-16'];

const ATR_MULT_VALUES = [1, 1.5, 2, 3, 0];        // 0 = disabled (no underlying stop)
const TIME_STOP_VALUES = [90, 150, 240];
const IMPULSE_PCT_VALUES = [0.00025, 0.00035, 0.0005];
const CONFIRM_TICK_VALUES = [2, 3, 4];

// ─── types ───────────────────────────────────────────────────────────────────

interface SweepCombo {
  atrMult: number;
  timeStopSec: number;
  impulsePct: number;
  confirmTicks: number;
}

interface DayResult {
  date: string;
  tradeCount: number;
  wins: number;
  losses: number;
  netPaise: number;
  grossPaise: number;
  chargesPaise: number;
  avgHoldMs: number;
}

interface ComboResult extends SweepCombo {
  key: string;
  days: DayResult[];
  totalTrades: number;
  totalWins: number;
  totalNetPaise: number;
  totalGrossPaise: number;
  totalChargesPaise: number;
  hitRate: number;
  avgHoldMs: number;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function comboKey(c: SweepCombo): string {
  return `atr${c.atrMult}_t${c.timeStopSec}_imp${c.impulsePct.toFixed(5)}_ctk${c.confirmTicks}`;
}

function allCombos(): SweepCombo[] {
  const combos: SweepCombo[] = [];
  for (const atrMult of ATR_MULT_VALUES) {
    for (const timeStopSec of TIME_STOP_VALUES) {
      for (const impulsePct of IMPULSE_PCT_VALUES) {
        for (const confirmTicks of CONFIRM_TICK_VALUES) {
          combos.push({ atrMult, timeStopSec, impulsePct, confirmTicks });
        }
      }
    }
  }
  return combos;
}

function fmt(paise: number): string {
  const sign = paise >= 0 ? '+' : '';
  return `${sign}₹${(paise / 100).toFixed(2)}`;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const daysArg = args.filter((_, i) => args[i - 1] === '--days');
  const days = daysArg.length > 0 ? daysArg : CLEAN_DAYS;

  const combos = allCombos();
  const totalRuns = combos.length * days.length;

  console.log('S1 Parameter Sweep');
  console.log(`Combos: ${combos.length}  |  Days: ${days.join(', ')}  |  Total runs: ${totalRuns}`);
  console.log('='.repeat(70));

  // Pre-validate tick files exist and are readable.
  const TICK_ROOT = join(SCALPER_ROOT, 'data', 'dhan', 'ticks-s1-momentum-burst');
  for (const date of days) {
    const tickPath = join(TICK_ROOT, date, 'ticks.jsonl.gz');
    const ticks = await loadTicksFromGz(tickPath);
    if (ticks.length === 0) {
      console.error(`No ticks available for ${date} — skipping this day.`);
      days.splice(days.indexOf(date), 1);
    } else {
      console.log(`Pre-loaded: ${date} → ${ticks.length} ticks ✓`);
    }
  }

  if (days.length === 0) {
    console.error('No usable days. Exiting.');
    process.exitCode = 1;
    return;
  }

  mkdirSync(SWEEP_ROOT, { recursive: true });

  const results: ComboResult[] = [];
  let done = 0;
  const startMs = Date.now();

  for (const combo of combos) {
    const key = comboKey(combo);
    const dayResults: DayResult[] = [];

    for (const date of days) {
      const journalDir = join(tmpdir(), `scalper-sweep-${key}-${date}`);

      try {
        const r = await runReplay({
          date,
          params: {
            atrMult: combo.atrMult,
            timeStopSec: combo.timeStopSec,
            impulsePct: combo.impulsePct,
            confirmTicks: combo.confirmTicks,
          },
          journalDir,
          silent: true,
        });
        dayResults.push({
          date,
          tradeCount: r.tradeCount,
          wins: r.wins,
          losses: r.losses,
          netPaise: r.netPaise,
          grossPaise: r.grossPaise,
          chargesPaise: r.chargesPaise,
          avgHoldMs: r.avgHoldMs,
        });
      } catch (err) {
        console.error(`  [ERROR] combo=${key} date=${date}: ${String(err)}`);
        dayResults.push({ date, tradeCount: 0, wins: 0, losses: 0, netPaise: 0, grossPaise: 0, chargesPaise: 0, avgHoldMs: 0 });
      }
    }

    const totalTrades = dayResults.reduce((s, d) => s + d.tradeCount, 0);
    const totalWins = dayResults.reduce((s, d) => s + d.wins, 0);
    const totalNetPaise = dayResults.reduce((s, d) => s + d.netPaise, 0);
    const totalGrossPaise = dayResults.reduce((s, d) => s + d.grossPaise, 0);
    const totalChargesPaise = dayResults.reduce((s, d) => s + d.chargesPaise, 0);
    const weightedHold = dayResults.reduce((s, d) => s + d.avgHoldMs * d.tradeCount, 0);

    results.push({
      ...combo,
      key,
      days: dayResults,
      totalTrades,
      totalWins,
      totalNetPaise,
      totalGrossPaise,
      totalChargesPaise,
      hitRate: totalTrades > 0 ? totalWins / totalTrades : 0,
      avgHoldMs: totalTrades > 0 ? weightedHold / totalTrades : 0,
    });

    done++;
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const pct = ((done / combos.length) * 100).toFixed(0);
    process.stdout.write(`\r  Progress: ${done}/${combos.length} (${pct}%)  [${elapsed}s]   `);
  }

  console.log('\n');

  // Sort by net P&L descending.
  results.sort((a, b) => b.totalNetPaise - a.totalNetPaise);

  // Write JSON.
  const outPath = join(SWEEP_ROOT, 'sweep-results.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Results written to: ${outPath}`);

  // Print top 15.
  console.log('\nTop 15 combos by net P&L:');
  console.log(
    ['Rank', 'atrMult', 'timeStp', 'impPct', 'ctk', 'trades', 'wins', 'net'].map((h) => h.padEnd(10)).join(''),
  );
  console.log('-'.repeat(80));
  for (const [i, r] of results.slice(0, 15).entries()) {
    console.log(
      [
        `#${i + 1}`.padEnd(10),
        String(r.atrMult).padEnd(10),
        String(r.timeStopSec).padEnd(10),
        r.impulsePct.toFixed(5).padEnd(10),
        String(r.confirmTicks).padEnd(10),
        String(r.totalTrades).padEnd(10),
        String(r.totalWins).padEnd(10),
        fmt(r.totalNetPaise),
      ].join(''),
    );
  }

  // Baseline row.
  const baseline = results.find(
    (r) => r.atrMult === 1 && r.timeStopSec === 90 && r.impulsePct === 0.00035 && r.confirmTicks === 3,
  );
  if (baseline) {
    console.log(`\nBaseline (current config): net=${fmt(baseline.totalNetPaise)}  trades=${baseline.totalTrades}`);
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log('⚠  HONESTY CAVEATS:');
  console.log(`   · Only ${days.length} day(s) of clean tick data — all results are IN-SAMPLE.`);
  console.log('   · With ≤1 trade per combo, ranking is statistically meaningless.');
  console.log('   · Treat the top combo as a HYPOTHESIS only.');
  console.log('   · Mandatory next step: run top-3 combos in live paper for ≥2 weeks');
  console.log('     before changing config/s1-momentum-burst.json.');
  console.log('─'.repeat(70));
}

void main().catch((err) => {
  console.error('sweep-s1 failed:', err);
  process.exitCode = 1;
});
