import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { makeInstrumentId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import type { FeedHealth, IFeedAdapter, SubscribeRequest } from '../src/feed/interface.js';
import { HubServer } from '../src/hub/server.js';
import { HubUniverse } from '../src/hub/universe.js';

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
});
