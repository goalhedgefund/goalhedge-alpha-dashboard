import { describe, expect, it } from 'vitest';
import { LatencySampler, RollingLatency } from '../src/telemetry/latency.js';

describe('RollingLatency', () => {
  it('nearest-rank percentiles over a small set', () => {
    const r = new RollingLatency(16);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) r.record(v);
    expect(r.count).toBe(10);
    expect(r.size).toBe(10);
    // nearest-rank: p50 → ceil(0.5*10)-1 = index 4 → value 5
    expect(r.p50()).toBe(5);
    // p99 → ceil(0.99*10)-1 = index 9 → value 10
    expect(r.p99()).toBe(10);
    expect(r.max()).toBe(10);
  });

  it('sorts numerically, not lexicographically (Float64Array)', () => {
    const r = new RollingLatency(8);
    for (const v of [2, 10, 1, 100, 20]) r.record(v);
    expect(r.p50()).toBe(10); // sorted [1,2,10,20,100], index 2
    expect(r.max()).toBe(100);
  });

  it('ring evicts oldest beyond capacity but count keeps growing', () => {
    const r = new RollingLatency(4);
    for (const v of [1, 2, 3, 4, 5, 6]) r.record(v); // retains [3,4,5,6]
    expect(r.size).toBe(4);
    expect(r.count).toBe(6);
    expect(r.p50()).toBe(4); // sorted [3,4,5,6], ceil(0.5*4)-1=1 → value 4
    expect(r.max()).toBe(6);
  });

  it('empty percentile is 0', () => {
    expect(new RollingLatency(4).p50()).toBe(0);
  });

  it('reset clears everything', () => {
    const r = new RollingLatency(4);
    r.record(1);
    r.reset();
    expect(r.count).toBe(0);
    expect(r.size).toBe(0);
    expect(r.p99()).toBe(0);
  });
});

/** Deterministic clock: returns the queued readings in order. */
function scriptedClock(readings: number[]): () => number {
  let i = 0;
  return () => readings[i++] ?? readings[readings.length - 1] ?? 0;
}

describe('LatencySampler', () => {
  it('records exact hop deltas from a scripted clock and journals on sent', () => {
    // recv=0, features=1.0ms, signal=1.5ms, risk=2.0ms, sent=2.2ms
    const clock = scriptedClock([0, 1.0, 1.5, 2.0, 2.2]);
    const s = new LatencySampler({ clock, capacity: 64 });
    s.begin();
    s.mark('features');
    s.mark('signal');
    s.mark('risk');
    s.mark('sent');
    const hops = s.end();
    expect(hops).toEqual({
      features: 1000, // 1.0ms
      signal: 500,
      risk: 500,
      sent: 200,
      total: 2200,
    });
    const snap = s.snapshot();
    expect(snap.total.count).toBe(1);
    expect(snap.total.p99Ms).toBeCloseTo(2.2, 6);
    expect(snap.hops.features.p99Ms).toBeCloseTo(1.0, 6);
    expect(snap.hops.sent.p99Ms).toBeCloseTo(0.2, 6);
  });

  it('no-signal ticks record hot-path cost but do NOT journal', () => {
    const clock = scriptedClock([0, 0.3, 0.4]); // recv, features, signal
    const s = new LatencySampler({ clock, capacity: 64 });
    s.begin();
    s.mark('features');
    s.mark('signal');
    const hops = s.end();
    expect(hops).toBeUndefined(); // never reached 'sent' → no journal sample
    const snap = s.snapshot();
    expect(snap.total.count).toBe(1); // but still counted for the HUD
    expect(snap.total.p99Ms).toBeCloseTo(0.4, 6); // recv→signal
    expect(snap.hops.risk.p99Ms).toBe(0); // never reached
  });

  it('a decision that times nothing (reached 0) records and journals nothing', () => {
    const s = new LatencySampler({ clock: scriptedClock([0]), capacity: 8 });
    s.begin();
    expect(s.end()).toBeUndefined();
    expect(s.snapshot().total.count).toBe(0);
  });

  it('reset clears rolling stats between sessions', () => {
    const s = new LatencySampler({ clock: scriptedClock([0, 1, 2, 3, 4]), capacity: 8 });
    s.begin();
    s.mark('features');
    s.mark('signal');
    s.mark('risk');
    s.mark('sent');
    s.end();
    s.reset();
    expect(s.snapshot().total.count).toBe(0);
  });
});
