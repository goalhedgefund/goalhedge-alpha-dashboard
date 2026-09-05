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
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';
import type { Trade } from '../src/domain/positions.js';
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

describe('id counter recovery across a mid-session restart', () => {
  const SESSION = makeSessionId('2026-07-30', 'paper');
  const trade = (n: number, netPaise: number): Trade => ({
    tradeId: `trd-${SESSION}-${n}` as Trade['tradeId'],
    sessionId: SESSION,
    strategyId: 's2-vwap-fade',
    instrumentId: makeInstrumentId('NSE', '42641'),
    qty: 65,
    entry: { side: 'BUY', qty: 65, pricePaise: 7000, ts: 1_000 + n, clientOrderId: `ord-${SESSION}-${n}a` as Trade['entry']['clientOrderId'] },
    exit: { side: 'SELL', qty: 65, pricePaise: 7100, ts: 2_000 + n, clientOrderId: `ord-${SESSION}-${n}b` as Trade['exit']['clientOrderId'] },
    grossPnlPaise: netPaise,
    charges: { totalPaise: 0, components: [] },
    netPnlPaise: netPaise,
    exitReason: 'L3_TIME',
    holdMs: 1_000,
  });

  it('maxIdCounters reports the highest persisted counter per prefix', () => {
    const db = newDb();
    db.insertTrade(trade(1, 100));
    db.insertTrade(trade(7, 200));
    db.insertTrade(trade(3, 300));
    const max = db.maxIdCounters(SESSION);
    expect(max.get('trd')).toBe(7);
    expect(max.get('pos')).toBeUndefined();       // nothing persisted for that prefix
    expect(db.maxIdCounters(makeSessionId('2026-08-01', 'paper')).size).toBe(0);
    db.close();
  });

  it('a restarted session does not lose a trade to a PRIMARY KEY collision', () => {
    const db = newDb();
    // Pre-restart run: one trade.
    const before = new IdFactory(SESSION);
    db.insertTrade({ ...trade(0, 100), tradeId: before.tradeId() });

    // Restart. Unseeded this re-issues trd-...-1 and the insert throws,
    // which is how two live sessions silently lost a trade each.
    const naive = new IdFactory(SESSION);
    expect(() => db.insertTrade({ ...trade(0, 999), tradeId: naive.tradeId() })).toThrow();

    // Seeded from the store, the restart continues cleanly.
    const seeded = new IdFactory(SESSION);
    seeded.resumeFrom(db.maxIdCounters(SESSION));
    db.insertTrade({ ...trade(0, 999), tradeId: seeded.tradeId() });

    expect(db.counts(SESSION).trades).toBe(2);
    expect(db.getTradeNet(`trd-${SESSION}-2`)).toBe(999);
    db.close();
  });
});

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
