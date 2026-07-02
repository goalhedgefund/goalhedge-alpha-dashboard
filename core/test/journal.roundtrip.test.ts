import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import type { JournalEvent } from '../src/domain/events.js';
import { ManualClock } from '../src/domain/time.js';
import { hashEventStream } from '../src/journal/hash.js';
import { JournalIntegrityError, iterateJournal, readJournal } from '../src/journal/reader.js';
import { JournalWriter } from '../src/journal/writer.js';
import { generateSessionPayloads } from './helpers/fixtures.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'scalper-jrn-'));
}

describe('journal round trip (M1 acceptance)', () => {
  it('100k+ mixed events: write → read back → byte-identical, order preserved', async () => {
    // 12 events per order lifecycle incl. ticks → 8400 orders ≈ 101k events
    const payloads = generateSessionPayloads({ orderCount: 8400, ticksPerOrder: 5 });
    expect(payloads.length).toBeGreaterThanOrEqual(100_000);

    const dir = tmp();
    const clock = new ManualClock(1_782_000_000_000);
    const writer = new JournalWriter({ dir, clock, fsync: 'never', flushIntervalMs: 60_000 });

    const written: JournalEvent[] = [];
    for (const p of payloads) {
      clock.advance(1);
      written.push(writer.append(p.type, p.payload));
    }
    await writer.close();

    // Byte-identical: file content equals the re-serialization of what append returned.
    const fileBytes = readFileSync(writer.path, 'utf8');
    const expected = written.map((e) => JSON.stringify(e)).join('\n') + '\n';
    expect(fileBytes === expected).toBe(true);

    // Read back: same count, gap-free seq, same content hash, order preserved.
    const { events, partialTail } = await readJournal(writer.path);
    expect(partialTail).toBe(false);
    expect(events.length).toBe(written.length);
    expect(hashEventStream(events)).toBe(hashEventStream(written));
    expect(events[0]).toEqual(written[0]);
    expect(events[events.length - 1]).toEqual(written[written.length - 1]);

    // Re-serializing the read events reproduces the file byte-for-byte.
    const reserialized = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    expect(reserialized === fileBytes).toBe(true);
  }, 60_000);

  it('replay iterator preserves order (seq strictly 1..N)', async () => {
    const dir = tmp();
    const clock = new ManualClock(1000);
    const writer = new JournalWriter({ dir, clock, fsync: 'never' });
    for (const p of generateSessionPayloads({ orderCount: 20, ticksPerOrder: 2 })) {
      writer.append(p.type, p.payload);
    }
    await writer.close();

    let expectedSeq = 1;
    for await (const ev of iterateJournal(writer.path)) {
      expect(ev.seq).toBe(expectedSeq++);
    }
    expect(expectedSeq).toBeGreaterThan(1);
  });

  it('tolerates a trailing partial line (crash mid-write) and reports it', async () => {
    const dir = tmp();
    const writer = new JournalWriter({ dir, clock: new ManualClock(1), fsync: 'never' });
    for (const p of generateSessionPayloads({ orderCount: 3, ticksPerOrder: 1 })) {
      writer.append(p.type, p.payload);
    }
    await writer.close();
    const { events: fullEvents } = await readJournal(writer.path);

    appendFileSync(writer.path, '{"seq":99999,"ts":123,"type":"md.ti');
    const { events, partialTail } = await readJournal(writer.path);
    expect(partialTail).toBe(true);
    expect(events.length).toBe(fullEvents.length);
  });

  it('throws on a seq gap and on malformed middle lines', async () => {
    const dir = tmp();
    const good = { seq: 1, ts: 1, type: 'session.closed', payload: { sessionId: 's' } };
    const gapped = { ...good, seq: 3 };
    const p1 = join(dir, 'gap.jsonl');
    writeFileSync(p1, JSON.stringify(good) + '\n' + JSON.stringify(gapped) + '\n');
    await expect(readJournal(p1)).rejects.toThrow(JournalIntegrityError);

    const p2 = join(dir, 'malformed.jsonl');
    writeFileSync(p2, 'not-json\n' + JSON.stringify(good) + '\n');
    await expect(readJournal(p2)).rejects.toThrow(JournalIntegrityError);
  });

  it('refuses to overwrite an existing journal; resume continues the seq', async () => {
    const dir = tmp();
    const w1 = new JournalWriter({ dir, clock: new ManualClock(1), fsync: 'never' });
    w1.append('session.closed', { sessionId: 'x' as never });
    await w1.close();

    const w2 = new JournalWriter({ dir, clock: new ManualClock(2), fsync: 'never' });
    await expect(w2.ready()).rejects.toThrow();
    expect(() => w2.append('session.closed', { sessionId: 'x' as never })).toThrow(/refusing/);

    const w3 = new JournalWriter({
      dir,
      clock: new ManualClock(3),
      fsync: 'never',
      resume: { startSeq: 2 },
    });
    w3.append('session.closed', { sessionId: 'x' as never });
    await w3.close();
    const { events } = await readJournal(join(dir, 'events.jsonl'));
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('property: any valid event sequence serializes/deserializes to an identical stream hash', () => {
    const payloadArb = fc.oneof(
      fc.record({
        where: fc.string({ minLength: 1 }),
        message: fc.string(),
      }),
      fc.record({
        hops: fc.dictionary(
          fc.string({ minLength: 1 }),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          { maxKeys: 5 },
        ),
      }),
    );
    const eventsArb = fc
      .array(payloadArb, { minLength: 1, maxLength: 50 })
      .map((payloads) =>
        payloads.map((p, i) => {
          const type = 'hops' in p ? ('latency.sample' as const) : ('diag.error' as const);
          return { seq: i + 1, ts: 1000 + i, type, payload: p } as JournalEvent;
        }),
      );

    fc.assert(
      fc.property(eventsArb, (events) => {
        const lines = events.map((e) => JSON.stringify(e)).join('\n');
        const parsed = lines.split('\n').map((l) => JSON.parse(l) as JournalEvent);
        expect(hashEventStream(parsed)).toBe(hashEventStream(events));
      }),
    );
  });
});
