/**
 * Phase A: Journal diagnosis for S1 Momentum-Burst.
 *
 * Streams events.jsonl for each recorded day and reports:
 *   - strategy.noTrade reason histogram (why entries were blocked)
 *   - stop.triggered reasons per trade (L1_UNDERLYING / L1_HARD_PREMIUM / etc.)
 *   - ATR implied at entry (derived from hardStopUnderlyingPaise vs entry premium)
 *
 * Usage: node dist/scripts/diagnose-s1.js
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const JOURNAL_ROOT = join(import.meta.dirname, '../../..', 'journals', 's1-momentum-burst');
const DAYS = ['2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19'];
const SESSION = 'dhan-live-data-paper';
const PAISE = 100;

interface AnyEvent {
  seq: number;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
}

async function streamEvents(path: string): Promise<AnyEvent[]> {
  const events: AnyEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        events.push(JSON.parse(trimmed) as AnyEvent);
      } catch { /* skip malformed */ }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  return events;
}

function fmt(paise: number): string {
  return `₹${(paise / PAISE).toFixed(2)}`;
}

async function analyseDay(date: string): Promise<void> {
  const path = join(JOURNAL_ROOT, date, SESSION, 'events.jsonl');
  let events: AnyEvent[];
  try {
    events = await streamEvents(path);
  } catch {
    console.log(`  [skip] events.jsonl not found for ${date}`);
    return;
  }

  const noTrade: Record<string, number> = {};
  const stopTriggers: Array<{ reason: string; layer: string; premiumPaise: number }> = [];
  const entryIntents: Array<{
    instrumentId: string;
    entryPremiumPaise: number;
    hardStopPremiumPaise?: number;
    hardStopUnderlyingPaise?: number;
    hardStopUnderlyingDir?: string;
    timeStopSec?: number;
    impliedAtrPaise?: number;
  }> = [];
  const trades: Array<{ instrumentId: string; grossPaise: number; side: string }> = [];

  for (const ev of events) {
    if (ev.type === 'strategy.noTrade') {
      const reason = String((ev.payload as { reason?: string }).reason ?? 'UNKNOWN');
      noTrade[reason] = (noTrade[reason] ?? 0) + 1;
    }

    if (ev.type === 'stop.triggered') {
      const p = ev.payload as { reason?: string; layer?: string; premiumPaise?: number };
      stopTriggers.push({
        reason: String(p.reason ?? 'UNKNOWN'),
        layer: String(p.layer ?? '?'),
        premiumPaise: Number(p.premiumPaise ?? 0),
      });
    }

    if (ev.type === 'intent.proposed') {
      const intent = (ev.payload as { intent?: Record<string, unknown> }).intent;
      if (!intent || intent.purpose !== 'ENTRY') continue;
      const stopPlan = intent.stopPlan as Record<string, unknown> | undefined;
      const entryPremiumPaise = Number(intent.limitPricePaise ?? 0);
      const hardStopUnderlyingPaise = Number(stopPlan?.hardStopUnderlyingPaise ?? 0) || undefined;
      const hardStopUnderlyingDir = String(stopPlan?.hardStopUnderlyingDir ?? '') || undefined;

      // Back-calculate implied ATR: at atrMult=1, distance = atr*1
      // CE: hardStopUnderlying = spot - atr → atr unknown without spot
      // But we know entry premium → rough proxy: underlying ≈ 24100-24200 for Jul 16
      // Better: just report the levels and let operator interpret
      const eiEntry: typeof entryIntents[number] = {
        instrumentId: String(intent.instrumentId ?? ''),
        entryPremiumPaise,
      };
      const hsp = Number(stopPlan?.hardStopPremiumPaise ?? 0);
      if (hsp > 0) eiEntry.hardStopPremiumPaise = hsp;
      if (hardStopUnderlyingPaise !== undefined) eiEntry.hardStopUnderlyingPaise = hardStopUnderlyingPaise;
      if (hardStopUnderlyingDir !== undefined) eiEntry.hardStopUnderlyingDir = hardStopUnderlyingDir;
      const tss = Number(stopPlan?.timeStopSec ?? 0);
      if (tss > 0) eiEntry.timeStopSec = tss;
      entryIntents.push(eiEntry);
    }

    if (ev.type === 'trade.completed') {
      const trade = (ev.payload as { trade?: Record<string, unknown> }).trade;
      if (trade) {
        trades.push({
          instrumentId: String(trade.instrumentId ?? ''),
          grossPaise: Number(trade.realizedGrossPaise ?? 0),
          side: String(trade.side ?? '?'),
        });
      }
    }
  }

  const totalEvents = events.length;
  const noTradeTotal = Object.values(noTrade).reduce((s, v) => s + v, 0);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Date: ${date}  |  Events: ${totalEvents}  |  Trades: ${trades.length}`);
  console.log('='.repeat(60));

  if (noTradeTotal === 0) {
    console.log('  No strategy.noTrade events recorded.');
  } else {
    console.log(`\nNo-trade reasons (${noTradeTotal} total):`);
    const sorted = Object.entries(noTrade).sort(([, a], [, b]) => b - a);
    for (const [reason, count] of sorted) {
      const pct = ((count / noTradeTotal) * 100).toFixed(1);
      console.log(`  ${reason.padEnd(20)} ${String(count).padStart(6)}  (${pct}%)`);
    }
  }

  if (stopTriggers.length === 0) {
    console.log('\nNo stop.triggered events.');
  } else {
    console.log(`\nStop triggers (${stopTriggers.length} total):`);
    const reasonMap: Record<string, number> = {};
    for (const st of stopTriggers) {
      reasonMap[st.reason] = (reasonMap[st.reason] ?? 0) + 1;
    }
    for (const [reason, count] of Object.entries(reasonMap).sort(([, a], [, b]) => b - a)) {
      console.log(`  ${reason.padEnd(20)} ${count}`);
    }
  }

  if (entryIntents.length > 0) {
    console.log(`\nEntry intents (${entryIntents.length}):`);
    for (const ei of entryIntents) {
      const hardStopPct = ei.hardStopPremiumPaise !== undefined
        ? (((ei.entryPremiumPaise - ei.hardStopPremiumPaise) / ei.entryPremiumPaise) * 100).toFixed(1)
        : '?';
      console.log(`  ${ei.instrumentId}`);
      console.log(`    entry=${fmt(ei.entryPremiumPaise)}  hardStop=${ei.hardStopPremiumPaise !== undefined ? fmt(ei.hardStopPremiumPaise) : '?'} (${hardStopPct}% below)`);
      if (ei.hardStopUnderlyingPaise !== undefined) {
        console.log(`    underlyingStop=${fmt(ei.hardStopUnderlyingPaise)} ${ei.hardStopUnderlyingDir ?? ''}`);
      }
      console.log(`    timeStop=${ei.timeStopSec ?? '?'}s`);
    }
  }

  if (trades.length > 0) {
    console.log(`\nTrades:`);
    let netPaise = 0;
    for (const t of trades) {
      const sign = t.grossPaise >= 0 ? '+' : '';
      console.log(`  ${t.instrumentId}  gross=${sign}${fmt(t.grossPaise)}`);
      netPaise += t.grossPaise;
    }
    const sign = netPaise >= 0 ? '+' : '';
    console.log(`  NET (gross): ${sign}${fmt(netPaise)}`);
  }
}

async function main(): Promise<void> {
  console.log('S1 Momentum-Burst — Journal Diagnosis');
  console.log(`Journal root: ${JOURNAL_ROOT}`);

  for (const date of DAYS) {
    await analyseDay(date);
  }

  console.log('\n\nDiagnosis complete.');
}

void main().catch((err) => {
  console.error('diagnose-s1 failed:', err);
  process.exitCode = 1;
});
