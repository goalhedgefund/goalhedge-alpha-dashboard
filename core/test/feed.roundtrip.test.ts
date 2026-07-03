import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeInstrumentId } from '../src/domain/ids.js';
import { ManualClock } from '../src/domain/time.js';
import type { Tick } from '../src/domain/marketdata.js';
import { Recorder } from '../src/feed/recorder.js';
import { ReplayFeed } from '../src/feed/replay.js';
import { SynthFeed } from '../src/feed/synth.js';
import { BarBuilder } from '../src/feed/bar-builder.js';

const INSTR = makeInstrumentId('NSE', '35022');

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'scalper-feed-'));
}

// ---------------------------------------------------------------------------
// Replay determinism (M3 acceptance)
// ---------------------------------------------------------------------------

describe('ReplayFeed determinism (M3 acceptance)', () => {
  it('same tick file → identical tick sequences on two independent replays', async () => {
    const dir = tmp();
    const clock = new ManualClock(1_782_000_000_000);
    const synth = new SynthFeed({
      instrumentId: INSTR,
      initialPricePaise: 15_000,
      seed: 42,
      clock,
    });

    const recorder = new Recorder({ dir });
    synth.setTickHandler((tick) => recorder.record(tick));
    synth.generateTicks(1000);
    await recorder.close();

    const run1: Tick[] = [];
    const run2: Tick[] = [];

    const feed1 = new ReplayFeed({ path: recorder.path });
    feed1.setTickHandler((t) => run1.push(t));
    await feed1.playInstant();

    const feed2 = new ReplayFeed({ path: recorder.path });
    feed2.setTickHandler((t) => run2.push(t));
    await feed2.playInstant();

    expect(run1.length).toBe(1000);
    expect(run2.length).toBe(run1.length);

    // Serialize both and compare.
    const hash1 = JSON.stringify(run1);
    const hash2 = JSON.stringify(run2);
    expect(hash1 === hash2).toBe(true);
    expect(recorder.path.endsWith('.gz')).toBe(true);
  });

  it('plain JSONL recording remains available for simple fixtures', async () => {
    const dir = tmp();
    const synth = new SynthFeed({
      instrumentId: INSTR,
      initialPricePaise: 12_000,
      seed: 123,
      clock: new ManualClock(1_000),
    });
    const recorder = new Recorder({ dir, compression: 'none' });
    synth.setTickHandler((tick) => recorder.record(tick));
    synth.generateTicks(10);
    await recorder.close();

    const replayed: Tick[] = [];
    const feed = new ReplayFeed({ path: recorder.path });
    feed.setTickHandler((tick) => replayed.push(tick));
    await feed.playInstant();

    expect(recorder.path.endsWith('.jsonl')).toBe(true);
    expect(replayed.length).toBe(10);
  });

  it('tick order in file is identical to original emission order', async () => {
    const dir = tmp();
    const clock = new ManualClock(2_000_000_000_000);
    const synth = new SynthFeed({
      instrumentId: INSTR,
      initialPricePaise: 20_000,
      seed: 7,
      clock,
    });

    const emitted: Tick[] = [];
    const recorder = new Recorder({ dir });
    synth.setTickHandler((t) => {
      emitted.push(t);
      recorder.record(t);
    });
    synth.generateTicks(200);
    await recorder.close();

    const replayed: Tick[] = [];
    const feed = new ReplayFeed({ path: recorder.path });
    feed.setTickHandler((t) => replayed.push(t));
    await feed.playInstant();

    expect(replayed.length).toBe(emitted.length);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(emitted));
  });

  it('skips malformed lines without aborting', async () => {
    const dir = tmp();
    const { appendFileSync } = await import('node:fs');
    const path = join(dir, 'ticks.jsonl');
    const good: Tick = {
      instrumentId: INSTR,
      ts: 1,
      recvTs: 1,
      ltpPaise: 10000,
      qty: 65,
      volume: 65,
      bidPaise: 9995,
      askPaise: 10005,
      bidQty: 130,
      askQty: 130,
    };
    appendFileSync(path, JSON.stringify(good) + '\n');
    appendFileSync(path, '{not valid json\n');
    appendFileSync(path, JSON.stringify({ ...good, ltpPaise: 10100 }) + '\n');

    const received: Tick[] = [];
    const feed = new ReplayFeed({ path });
    feed.setTickHandler((t) => received.push(t));
    const count = await feed.playInstant();
    expect(count).toBe(2);
    expect(received[0]?.ltpPaise).toBe(10000);
    expect(received[1]?.ltpPaise).toBe(10100);
  });
});

// ---------------------------------------------------------------------------
// SynthFeed statistical sanity
// ---------------------------------------------------------------------------

describe('SynthFeed statistical sanity', () => {
  it('bid < ask for every tick (no crossed market)', () => {
    const clock = new ManualClock(0);
    const synth = new SynthFeed({
      instrumentId: INSTR,
      initialPricePaise: 15_000,
      spreadTicks: 2,
      tickSizePaise: 5,
      seed: 1,
      clock,
    });
    const ticks = synth.generateTicks(500);
    for (const t of ticks) {
      expect(t.bidPaise).toBeLessThan(t.askPaise);
    }
  });

  it('ltp is always on the tick grid (multiples of tickSizePaise)', () => {
    const clock = new ManualClock(0);
    const synth = new SynthFeed({
      instrumentId: INSTR,
      initialPricePaise: 15_000,
      tickSizePaise: 5,
      seed: 2,
      clock,
    });
    for (const t of synth.generateTicks(500)) {
      expect(t.ltpPaise % 5).toBe(0);
    }
  });

  it('ltp stays positive even under high volatility', () => {
    const clock = new ManualClock(0);
    const synth = new SynthFeed({
      instrumentId: INSTR,
      initialPricePaise: 1_000,
      sigma: 0.05,
      tickSizePaise: 5,
      seed: 3,
      clock,
    });
    for (const t of synth.generateTicks(2000)) {
      expect(t.ltpPaise).toBeGreaterThan(0);
    }
  });

  it('two instances with the same seed produce identical tick streams', () => {
    const clock1 = new ManualClock(1000);
    const clock2 = new ManualClock(1000);
    const a = new SynthFeed({ instrumentId: INSTR, initialPricePaise: 10_000, seed: 99, clock: clock1 });
    const b = new SynthFeed({ instrumentId: INSTR, initialPricePaise: 10_000, seed: 99, clock: clock2 });
    const ta = a.generateTicks(100);
    const tb = b.generateTicks(100);
    expect(JSON.stringify(ta)).toBe(JSON.stringify(tb));
  });

  it('two instances with different seeds produce different tick streams', () => {
    const a = new SynthFeed({ instrumentId: INSTR, initialPricePaise: 10_000, seed: 11, clock: new ManualClock(0) });
    const b = new SynthFeed({ instrumentId: INSTR, initialPricePaise: 10_000, seed: 22, clock: new ManualClock(0) });
    const ta = a.generateTicks(50);
    const tb = b.generateTicks(50);
    expect(JSON.stringify(ta)).not.toBe(JSON.stringify(tb));
  });

  it('volumes are always positive multiples of lot size', () => {
    const clock = new ManualClock(0);
    const synth = new SynthFeed({ instrumentId: INSTR, initialPricePaise: 10_000, seed: 5, clock });
    for (const t of synth.generateTicks(200)) {
      expect(t.qty).toBeGreaterThan(0);
      expect(t.qty % 65).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// BarBuilder
// ---------------------------------------------------------------------------

describe('BarBuilder', () => {
  it('emits 1m bars when minute boundary crossed', () => {
    const bars: { tf: string; o: number; c: number }[] = [];
    const builder = new BarBuilder(INSTR, (b) =>
      bars.push({ tf: b.tf, o: b.o, c: b.c }),
    );

    const base = 60_000; // exactly one minute
    builder.onTick({ instrumentId: INSTR, ts: base, recvTs: base, ltpPaise: 100, qty: 65, volume: 65, bidPaise: 99, askPaise: 101, bidQty: 65, askQty: 65 });
    builder.onTick({ instrumentId: INSTR, ts: base + 30_000, recvTs: base + 30_000, ltpPaise: 110, qty: 65, volume: 130, bidPaise: 109, askPaise: 111, bidQty: 65, askQty: 65 });
    // New minute
    builder.onTick({ instrumentId: INSTR, ts: base + 60_000, recvTs: base + 60_000, ltpPaise: 120, qty: 65, volume: 195, bidPaise: 119, askPaise: 121, bidQty: 65, askQty: 65 });

    const oneMin = bars.filter((b) => b.tf === '1m');
    expect(oneMin.length).toBeGreaterThanOrEqual(1);
    expect(oneMin[0]?.o).toBe(100);
    expect(oneMin[0]?.c).toBe(110);
  });

  it('flush emits any open bar', () => {
    const emitted: unknown[] = [];
    const builder = new BarBuilder(INSTR, (b) => emitted.push(b));
    builder.onTick({ instrumentId: INSTR, ts: 60_000, recvTs: 60_000, ltpPaise: 500, qty: 65, volume: 65, bidPaise: 499, askPaise: 501, bidQty: 65, askQty: 65 });
    builder.flush();
    expect(emitted.length).toBeGreaterThanOrEqual(2); // at least 1s and 1m
  });
});
