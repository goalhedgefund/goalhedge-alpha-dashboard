import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { makeInstrumentId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import type { FeedHealth, IFeedAdapter, SubscribeRequest } from '../src/feed/interface.js';
import { HubServer } from '../src/hub/server.js';
import { HubUniverse } from '../src/hub/universe.js';
import { MAX_HUB_FRAME_BYTES } from '../src/hub/protocol-v2.js';

class MockFeed implements IFeedAdapter {
  readonly adapterId = 'mock-dhan';
  public connected = false;
  public subscriptions: SubscribeRequest[] = [];
  public handler: ((tick: Tick) => void) | undefined;
  public status: FeedHealth['status'] = 'CONNECTED';

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  subscribe(requests: SubscribeRequest[]): void {
    this.subscriptions.push(...requests);
  }

  setTickHandler(cb: (tick: Tick) => void): void {
    this.handler = cb;
  }

  health(): FeedHealth {
    return {
      status: this.status,
      lastTickTs: Date.now(),
      tickRatePerSec: 10,
    };
  }

  close(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }

  emitTick(tick: Tick): void {
    this.handler?.(tick);
  }
}

describe('HubServer', () => {
  it('serves §4 protocol and fans out ticks with expand-only subscriptions', async () => {
    const mockFeed = new MockFeed();
    const universe = new HubUniverse([
      {
        exchangeSegment: 'NSE_FNO',
        brokerToken: '9999',
        instrumentId: makeInstrumentId('NSE', '9999'),
      },
    ]);

    // Use ephemeral port 0 so it never conflicts with anything
    const hub = new HubServer({
      port: 0,
      host: '127.0.0.1',
      universe,
      feed: mockFeed,
      staleThresholdMs: 1000,
    });

    await hub.start();
    const port = (hub['wss'].address() as any).port;

    // Connect WS client
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) received.push(JSON.parse(trimmed));
      }
    });

    // 1. Send hello
    ws.send(JSON.stringify({ t: 'hello', client: 'S1', proto: 1 }) + '\n');

    // Wait for welcome
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.some((m) => m.t === 'welcome')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    const welcome = received.find((m) => m.t === 'welcome');
    expect(welcome.proto).toBe(1);
    expect(welcome.universeVersion).toBe(1);

    // 2. Send ping
    ws.send(JSON.stringify({ t: 'ping' }) + '\n');
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.some((m) => m.t === 'pong')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    // 3. Send subscription expansion
    ws.send(
      JSON.stringify({
        t: 'sub',
        instruments: [{ exchangeSegment: 'NSE_FNO', brokerToken: '8888' }],
      }) + '\n',
    );

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.some((m) => m.t === 'subAck')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    const subAck = received.find((m) => m.t === 'subAck');
    expect(subAck.added).toBe(1);
    expect(subAck.universeVersion).toBe(2);
    expect(mockFeed.subscriptions.some((s) => s.brokerToken === '8888')).toBe(true);

    // 4. Emit tick from feed and verify client gets tick verbatim
    const sampleTick: Tick = {
      instrumentId: makeInstrumentId('NSE', '8888'),
      ts: Date.now(),
      recvTs: Date.now(),
      ltpPaise: 2505000,
      qty: 50,
      volume: 12000,
      bidPaise: 2504900,
      askPaise: 2505100,
      bidQty: 100,
      askQty: 150,
    };

    mockFeed.emitTick(sampleTick);

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.some((m) => m.t === 'tick')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    const tickMsg = received.find((m) => m.t === 'tick');
    expect(tickMsg.d.instrumentId).toBe(sampleTick.instrumentId);
    expect(tickMsg.d.ltpPaise).toBe(2505000);

    ws.close();
    await hub.close();
  });

  it('serves a validated v2 handshake with idempotent subscriptions and structured errors', async () => {
    const mockFeed = new MockFeed();
    const hub = new HubServer({ port: 0, host: '127.0.0.1', feed: mockFeed });
    await hub.start();
    const port = (hub['wss'].address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const received: any[] = [];
    ws.on('message', (data) => {
      for (const line of data.toString().split('\n')) {
        if (line.trim()) received.push(JSON.parse(line));
      }
    });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > 2_000) throw new Error('timed out waiting for hub frame');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    ws.send(JSON.stringify({ t: 'sub', requestId: 'before-hello', instruments: [{ exchangeSegment: 'NSE_FNO', brokerToken: '1' }] }) + '\n');
    await waitFor(() => received.some((m) => m.code === 'HANDSHAKE_REQUIRED'));

    ws.send(JSON.stringify({ t: 'hello', proto: 2, clientId: 's1', instanceId: 's1-test-1', lastSessionId: null, lastSequence: 0 }) + '\n');
    await waitFor(() => received.some((m) => m.t === 'welcome' && m.proto === 2));
    const welcome = received.find((m) => m.t === 'welcome' && m.proto === 2);
    expect(welcome.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(welcome.providerEpoch).toBe(1);
    const serverClient = Array.from((hub as any).clients)[0] as any;
    expect(serverClient.responseByRequestId).toBeInstanceOf(Map);
    expect((hub as any).wss.options.maxPayload).toBe(MAX_HUB_FRAME_BYTES);

    ws.send(JSON.stringify({ t: 'status', requestId: 'status-1' }) + '\n');
    await waitFor(() => received.some((m) => m.t === 'status' && m.requestId === 'status-1'));
    expect(received.find((m) => m.t === 'status' && m.requestId === 'status-1')).toMatchObject({ recorder: { status: 'HEALTHY' } });

    // A v2 client receives only instruments it actively owns.
    mockFeed.emitTick({
      instrumentId: makeInstrumentId('NSE', 'unowned'), ts: Date.now(), recvTs: Date.now(), ltpPaise: 1,
      qty: 1, volume: 1, bidPaise: 1, askPaise: 1, bidQty: 1, askQty: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received.some((m) => m.t === 'tick')).toBe(false);
    (hub as any).sendHealth(serverClient);
    await waitFor(() => received.filter((m) => m.t === 'health').length >= 2);
    expect(received.filter((m) => m.t === 'health').at(-1)).toMatchObject({ lastTickTs: expect.any(Number), lastRelevantTickAt: 0 });

    const sub = { t: 'sub', requestId: 's1-sub-1', instruments: [{ exchangeSegment: 'NSE_FNO', brokerToken: '8888' }] };
    ws.send(JSON.stringify(sub) + '\n');
    await waitFor(() => received.some((m) => m.t === 'subAck' && m.requestId === 's1-sub-1'));
    ws.send(JSON.stringify(sub) + '\n');
    await waitFor(() => received.filter((m) => m.t === 'subAck' && m.requestId === 's1-sub-1').length === 2);
    expect(mockFeed.subscriptions.filter((s) => s.brokerToken === '8888')).toHaveLength(1);

    ws.send('{not-json}\n');
    ws.send(JSON.stringify({ t: 'future-command', requestId: 'unknown-1' }) + '\n');
    await waitFor(() => received.some((m) => m.code === 'MALFORMED_JSON'));
    await waitFor(() => received.some((m) => m.code === 'UNKNOWN_MESSAGE' && m.requestId === 'unknown-1'));

    mockFeed.emitTick({
      instrumentId: makeInstrumentId('NSE', '8888'), ts: Date.now(), recvTs: Date.now(), ltpPaise: 12345,
      qty: 1, volume: 1, bidPaise: 12340, askPaise: 12350, bidQty: 1, askQty: 1,
    });
    await waitFor(() => received.some((m) => m.t === 'tick' && m.proto === 2));
    const tick = received.find((m) => m.t === 'tick' && m.proto === 2);
    expect(tick.sequence).toBeGreaterThan(0);
    expect(tick.sessionId).toBe(welcome.sessionId);
    (hub as any).sendHealth(serverClient);
    await waitFor(() => received.filter((m) => m.t === 'health').at(-1)?.lastRelevantTickAt > 0);

    ws.send(JSON.stringify({ t: 'unsub', requestId: 's1-unsub-1', instruments: [{ exchangeSegment: 'NSE_FNO', brokerToken: '8888' }] }) + '\n');
    await waitFor(() => received.some((m) => m.t === 'unsubAck' && m.requestId === 's1-unsub-1'));
    const tickCountBeforeUnsub = received.filter((m) => m.t === 'tick').length;
    mockFeed.emitTick({
      instrumentId: makeInstrumentId('NSE', '8888'), ts: Date.now(), recvTs: Date.now(), ltpPaise: 12346,
      qty: 1, volume: 1, bidPaise: 12341, askPaise: 12351, bidQty: 1, askQty: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received.filter((m) => m.t === 'tick')).toHaveLength(tickCountBeforeUnsub);

    ws.close();
    await hub.close();
  });

  it('bounds each connection request-response cache', async () => {
    const hub = new HubServer({ port: 0, host: '127.0.0.1', feed: new MockFeed(), maxResponseCacheEntries: 2 });
    await hub.start();
    const port = ((hub as any).wss.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const received: any[] = [];
    ws.on('message', (data) => data.toString().split('\n').filter(Boolean).forEach((line) => received.push(JSON.parse(line))));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > 2_000) throw new Error('timed out waiting for hub frame');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    ws.send(JSON.stringify({ t: 'hello', proto: 2, clientId: 'bounded', instanceId: 'bounded-1' }) + '\n');
    await waitFor(() => received.some((m) => m.t === 'welcome'));
    for (const id of ['one', 'two', 'three']) {
      ws.send(JSON.stringify({ t: 'sub', requestId: id, instruments: [{ exchangeSegment: 'NSE_FNO', brokerToken: id }] }) + '\n');
      await waitFor(() => received.some((m) => m.t === 'subAck' && m.requestId === id));
    }
    const client = Array.from((hub as any).clients)[0] as any;
    expect(client.responseByRequestId.size).toBe(2);
    expect(client.responseByRequestId.has('one')).toBe(false);
    expect(client.responseByRequestId.has('two')).toBe(true);
    expect(client.responseByRequestId.has('three')).toBe(true);
    ws.close();
    await hub.close();
  });

  it('latches recorder failures without crashing the provider tick path', async () => {
    const mockFeed = new MockFeed();
    const hub = new HubServer({
      port: 0, host: '127.0.0.1', feed: mockFeed,
      recorder: { record: () => { throw new Error('disk full'); }, close: async () => undefined } as any,
    });
    await hub.start();
    mockFeed.emitTick({
      instrumentId: makeInstrumentId('NSE', 'recorder-test'), ts: Date.now(), recvTs: Date.now(), ltpPaise: 1,
      qty: 1, volume: 1, bidPaise: 1, askPaise: 1, bidQty: 1, askQty: 1,
    });
    expect(hub.diagnostics()).toMatchObject({ recorder: { status: 'FAILED', errorCategory: 'Error' } });
    await hub.close();
  });
});
