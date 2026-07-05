import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../src/domain/events.js';
import { hashEventStream } from '../src/journal/hash.js';
import { generateSessionPayloads } from './helpers/fixtures.js';

function goldenEvents(): JournalEvent[] {
  return generateSessionPayloads({ orderCount: 3, ticksPerOrder: 4, seed: 20260705 }).map((emitted, idx) => ({
    seq: idx + 1,
    ts: 1_800_000_000_000 + idx,
    type: emitted.type,
    payload: emitted.payload,
  }) as JournalEvent);
}

describe('golden-session determinism (03-TESTING-PLAN §7)', () => {
  it('recorded corpus fixture keeps its pinned stable journal hash', () => {
    const events = goldenEvents();
    const stable = events.filter((e) => e.type !== 'latency.sample');

    expect(hashEventStream(stable)).toBe('0fee95e641880b5678fd1719deea365da5f03b037a1ce1c00d00f4b59cce1aa9');
  });

  it('same golden corpus replayed twice produces identical state hashes', () => {
    const a = hashEventStream(goldenEvents().filter((e) => e.type !== 'latency.sample'));
    const b = hashEventStream(goldenEvents().filter((e) => e.type !== 'latency.sample'));

    expect(a).toBe(b);
  });
});
