/**
 * GatewayClient protocol unit tests — mirror the server contract pinned by
 * core/test/gateway.test.ts, using an injected fake WebSocket.
 */
import { describe, expect, it } from 'vitest';
import type { GatewayState, ServerMsg } from '@proto';
import { GatewayClient, type WsLike } from '../src/lib/gateway-client.js';

class FakeWs implements WsLike {
  sent: string[] = [];
  private handlers = new Map<string, Array<(ev: { data?: unknown }) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.fire('close', {});
  }

  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }

  fire(type: string, ev: { data?: unknown }): void {
    for (const cb of this.handlers.get(type) ?? []) cb(ev);
  }

  receive(msg: ServerMsg): void {
    this.fire('message', { data: JSON.stringify(msg) });
  }

  sentKinds(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { kind: string }).kind);
  }
}

function mkState(phase = 'PREFLIGHT'): GatewayState {
  return {
    session: { sessionId: 's', mode: 'paper', phase, date: '2026-07-03' },
    kill: { state: 'READY' },
    health: { feedStatus: 'CONNECTED', lastTickTs: 0, gatewayTs: 0 },
    algo: { strategyId: 's1', lifecycle: 'DISARMED', params: {} },
    risk: {
      snapshot: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
      limits: { dailyMaxLossPaise: 1, perTradeRiskPaise: 1, maxTradesPerDay: 1, maxConcurrentPositions: 1 },
    },
    positions: [],
    orders: [],
    trades: [],
    chain: [],
    bars: [],
    events: [],
  };
}

function connected(opts: { cmdTimeoutMs?: number } = {}): { client: GatewayClient; ws: FakeWs } {
  const ws = new FakeWs();
  const client = new GatewayClient({ url: 'ws://test', makeWs: () => ws, ...opts });
  client.connect();
  return { client, ws };
}

describe('snapshot + delta reconstruction', () => {
  it('snapshot replaces state, sets baseline seq, goes LIVE', () => {
    const { client, ws } = connected();
    ws.receive({ kind: 'snapshot', v: 1, seq: 1, state: mkState() });
    expect(client.state?.session.phase).toBe('PREFLIGHT');
    expect(client.lastSeq).toBe(1);
    expect(client.status).toBe('LIVE');
    expect(client.stats.snapshots).toBe(1);
  });

  it('in-order deltas apply and advance seq', () => {
    const { client, ws } = connected();
    ws.receive({ kind: 'snapshot', v: 1, seq: 1, state: mkState() });
    ws.receive({
      kind: 'delta',
      v: 1,
      seq: 2,
      changes: [{ path: 'session', value: { ...mkState().session, phase: 'OPEN' } }],
    });
    expect(client.state?.session.phase).toBe('OPEN');
    expect(client.lastSeq).toBe(2);
    expect(client.stats.deltas).toBe(1);
    expect(ws.sentKinds()).toEqual([]); // nothing requested
  });

  it('onChange fires per applied message', () => {
    const { client, ws } = connected();
    let n = 0;
    client.onChange = () => n++;
    ws.receive({ kind: 'snapshot', v: 1, seq: 1, state: mkState() });
    ws.receive({ kind: 'delta', v: 1, seq: 2, changes: [] });
    expect(n).toBe(2);
  });
});

describe('gap detection → resnapshot', () => {
  it('gapped delta is NOT applied; resnapshot requested; snapshot recovers', () => {
    const { client, ws } = connected();
    ws.receive({ kind: 'snapshot', v: 1, seq: 1, state: mkState() });
    ws.receive({
      kind: 'delta',
      v: 1,
      seq: 3, // gap: expected 2
      changes: [{ path: 'session', value: { ...mkState().session, phase: 'OPEN' } }],
    });
    expect(client.state?.session.phase).toBe('PREFLIGHT'); // unchanged
    expect(client.stats.gaps).toBe(1);
    expect(client.stats.resnapshots).toBe(1);
    expect(ws.sentKinds()).toEqual(['resnapshot']);

    ws.receive({ kind: 'snapshot', v: 1, seq: 4, state: mkState('OPEN') });
    expect(client.state?.session.phase).toBe('OPEN');
    expect(client.lastSeq).toBe(4);
  });

  it('heartbeat with a mismatched seq forces resnapshot; matching hb is silent', () => {
    const { client, ws } = connected();
    ws.receive({ kind: 'snapshot', v: 1, seq: 1, state: mkState() });
    ws.receive({ kind: 'hb', ts: 1, seq: 1 });
    expect(client.stats.resnapshots).toBe(0);
    ws.receive({ kind: 'hb', ts: 2, seq: 5 }); // we missed deltas
    expect(client.stats.gaps).toBe(1);
    expect(ws.sentKinds()).toEqual(['resnapshot']);
  });

  it('delta before any snapshot is a gap', () => {
    const { client, ws } = connected();
    ws.receive({ kind: 'delta', v: 1, seq: 1, changes: [] });
    expect(client.stats.gaps).toBe(1);
    expect(client.state).toBeUndefined();
  });

  it('skipSeq() test hook makes the next delta look gapped', () => {
    const { client, ws } = connected();
    ws.receive({ kind: 'snapshot', v: 1, seq: 1, state: mkState() });
    client.skipSeq();
    ws.receive({ kind: 'delta', v: 1, seq: 2, changes: [] });
    expect(client.stats.gaps).toBe(1);
    expect(client.stats.resnapshots).toBe(1);
  });
});

describe('command channel', () => {
  it('sends cmd-<n> ids and resolves on ack', async () => {
    const { client, ws } = connected();
    ws.receive({ kind: 'snapshot', v: 1, seq: 1, state: mkState() });
    const p = client.command('ARM');
    const sent = JSON.parse(ws.sent[0] as string) as { commandId: string; type: string };
    expect(sent).toMatchObject({ commandId: 'cmd-1', type: 'ARM' });
    ws.receive({ kind: 'ack', commandId: 'cmd-1', accepted: true, reason: 'ARMED' });
    await expect(p).resolves.toEqual({ accepted: true, reason: 'ARMED' });
  });

  it('rejected acks surface the reason', async () => {
    const { client, ws } = connected();
    const p = client.command('KILL');
    ws.receive({ kind: 'ack', commandId: 'cmd-1', accepted: false, reason: 'UNKNOWN_COMMAND' });
    await expect(p).resolves.toEqual({ accepted: false, reason: 'UNKNOWN_COMMAND' });
  });

  it('unanswered commands resolve TIMEOUT', async () => {
    const { client } = connected({ cmdTimeoutMs: 20 });
    const r = await client.command('ARM');
    expect(r).toEqual({ accepted: false, reason: 'TIMEOUT' });
  });
});

describe('staleness', () => {
  it('tickStale flips LIVE → STALE when messages stop, and back on traffic', () => {
    let now = 1_000;
    const ws = new FakeWs();
    const client = new GatewayClient({
      url: 'ws://test',
      makeWs: () => ws,
      staleAfterMs: 100,
      now: () => now,
    });
    client.connect();
    ws.receive({ kind: 'snapshot', v: 1, seq: 1, state: mkState() });
    expect(client.status).toBe('LIVE');

    now += 200;
    client.tickStale();
    expect(client.status).toBe('STALE');

    ws.receive({ kind: 'hb', ts: now, seq: 1 });
    client.tickStale();
    expect(client.status).toBe('LIVE');
  });
});
