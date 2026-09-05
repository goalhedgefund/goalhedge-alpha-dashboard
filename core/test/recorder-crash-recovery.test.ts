import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../src/feed/recorder.js';
import { listTickParts, loadTicksForDate } from '../src/scripts/backtest-recording.js';
import type { Tick } from '../src/domain/marketdata.js';
import { makeInstrumentId } from '../src/domain/ids.js';

const INSTR = makeInstrumentId('NSE', '12345');

function tick(ts: number): Tick {
  return {
    instrumentId: INSTR, ts, recvTs: ts, ltpPaise: 10_000 + ts,
    qty: 1, volume: ts, bidPaise: 9_995, askPaise: 10_005, bidQty: 1, askQty: 1,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rec-crash-'));
}

/**
 * Regression: the recorder used to open the day's file with flags:'a' and pipe
 * a fresh gzip into it on every process start. A run killed before close()
 * left a member truncated mid-deflate-block, and everything a later run
 * appended after that truncation was unreachable — a decoder stops at the
 * corruption. That silently destroyed most of the July 2026 corpus.
 */
describe('recorder survives a process killed without close()', () => {
  it('a second run writes its own part instead of appending into a broken file', async () => {
    const dir = tmp();

    // Run 1: record and flush, but never close — the crash case.
    const first = new Recorder({ dir, maxBufferedLines: 4 });
    for (let i = 1; i <= 12; i++) first.record(tick(i));

    // Run 2: same directory, new process.
    const second = new Recorder({ dir, maxBufferedLines: 4 });
    for (let i = 100; i <= 111; i++) second.record(tick(i));
    await second.close();

    expect(second.path).not.toBe(first.path);
    expect(second.path.endsWith('.gz')).toBe(true);

    const parts = listTickParts(dir);
    expect(parts.length).toBe(2);

    // Run 2's ticks must be fully recoverable regardless of run 1's state.
    const ticks = await loadTicksForDate(dir);
    const tsSeen = new Set(ticks.map((t) => t.ts));
    for (let i = 100; i <= 111; i++) expect(tsSeen.has(i)).toBe(true);
  });

  it('sync-flushed data from an unclosed recorder is still readable', async () => {
    const dir = tmp();
    const rec = new Recorder({ dir, maxBufferedLines: 4 });
    // 12 ticks with maxBuf 4 => 3 flushes, each Z_SYNC_FLUSHed. Never closed.
    for (let i = 1; i <= 12; i++) rec.record(tick(i));

    // Give the gzip/file streams a turn to drain the sync-flushed bytes.
    await new Promise((r) => setTimeout(r, 50));

    const ticks = await loadTicksForDate(dir);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]?.ts).toBe(1);
  });

  it('parts load in write order, and a single-file day still loads', async () => {
    const dir = tmp();
    const a = new Recorder({ dir, maxBufferedLines: 2 });
    for (let i = 1; i <= 6; i++) a.record(tick(i));
    await a.close();

    const single = await loadTicksForDate(dir);
    expect(single.map((t) => t.ts)).toEqual([1, 2, 3, 4, 5, 6]);

    const b = new Recorder({ dir, maxBufferedLines: 2 });
    for (let i = 7; i <= 10; i++) b.record(tick(i));
    await b.close();

    const both = await loadTicksForDate(dir);
    expect(both.map((t) => t.ts)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
