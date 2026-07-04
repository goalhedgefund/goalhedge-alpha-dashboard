import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../src/domain/events.js';
import { makeInstrumentId, makeSessionId, type ClientOrderId, type InstrumentId, type TradeId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import type { Trade } from '../src/domain/positions.js';
import { buildDigest, renderDigestMarkdown, renderTradesCsv, writeDigest } from '../src/report/digest.js';

const SESSION = makeSessionId('2026-07-04', 'paper');
const CE1 = makeInstrumentId('NSE', 'CE1');
const PE1 = makeInstrumentId('NSE', 'PE1');
const CE2 = makeInstrumentId('NSE', 'CE2');

let seq = 0;
function ev<T extends JournalEvent['type']>(type: T, payload: Extract<JournalEvent, { type: T }>['payload'], ts = 0): JournalEvent {
  return { seq: ++seq, ts, type, payload } as JournalEvent;
}

function mkTrade(o: {
  id: string;
  strategyId: string;
  instrumentId: InstrumentId;
  entryPricePaise: number;
  exitPricePaise: number;
  entryTs: number;
  exitTs: number;
  grossPnlPaise: number;
  components: Array<{ name: string; paise: number }>;
  exitReason: string;
}): Trade {
  const chargesTotal = o.components.reduce((s, c) => s + c.paise, 0);
  const qty = 75;
  return {
    tradeId: o.id as TradeId,
    sessionId: SESSION,
    strategyId: o.strategyId,
    instrumentId: o.instrumentId,
    qty,
    entry: { side: 'BUY', qty, pricePaise: o.entryPricePaise, ts: o.entryTs, clientOrderId: `${o.id}-e` as ClientOrderId },
    exit: { side: 'SELL', qty, pricePaise: o.exitPricePaise, ts: o.exitTs, clientOrderId: `${o.id}-x` as ClientOrderId },
    grossPnlPaise: o.grossPnlPaise,
    charges: { totalPaise: chargesTotal, components: o.components },
    netPnlPaise: o.grossPnlPaise - chargesTotal,
    exitReason: o.exitReason,
    holdMs: o.exitTs - o.entryTs,
  };
}

function mkTick(instrumentId: InstrumentId, ts: number, ltpPaise: number): Tick {
  return { instrumentId, ts, recvTs: ts, ltpPaise, qty: 75, volume: 1, bidPaise: ltpPaise - 5, askPaise: ltpPaise + 5, bidQty: 1, askQty: 1 };
}

/** Three hand-computed trades: two S1 (win+loss), one S2 (win). */
function scriptedJournal(): JournalEvent[] {
  seq = 0;
  const tradeA = mkTrade({
    id: 'trd-A', strategyId: 's1', instrumentId: CE1, entryPricePaise: 15_000, exitPricePaise: 16_200,
    entryTs: 1_000, exitTs: 5_000, grossPnlPaise: 90_000,
    components: [{ name: 'STT', paise: 100 }, { name: 'Exchange txn', paise: 50 }, { name: 'GST', paise: 27 }],
    exitReason: 'L2_TRAIL',
  });
  const tradeB = mkTrade({
    id: 'trd-B', strategyId: 's1', instrumentId: PE1, entryPricePaise: 10_000, exitPricePaise: 9_600,
    entryTs: 2_000, exitTs: 6_000, grossPnlPaise: -30_000,
    components: [{ name: 'STT', paise: 40 }, { name: 'Exchange txn', paise: 20 }, { name: 'GST', paise: 11 }],
    exitReason: 'L1_HARD_STOP',
  });
  const tradeC = mkTrade({
    id: 'trd-C', strategyId: 's2', instrumentId: CE2, entryPricePaise: 8_000, exitPricePaise: 8_600,
    entryTs: 3_000, exitTs: 7_000, grossPnlPaise: 45_000,
    components: [{ name: 'STT', paise: 60 }, { name: 'Exchange txn', paise: 30 }, { name: 'GST', paise: 16 }],
    exitReason: 'L2_TRAIL',
  });

  return [
    ev('session.started', {
      session: { sessionId: SESSION, mode: 'paper', date: '2026-07-04', phase: 'OPEN', configHashes: {}, startedTs: 0 },
    }),
    // MAE tick coverage for A (CE1) and B (PE1); C (CE2) has none → uncovered.
    ev('md.tick', { tick: mkTick(CE1, 1_000, 15_000) }),
    ev('md.tick', { tick: mkTick(CE1, 2_000, 14_800) }), // A's worst: -200 * 75 = 15,000p
    ev('md.tick', { tick: mkTick(CE1, 3_000, 15_500) }),
    ev('md.tick', { tick: mkTick(PE1, 2_500, 10_000) }),
    ev('md.tick', { tick: mkTick(PE1, 3_500, 9_500) }), // B's worst: -500 * 75 = 37,500p
    ev('md.tick', { tick: mkTick(PE1, 5_000, 9_700) }),
    ev('trade.completed', { trade: tradeA }),
    ev('trade.completed', { trade: tradeB }),
    ev('trade.completed', { trade: tradeC }),
    ev('latency.sample', { hops: { features: 2_000, signal: 100, risk: 200, sent: 50, total: 2_350 } }),
    ev('latency.sample', { hops: { features: 3_000, signal: 150, risk: 250, sent: 60, total: 3_460 } }),
  ];
}

describe('daily digest (01-DESIGN §8)', () => {
  it('summary + hit rate', () => {
    const r = buildDigest(scriptedJournal());
    expect(r.mode).toBe('paper');
    expect(r.date).toBe('2026-07-04');
    expect(r.summary.tradeCount).toBe(3);
    expect(r.summary.wins).toBe(2);
    expect(r.summary.losses).toBe(1);
    expect(r.summary.hitRate).toBeCloseTo(2 / 3, 6);
    expect(r.summary.grossPaise).toBe(105_000);
    expect(r.summary.chargesPaise).toBe(354);
    expect(r.summary.netPaise).toBe(104_646);
    // Money conservation: net === gross − charges.
    expect(r.summary.netPaise).toBe(r.summary.grossPaise - r.summary.chargesPaise);
    // Realized give-back: peak 89,823 (after A) → 59,752 (after B) = 30,071.
    expect(r.summary.maxGiveBackPaise).toBe(30_071);
  });

  it('gross→charges→net waterfall aggregates components by name and reconciles', () => {
    const r = buildDigest(scriptedJournal());
    expect(r.waterfall).toEqual([
      { label: 'Gross P&L', paise: 105_000, kind: 'gross' },
      { label: 'STT', paise: -200, kind: 'charge' },
      { label: 'Exchange txn', paise: -100, kind: 'charge' },
      { label: 'GST', paise: -54, kind: 'charge' },
      { label: 'Net P&L', paise: 104_646, kind: 'net' },
    ]);
    const chargeSum = r.waterfall.filter((w) => w.kind === 'charge').reduce((s, w) => s + w.paise, 0);
    expect(105_000 + chargeSum).toBe(104_646);
  });

  it('per-strategy attribution, sorted by net desc', () => {
    const r = buildDigest(scriptedJournal());
    expect(r.byStrategy.map((a) => a.strategyId)).toEqual(['s1', 's2']);
    const s1 = r.byStrategy[0]!;
    expect(s1).toMatchObject({ trades: 2, wins: 1, grossPaise: 60_000, chargesPaise: 248, netPaise: 59_752 });
    expect(s1.hitRate).toBeCloseTo(0.5, 6);
    const s2 = r.byStrategy[1]!;
    expect(s2).toMatchObject({ trades: 1, wins: 1, grossPaise: 45_000, netPaise: 44_894 });
  });

  it('exits grouped by reason', () => {
    const r = buildDigest(scriptedJournal());
    expect(r.byExitReason).toEqual([
      { reason: 'L2_TRAIL', count: 2, netPaise: 89_823 + 44_894 },
      { reason: 'L1_HARD_STOP', count: 1, netPaise: -30_071 },
    ]);
  });

  it('latency digest from latency.sample events', () => {
    const r = buildDigest(scriptedJournal());
    expect(r.latency).toBeDefined();
    expect(r.latency!.samples).toBe(2);
    // totals in ms: [2.35, 3.46]; nearest-rank p50=2.35, p99=3.46.
    expect(r.latency!.totalP50Ms).toBe(2.35);
    expect(r.latency!.totalP99Ms).toBe(3.46);
    expect(r.latency!.hopAvgMicros.features).toBe(2_500);
  });

  it('MAE from ticks; trades without tick coverage are N/A', () => {
    const r = buildDigest(scriptedJournal());
    expect(r.trades[0]!.maePaise).toBe(15_000); // A
    expect(r.trades[1]!.maePaise).toBe(37_500); // B
    expect(r.trades[2]!.maePaise).toBeUndefined(); // C — no ticks
    expect(r.mae).toMatchObject({ covered: 2, uncovered: 1, worstPaise: 37_500, avgPaise: 26_250 });
  });

  it('renders markdown + CSV and writes both files', async () => {
    const r = buildDigest(scriptedJournal());
    const md = renderDigestMarkdown(r);
    expect(md).toContain('# Daily Digest — 2026-07-04 (PAPER)');
    expect(md).toContain('Net P&L');
    expect(md).toContain('₹1,046.46'); // net 104,646 paise, Indian grouping

    const csv = renderTradesCsv(r);
    const rows = csv.trim().split('\n');
    expect(rows[0]).toContain('tradeId,strategyId');
    expect(rows).toHaveLength(4); // header + 3 trades
    expect(rows[1]).toContain('trd-A,s1');
    expect(rows[3]!.split(',')[11]).toBe(''); // trade C maePaise blank (N/A)

    const dir = await mkdtemp(join(tmpdir(), 'digest-'));
    const { mdPath, csvPath } = await writeDigest(r, dir);
    expect(await readFile(mdPath, 'utf8')).toBe(md);
    expect(await readFile(csvPath, 'utf8')).toBe(csv);
  });

  it('empty journal → zero-trade digest, no crash', () => {
    const r = buildDigest([]);
    expect(r.summary.tradeCount).toBe(0);
    expect(r.summary.hitRate).toBe(0);
    expect(r.latency).toBeUndefined();
    expect(r.mae).toBeUndefined();
    expect(renderDigestMarkdown(r)).toContain('_(no trades)_');
  });
});
