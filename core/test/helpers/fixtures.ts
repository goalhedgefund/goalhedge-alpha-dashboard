import type { JournalEventType, JournalPayloads } from '../../src/domain/events.js';
import {
  IdFactory,
  makeInstrumentId,
  makeSessionId,
  type InstrumentId,
  type SessionId,
} from '../../src/domain/ids.js';
import type { Tick } from '../../src/domain/marketdata.js';
import type { Order } from '../../src/domain/orders.js';
import type { Position, Trade } from '../../src/domain/positions.js';
import type { SessionState } from '../../src/domain/session.js';

/** Deterministic RNG (mulberry32) so fixture streams are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIXTURE_SESSION: SessionId = makeSessionId('2026-07-03', 'paper');
export const FIXTURE_INSTRUMENT: InstrumentId = makeInstrumentId('NSE', '52001');

export interface EmittedEvent<K extends JournalEventType = JournalEventType> {
  type: K;
  payload: JournalPayloads[K];
}

export interface SessionFixtureOptions {
  orderCount: number;
  ticksPerOrder: number;
  seed?: number;
}

/**
 * Generate a coherent session's worth of journal payloads: session start,
 * configs, interleaved ticks and full order→position→trade lifecycles,
 * session close. Returns payloads (seq/ts get stamped by the writer).
 */
export function generateSessionPayloads(opts: SessionFixtureOptions): EmittedEvent[] {
  const rng = mulberry32(opts.seed ?? 42);
  const ids = new IdFactory(FIXTURE_SESSION);
  const out: EmittedEvent[] = [];
  let ts = 1_782_000_000_000;
  const nextTs = (): number => (ts += 1 + Math.floor(rng() * 50));

  const session: SessionState = {
    sessionId: FIXTURE_SESSION,
    mode: 'paper',
    date: '2026-07-03',
    phase: 'OPEN',
    configHashes: { market: 'aa11', risk: 'bb22', strategy: 'cc33' },
    startedTs: nextTs(),
  };
  out.push({ type: 'session.started', payload: { session } });
  for (const name of ['market', 'risk', 'strategy'] as const) {
    out.push({
      type: 'config.loaded',
      payload: {
        sessionId: FIXTURE_SESSION,
        name,
        hash: session.configHashes[name] as string,
        path: `config/${name}.json`,
      },
    });
  }

  const tick = (): EmittedEvent => {
    const ltp = 10_000 + Math.floor(rng() * 5_000);
    const t: Tick = {
      instrumentId: FIXTURE_INSTRUMENT,
      ts: nextTs(),
      recvTs: ts + 2,
      ltpPaise: ltp,
      qty: Math.floor(rng() * 150),
      volume: Math.floor(rng() * 1_000_000),
      bidPaise: ltp - 5,
      askPaise: ltp + 5,
      bidQty: 75 * (1 + Math.floor(rng() * 10)),
      askQty: 75 * (1 + Math.floor(rng() * 10)),
    };
    return { type: 'md.tick', payload: { tick: t } };
  };

  for (let i = 0; i < opts.orderCount; i++) {
    for (let k = 0; k < opts.ticksPerOrder; k++) out.push(tick());

    const intentId = ids.intentId();
    const clientOrderId = ids.clientOrderId();
    const positionId = ids.positionId();
    const tradeId = ids.tradeId();
    const entryPrice = 10_000 + Math.floor(rng() * 4_000);
    const qty = 75 * (1 + Math.floor(rng() * 3));
    const createdTs = nextTs();

    const base: Order = {
      clientOrderId,
      intentId,
      sessionId: FIXTURE_SESSION,
      instrumentId: FIXTURE_INSTRUMENT,
      side: 'BUY',
      qty,
      filledQty: 0,
      avgFillPricePaise: 0,
      type: 'LIMIT',
      limitPricePaise: entryPrice,
      state: 'SENT',
      purpose: 'ENTRY',
      tag: 's1:entry',
      createdTs,
      updatedTs: createdTs,
    };
    out.push({ type: 'order.created', payload: { order: base } });

    const acked: Order = { ...base, state: 'ACKED', brokerOrderId: `B${i + 1}`, updatedTs: nextTs() };
    out.push({ type: 'order.updated', payload: { order: acked, cause: 'TRANSITION', from: 'SENT' } });

    const fillTs = nextTs();
    const filled: Order = {
      ...acked,
      state: 'FILLED',
      filledQty: qty,
      avgFillPricePaise: entryPrice,
      updatedTs: fillTs,
    };
    out.push({
      type: 'order.updated',
      payload: {
        order: filled,
        cause: 'FILL',
        from: 'ACKED',
        fill: { clientOrderId, fillId: `F${i + 1}`, ts: fillTs, qty, pricePaise: entryPrice },
      },
    });

    const position: Position = {
      positionId,
      sessionId: FIXTURE_SESSION,
      strategyId: 's1',
      instrumentId: FIXTURE_INSTRUMENT,
      side: 'BUY',
      qty,
      avgEntryPricePaise: entryPrice,
      state: 'OPEN',
      realizedGrossPaise: 0,
      openedTs: fillTs,
      updatedTs: fillTs,
    };
    out.push({ type: 'position.opened', payload: { position } });

    const exitPrice = entryPrice + Math.floor(rng() * 2_000) - 800;
    const exitTs = nextTs();
    const closed: Position = { ...position, qty: 0, state: 'CLOSED', updatedTs: exitTs };
    out.push({ type: 'position.updated', payload: { position: closed } });
    out.push({ type: 'position.closed', payload: { positionId, sessionId: FIXTURE_SESSION } });

    const gross = (exitPrice - entryPrice) * qty;
    const chargesTotal = Math.floor(Math.abs(exitPrice + entryPrice) * qty * 0.0007);
    const trade: Trade = {
      tradeId,
      sessionId: FIXTURE_SESSION,
      strategyId: 's1',
      instrumentId: FIXTURE_INSTRUMENT,
      qty,
      entry: { side: 'BUY', qty, pricePaise: entryPrice, ts: fillTs, clientOrderId },
      exit: { side: 'SELL', qty, pricePaise: exitPrice, ts: exitTs, clientOrderId },
      grossPnlPaise: gross,
      charges: {
        totalPaise: chargesTotal,
        components: [
          { name: 'stt', paise: Math.floor(chargesTotal * 0.6) },
          { name: 'exchange_txn', paise: chargesTotal - Math.floor(chargesTotal * 0.6) },
        ],
      },
      netPnlPaise: gross - chargesTotal,
      exitReason: rng() < 0.5 ? 'L2_TRAIL' : 'L3_TIME',
      holdMs: exitTs - fillTs,
    };
    out.push({ type: 'trade.completed', payload: { trade } });
  }

  out.push({ type: 'session.closed', payload: { sessionId: FIXTURE_SESSION } });
  return out;
}
