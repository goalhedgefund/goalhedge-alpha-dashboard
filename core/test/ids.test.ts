import { describe, expect, it } from 'vitest';
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';

describe('deterministic ids', () => {
  it('two factories for the same session produce identical sequences (replay safety)', () => {
    const s = makeSessionId('2026-07-03', 'paper');
    const a = new IdFactory(s);
    const b = new IdFactory(s);
    const seqA = [a.intentId(), a.clientOrderId(), a.clientOrderId(), a.positionId(), a.tradeId()];
    const seqB = [b.intentId(), b.clientOrderId(), b.clientOrderId(), b.positionId(), b.tradeId()];
    expect(seqA).toEqual(seqB);
  });

  it('ids embed session and monotonic counter per prefix', () => {
    const s = makeSessionId('2026-07-03', 'live');
    const f = new IdFactory(s);
    expect(f.clientOrderId()).toBe('ord-2026-07-03_live-1');
    expect(f.clientOrderId()).toBe('ord-2026-07-03_live-2');
    expect(f.intentId()).toBe('int-2026-07-03_live-1');
  });

  it('resumeFrom advances counters past ids already persisted (restart safety)', () => {
    const s = makeSessionId('2026-07-30', 'paper');
    // Pre-restart run issued trd-...-1.
    const before = new IdFactory(s);
    expect(before.tradeId()).toBe('trd-2026-07-30_paper-1');

    // Restart: a fresh factory would re-issue -1 and collide with the trades
    // PRIMARY KEY, silently dropping the row. Seeded, it continues.
    const after = new IdFactory(s);
    after.resumeFrom([['trd', 1]]);
    expect(after.tradeId()).toBe('trd-2026-07-30_paper-2');
    expect(after.tradeId()).toBe('trd-2026-07-30_paper-3');
    // Prefixes are seeded independently.
    expect(after.positionId()).toBe('pos-2026-07-30_paper-1');
  });

  it('resumeFrom with no seeds keeps the deterministic sequence (replay safety)', () => {
    const s = makeSessionId('2026-07-03', 'paper');
    const a = new IdFactory(s);
    const b = new IdFactory(s);
    b.resumeFrom([]);
    expect([a.tradeId(), a.tradeId()]).toEqual([b.tradeId(), b.tradeId()]);
  });

  it('resumeFrom never lowers a counter and ignores junk', () => {
    const s = makeSessionId('2026-07-03', 'paper');
    const f = new IdFactory(s);
    f.resumeFrom([['trd', 5]]);
    f.resumeFrom([['trd', 2]]);                       // lower: ignored
    f.resumeFrom([['trd', 0], ['trd', -3], ['trd', 1.5], ['trd', Number.NaN]]);
    expect(f.tradeId()).toBe('trd-2026-07-03_paper-6');
  });

  it('session and instrument id formats', () => {
    expect(makeSessionId('2026-07-03', 'paper')).toBe('2026-07-03_paper');
    expect(makeInstrumentId('NSE', '52001')).toBe('NSE:52001');
  });
});
