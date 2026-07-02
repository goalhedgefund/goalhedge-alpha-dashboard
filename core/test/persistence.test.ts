import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEvent } from '../src/domain/events.js';
import { ManualClock } from '../src/domain/time.js';
import { mirrorEvent } from '../src/journal/mirror.js';
import { JournalWriter } from '../src/journal/writer.js';
import { readJournal } from '../src/journal/reader.js';
import { Persistence } from '../src/persistence/db.js';
import { FIXTURE_SESSION, generateSessionPayloads } from './helpers/fixtures.js';

function newDb(): Persistence {
  const dir = mkdtempSync(join(tmpdir(), 'scalper-db-'));
  return new Persistence(join(dir, 'scalper.db'));
}

async function writeAndRead(orderCount: number): Promise<JournalEvent[]> {
  const dir = mkdtempSync(join(tmpdir(), 'scalper-mir-'));
  const writer = new JournalWriter({ dir, clock: new ManualClock(1), fsync: 'never' });
  for (const p of generateSessionPayloads({ orderCount, ticksPerOrder: 4 })) {
    writer.append(p.type, p.payload);
  }
  await writer.close();
  return (await readJournal(writer.path)).events;
}

describe('SQLite persistence (M1 acceptance)', () => {
  it('opens in WAL mode', () => {
    const db = newDb();
    expect(db.journalMode()).toBe('wal');
    db.close();
  });

  it('mirror of a journal matches journal counts exactly', async () => {
    const events = await writeAndRead(400);
    const db = newDb();
    db.tx(() => {
      for (const ev of events) mirrorEvent(db, ev);
    });

    // Expected counts derived from the journal itself.
    const byType = new Map<string, number>();
    const orderIds = new Set<string>();
    const positionIds = new Set<string>();
    for (const ev of events) {
      byType.set(ev.type, (byType.get(ev.type) ?? 0) + 1);
      if (ev.type === 'order.created' || ev.type === 'order.updated') {
        orderIds.add(ev.payload.order.clientOrderId);
      }
      if (ev.type === 'position.opened' || ev.type === 'position.updated') {
        positionIds.add(ev.payload.position.positionId);
      }
    }

    const counts = db.counts(FIXTURE_SESSION);
    expect(counts.sessions).toBe(1);
    expect(counts.configHashes).toBe(byType.get('config.loaded'));
    expect(counts.orders).toBe(orderIds.size);
    expect(counts.orderEvents).toBe(
      (byType.get('order.created') ?? 0) + (byType.get('order.updated') ?? 0),
    );
    expect(counts.positions).toBe(positionIds.size);
    expect(counts.trades).toBe(byType.get('trade.completed'));
    db.close();
  }, 30_000);

  it('order rows reflect the LAST snapshot; mirroring is idempotent per order state', async () => {
    const events = await writeAndRead(5);
    const db = newDb();
    for (const ev of events) mirrorEvent(db, ev);

    for (const ev of events) {
      if (ev.type === 'order.updated') {
        // Re-upserting the same snapshot must not duplicate the order row.
        db.upsertOrder(ev.payload.order);
      }
    }
    const counts = db.counts(FIXTURE_SESSION);
    expect(counts.orders).toBe(5);

    const lastStates = new Map<string, string>();
    for (const ev of events) {
      if (ev.type === 'order.created' || ev.type === 'order.updated') {
        lastStates.set(ev.payload.order.clientOrderId, ev.payload.order.state);
      }
    }
    for (const [id, state] of lastStates) {
      expect(db.getOrderState(id)).toBe(state);
    }
    db.close();
  });

  it('trade rows carry the net-of-charges P&L', async () => {
    const events = await writeAndRead(3);
    const db = newDb();
    for (const ev of events) mirrorEvent(db, ev);
    for (const ev of events) {
      if (ev.type === 'trade.completed') {
        expect(db.getTradeNet(ev.payload.trade.tradeId)).toBe(ev.payload.trade.netPnlPaise);
      }
    }
    db.close();
  });

  it('transactions roll back on error', () => {
    const db = newDb();
    const session = {
      sessionId: FIXTURE_SESSION,
      mode: 'paper' as const,
      date: '2026-07-03',
      phase: 'OPEN' as const,
      configHashes: {},
      startedTs: 1,
    };
    expect(() =>
      db.tx(() => {
        db.upsertSession(session);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.counts(FIXTURE_SESSION).sessions).toBe(0);
    db.close();
  });

  it('data survives close and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scalper-db-'));
    const dbPath = join(dir, 'scalper.db');
    const events = await writeAndRead(2);

    const db1 = new Persistence(dbPath);
    for (const ev of events) mirrorEvent(db1, ev);
    const before = db1.counts(FIXTURE_SESSION);
    db1.close();

    const db2 = new Persistence(dbPath);
    expect(db2.counts(FIXTURE_SESSION)).toEqual(before);
    db2.close();
  });
});
