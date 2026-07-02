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

  it('session and instrument id formats', () => {
    expect(makeSessionId('2026-07-03', 'paper')).toBe('2026-07-03_paper');
    expect(makeInstrumentId('NSE', '52001')).toBe('NSE:52001');
  });
});
