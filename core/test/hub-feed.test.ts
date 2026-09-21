import { describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { makeInstrumentId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import { HubFeed } from '../src/feed/hub/feed.js';

describe('HubFeed', () => {
  it('connects to hub, subscribes, receives ticks, and detects staleness', async () => {
    let serverSocket: WebSocket | undefined;
    const receivedFromClient: any[] = [];

    // Scripted mock hub server on ephemeral port 0
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const port = (wss.address() as any).port;

    wss.on('connection', (socket) => {
      serverSocket = socket;
      socket.on('message', (data) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const msg = JSON.parse(trimmed);
          receivedFromClient.push(msg);
          if (msg.t === 'hello') {
            socket.send(
              JSON.stringify({
                t: 'welcome',
                proto: 1,
                sessionId: 'TEST-SESSION',
                universeVersion: 1,
              }) + '\n',
            );
          }
        }
      });
    });

    const feed = new HubFeed({
      url: `ws://127.0.0.1:${port}`,
      clientId: 'test-desk',
      staleTimeoutMs: 100, // Short timeout for testing
    });

    // 1. Initial health before connect
    expect(feed.health().status).toBe('DISCONNECTED');

    // 2. Connect
    await feed.connect();
    expect(feed.health().status).toBe('CONNECTED');
    expect(receivedFromClient.some((m) => m.t === 'hello' && m.client === 'test-desk')).toBe(true);

    // 3. Subscribe instruments
    feed.subscribe([
      {
        exchangeSegment: 'NSE_FNO',
        brokerToken: '7777',
        instrumentId: makeInstrumentId('NSE', '7777'),
      },
    ]);

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedFromClient.some((m) => m.t === 'sub')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    const subMsg = receivedFromClient.find((m) => m.t === 'sub');
    expect(subMsg.instruments[0].brokerToken).toBe('7777');

    // 4. Receive tick
    const ticksReceived: Tick[] = [];
    feed.setTickHandler((t) => ticksReceived.push(t));

    const sampleTick: Tick = {
      instrumentId: makeInstrumentId('NSE', '7777'),
      ts: Date.now(),
      recvTs: Date.now(),
      ltpPaise: 2450000,
      qty: 25,
      volume: 5000,
      bidPaise: 2449500,
      askPaise: 2450500,
      bidQty: 50,
      askQty: 50,
    };

    serverSocket?.send(JSON.stringify({ t: 'tick', d: sampleTick }) + '\n');

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ticksReceived.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(ticksReceived[0]?.ltpPaise).toBe(2450000);

    // 5. Silence detection -> STALE
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(feed.health().status).toBe('STALE');

    // Sending a health heartbeat recovers it
    serverSocket?.send(
      JSON.stringify({
        t: 'health',
        status: 'CONNECTED',
        lastTickTs: Date.now(),
        tickRatePerSec: 10,
      }) + '\n',
    );
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (feed.health().status === 'CONNECTED') {
          clearInterval(check);
          resolve(undefined);
        }
      }, 10);
    });
    expect(feed.health().status).toBe('CONNECTED');

    // 6. Hub reporting DISCONNECTED reflects as DISCONNECTED
    serverSocket?.send(
      JSON.stringify({
        t: 'health',
        status: 'DISCONNECTED',
        lastTickTs: Date.now(),
        tickRatePerSec: 0,
      }) + '\n',
    );
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (feed.health().status === 'DISCONNECTED') {
          clearInterval(check);
          resolve(undefined);
        }
      }, 10);
    });
    expect(feed.health().status).toBe('DISCONNECTED');

    await feed.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('automatically re-subscribes upon reconnect', async () => {
    let connectionCount = 0;
    const receivedMessages: any[] = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const port = (wss.address() as any).port;

    wss.on('connection', (socket) => {
      connectionCount++;
      socket.on('message', (data) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const msg = JSON.parse(trimmed);
          receivedMessages.push({ conn: connectionCount, ...msg });
          if (msg.t === 'hello') {
            socket.send(JSON.stringify({ t: 'welcome', proto: 1 }) + '\n');
          }
        }
      });
    });

    const feed = new HubFeed({
      url: `ws://127.0.0.1:${port}`,
      clientId: 'reconnect-desk',
      reconnectMinMs: 50,
      reconnectMaxMs: 100,
    });

    await feed.connect();

    // Subscribe
    feed.subscribe([
      {
        exchangeSegment: 'NSE_FNO',
        brokerToken: '1234',
        instrumentId: makeInstrumentId('NSE', '1234'),
      },
    ]);

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedMessages.some((m) => m.conn === 1 && m.t === 'sub')) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    // Terminate first connection from server side to simulate drop
    for (const client of wss.clients) {
      client.terminate();
    }

    // Wait for reconnection and auto-resubscription
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedMessages.some((m) => m.conn === 2 && m.t === 'sub')) {
          clearInterval(check);
          resolve();
        }
      }, 50);
    });

    const subOnConn2 = receivedMessages.find((m) => m.conn === 2 && m.t === 'sub');
    expect(subOnConn2).toBeDefined();
    expect(subOnConn2.instruments[0].brokerToken).toBe('1234');

    await feed.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});
