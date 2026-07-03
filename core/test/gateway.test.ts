/**
 * M8a acceptance: gateway snapshot+delta protocol, per-client sequencing,
 * resnapshot, journaled command channel, journal ingestion into the state tree.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { JournalEvent, JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';
import type { Order } from '../src/domain/orders.js';
import type { Position, Trade } from '../src/domain/positions.js';
import { registerRunnerCommands, type RunnerCommandTarget } from '../src/gateway/commands.js';
import { Gateway } from '../src/gateway/gateway.js';
import { applyChanges, type GatewayState, type ServerMsg } from '../src/gateway/protocol.js';
import type { StrategyLifecycle, StrategyParams } from '../src/strategy/types.js';

const SESSION = makeSessionId('2026-07-03', 'paper');
const INSTR = makeInstrumentId('NSE', 'CE1');

function initialState(): GatewayState {
  return {
    session: { sessionId: SESSION, mode: 'paper', phase: 'PREFLIGHT', date: '2026-07-03' },
    health: { feedStatus: 'CONNECTED', lastTickTs: 0, gatewayTs: 0 },
    algo: { strategyId: 's1-momentum-burst', lifecycle: 'DISARMED', params: {} },
    risk: {
      snapshot: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
      limits: { dailyMaxLossPaise: 1_000_000, perTradeRiskPaise: 250_000, maxTradesPerDay: 15, maxConcurrentPositions: 1 },
    },
    positions: [],
    orders: [],
    trades: [],
    chain: [],
    events: [],
  };
}

class TestClient {
  private readonly msgs: ServerMsg[] = [];
  private waiter: (() => void) | undefined;

  private constructor(readonly ws: WebSocket) {}

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const client = new TestClient(ws);
      ws.addEventListener('message', (ev: MessageEvent) => {
        client.msgs.push(JSON.parse(String(ev.data)) as ServerMsg);
        client.waiter?.();
      });
      ws.addEventListener('open', () => resolve(client));
      ws.addEventListener('error', () => reject(new Error('ws connect failed')));
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait until a message matching `pred` arrives; returns and consumes it. */
  async expect<T extends ServerMsg>(pred: (m: ServerMsg) => m is T, timeoutMs = 2_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this.msgs.findIndex(pred);
      if (idx >= 0) return this.msgs.splice(idx, 1)[0] as T;
      if (Date.now() > deadline) throw new Error(`timeout; have: ${this.msgs.map((m) => m.kind).join(',')}`);
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, 25);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

const isSnapshot = (m: ServerMsg): m is Extract<ServerMsg, { kind: 'snapshot' }> => m.kind === 'snapshot';
const isDelta = (m: ServerMsg): m is Extract<ServerMsg, { kind: 'delta' }> => m.kind === 'delta';
const isHb = (m: ServerMsg): m is Extract<ServerMsg, { kind: 'hb' }> => m.kind === 'hb';
const isAck = (m: ServerMsg): m is Extract<ServerMsg, { kind: 'ack' }> => m.kind === 'ack';

const openGateways: Gateway[] = [];
const openClients: TestClient[] = [];

function makeGateway(opts: Partial<ConstructorParameters<typeof Gateway>[0]> = {}): Gateway {
  const g = new Gateway({
    port: 0,
    initialState: initialState(),
    flushMs: 60_000,
    heartbeatMs: 60_000,
    ...opts,
  });
  openGateways.push(g);
  return g;
}

async function connect(g: Gateway): Promise<TestClient> {
  await g.ready();
  const c = await TestClient.connect(g.port());
  openClients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of openClients.splice(0)) c.close();
  for (const g of openGateways.splice(0)) await g.close();
});

describe('snapshot + delta protocol', () => {
  it('sends a full snapshot (seq 1) on connect', async () => {
    const g = makeGateway();
    const c = await connect(g);
    const snap = await c.expect(isSnapshot);
    expect(snap.seq).toBe(1);
    expect(snap.state).toEqual(initialState());
  });

  it('set() + flushNow() → one sequenced delta; applyChanges reconstructs server state', async () => {
    const g = makeGateway();
    const c = await connect(g);
    const snap = await c.expect(isSnapshot);

    g.set('session', { ...g.currentState().session, phase: 'OPEN' });
    g.set('health', { feedStatus: 'STALE', lastTickTs: 42, gatewayTs: 43 });
    g.flushNow();

    const delta = await c.expect(isDelta);
    expect(delta.seq).toBe(2);
    expect(delta.changes.length).toBe(2);

    const rebuilt = applyChanges(snap.state, delta.changes);
    expect(rebuilt).toEqual(g.currentState());
  });

  it('per-client sequencing: a later joiner starts at seq 1 without breaking earlier clients', async () => {
    const g = makeGateway();
    const a = await connect(g);
    const snapA = await a.expect(isSnapshot);
    expect(snapA.seq).toBe(1);

    const b = await connect(g);
    const snapB = await b.expect(isSnapshot);
    expect(snapB.seq).toBe(1);

    g.set('session', { ...g.currentState().session, phase: 'OPEN' });
    g.flushNow();

    const deltaA = await a.expect(isDelta);
    const deltaB = await b.expect(isDelta);
    expect(deltaA.seq).toBe(2); // A: snapshot 1 → delta 2, gap-free
    expect(deltaB.seq).toBe(2);
  });

  it('resnapshot request returns the full current state at the next seq', async () => {
    const g = makeGateway();
    const c = await connect(g);
    await c.expect(isSnapshot);

    g.set('session', { ...g.currentState().session, phase: 'OPEN' });
    g.flushNow();
    await c.expect(isDelta);

    c.send({ kind: 'resnapshot' });
    const snap2 = await c.expect(isSnapshot);
    expect(snap2.seq).toBe(3);
    expect(snap2.state.session.phase).toBe('OPEN');
  });

  it('heartbeats carry the current seq without incrementing it', async () => {
    const g = makeGateway({ heartbeatMs: 30 });
    const c = await connect(g);
    const snap = await c.expect(isSnapshot);
    const hb = await c.expect(isHb);
    expect(hb.seq).toBe(snap.seq);
  });
});

describe('command channel', () => {
  function fakeRunner(): RunnerCommandTarget & { calls: string[]; params: StrategyParams | undefined } {
    let lifecycle: StrategyLifecycle = 'DISARMED';
    const target = {
      calls: [] as string[],
      params: undefined as StrategyParams | undefined,
      arm(): void {
        target.calls.push('arm');
        lifecycle = 'ARMED';
      },
      disarm(): void {
        target.calls.push('disarm');
        lifecycle = 'DISARMED';
      },
      setParams(p: StrategyParams): void {
        target.calls.push('setParams');
        target.params = p;
      },
      state: (): StrategyLifecycle => lifecycle,
    };
    return target;
  }

  it('ARM round trip: ack accepted, runner armed, command journaled received+acked', async () => {
    const journaled: Array<{ type: JournalEventType; payload: unknown }> = [];
    const sink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void => {
      journaled.push({ type, payload });
    };
    const g = makeGateway({ journal: sink });
    const runner = fakeRunner();
    registerRunnerCommands(g, runner);

    const c = await connect(g);
    await c.expect(isSnapshot);
    c.send({ kind: 'command', commandId: 'cmd-1', type: 'ARM' });

    const ack = await c.expect(isAck);
    expect(ack).toMatchObject({ commandId: 'cmd-1', accepted: true, reason: 'ARMED' });
    expect(runner.calls).toEqual(['arm']);
    expect(journaled.map((j) => j.type)).toEqual(['command.received', 'command.acked']);
  });

  it('SET_PARAMS validates payload and queues params', async () => {
    const g = makeGateway();
    const runner = fakeRunner();
    registerRunnerCommands(g, runner);
    const c = await connect(g);
    await c.expect(isSnapshot);

    c.send({ kind: 'command', commandId: 'cmd-2', type: 'SET_PARAMS', payload: { params: { lots: 2 } } });
    const ok = await c.expect(isAck);
    expect(ok).toMatchObject({ accepted: true, reason: 'APPLIES_WHEN_FLAT' });
    expect(runner.params).toEqual({ lots: 2 });

    c.send({ kind: 'command', commandId: 'cmd-3', type: 'SET_PARAMS', payload: { params: { bad: { nested: 1 } } } });
    const bad = await c.expect(isAck);
    expect(bad).toMatchObject({ commandId: 'cmd-3', accepted: false, reason: 'INVALID_PARAMS' });
  });

  it('unregistered command (KILL before M9) is rejected, never silently accepted', async () => {
    const g = makeGateway();
    registerRunnerCommands(g, fakeRunner());
    const c = await connect(g);
    await c.expect(isSnapshot);

    c.send({ kind: 'command', commandId: 'cmd-4', type: 'KILL' });
    const ack = await c.expect(isAck);
    expect(ack).toMatchObject({ commandId: 'cmd-4', accepted: false, reason: 'UNKNOWN_COMMAND' });
  });

  it('a throwing handler yields a rejected ack, not a dropped command', async () => {
    const g = makeGateway();
    g.onCommand('ACK_PREFLIGHT', () => {
      throw new Error('boom');
    });
    const c = await connect(g);
    await c.expect(isSnapshot);
    c.send({ kind: 'command', commandId: 'cmd-5', type: 'ACK_PREFLIGHT' });
    const ack = await c.expect(isAck);
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toContain('HANDLER_ERROR');
  });
});

describe('journal ingestion into the state tree', () => {
  function makeOrder(state: Order['state']): Order {
    const ids = new IdFactory(SESSION);
    return {
      clientOrderId: ids.clientOrderId(),
      intentId: ids.intentId(),
      sessionId: SESSION,
      instrumentId: INSTR,
      side: 'BUY',
      qty: 65,
      filledQty: 0,
      avgFillPricePaise: 0,
      type: 'LIMIT',
      limitPricePaise: 15_000,
      state,
      purpose: 'ENTRY',
      tag: 's1:entry',
      createdTs: 1,
      updatedTs: 1,
    };
  }

  function ev<K extends JournalEventType>(seq: number, type: K, payload: JournalPayloads[K]): JournalEvent {
    return { seq, ts: seq, type, payload } as JournalEvent;
  }

  it('orders upsert to the latest snapshot; positions open/close; trades append', () => {
    const g = makeGateway();
    const order = makeOrder('SENT');
    g.ingestJournal(ev(1, 'order.created', { order }));
    g.ingestJournal(ev(2, 'order.updated', { order: { ...order, state: 'FILLED', filledQty: 65 }, cause: 'FILL' }));
    expect(g.currentState().orders.length).toBe(1);
    expect(g.currentState().orders[0]?.state).toBe('FILLED');

    const position: Position = {
      positionId: new IdFactory(SESSION).positionId(),
      sessionId: SESSION,
      strategyId: 's1',
      instrumentId: INSTR,
      side: 'BUY',
      qty: 65,
      avgEntryPricePaise: 15_000,
      state: 'OPEN',
      realizedGrossPaise: 0,
      openedTs: 1,
      updatedTs: 1,
    };
    g.ingestJournal(ev(3, 'position.opened', { position }));
    expect(g.currentState().positions.length).toBe(1);
    g.ingestJournal(ev(4, 'position.closed', { positionId: position.positionId, sessionId: SESSION }));
    expect(g.currentState().positions.length).toBe(0);

    const trade = {
      tradeId: new IdFactory(SESSION).tradeId(),
      sessionId: SESSION,
      strategyId: 's1',
      instrumentId: INSTR,
      qty: 65,
      entry: { side: 'BUY', qty: 65, pricePaise: 15_000, ts: 1, clientOrderId: order.clientOrderId },
      exit: { side: 'SELL', qty: 65, pricePaise: 16_000, ts: 2, clientOrderId: order.clientOrderId },
      grossPnlPaise: 65_000,
      charges: { totalPaise: 1_500, components: [] },
      netPnlPaise: 63_500,
      exitReason: 'STOP',
      holdMs: 1,
    } as Trade;
    g.ingestJournal(ev(5, 'trade.completed', { trade }));
    expect(g.currentState().trades.length).toBe(1);

    g.ingestJournal(ev(6, 'strategy.noTrade', { strategyId: 's1', reason: 'COOLDOWN' }));
    expect(g.currentState().algo.lastNoTradeReason).toBe('COOLDOWN');
  });

  it('event ring is capped at eventRingSize keeping the newest', () => {
    const g = makeGateway({ eventRingSize: 5 });
    for (let i = 1; i <= 8; i++) {
      g.ingestJournal(ev(i, 'diag.error', { where: 'test', message: `m${i}` }));
    }
    const events = g.currentState().events;
    expect(events.length).toBe(5);
    expect(events[0]?.seq).toBe(4);
    expect(events[4]?.seq).toBe(8);
  });
});
