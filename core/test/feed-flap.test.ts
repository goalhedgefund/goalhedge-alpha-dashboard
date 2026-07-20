import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeInstrumentId } from '../src/domain/ids.js';
import { DhanFeed } from '../src/feed/dhan/feed.js';

type Listener = (event: { data?: string }) => void;

const instances: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  binaryType = '';
  readyState = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    const next = this.listeners.get(type) ?? [];
    next.push(cb);
    this.listeners.set(type, next);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  emit(type: 'open' | 'message' | 'close' | 'error', event: { data?: string } = {}): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
}

function packet(securityId: string, ltp: number, ltt = 1): string {
  return JSON.stringify({
    code: 2,
    length: 16,
    exchangeSegment: 'NSE_FNO',
    securityId,
    rawLength: 16,
    ltp,
    ltt,
  });
}

function subMessages(ws: FakeWebSocket): Array<{ InstrumentCount: number; InstrumentList: Array<{ SecurityId: string }> }> {
  return ws.sent
    .map((s) => JSON.parse(s) as { RequestCode?: number; InstrumentCount: number; InstrumentList: Array<{ SecurityId: string }> })
    .filter((m) => m.RequestCode === 15);
}

describe('DhanFeed feed-flap behavior (03-TESTING-PLAN §4)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    instances.length = 0;
  });

  it('dedupes subscriptions across a reconnect storm and ignores stale socket ticks', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const token1 = makeInstrumentId('NSE', '101');
    const token2 = makeInstrumentId('NSE', '102');
    const ticks: number[] = [];
    const feed = new DhanFeed({
      wsUrl: 'ws://feed.example/socket',
      clientId: 'client',
      accessToken: 'token',
      reconnectDelayMs: 10,
    });
    feed.setTickHandler((tick) => ticks.push(tick.ltpPaise));

    feed.subscribe([
      { exchangeSegment: 'NSE_FNO', brokerToken: '101', instrumentId: token1 },
      { exchangeSegment: 'NSE_FNO', brokerToken: '101', instrumentId: token1 },
    ]);
    const connecting = feed.connect();
    const first = instances[0]!;
    first.emit('open');
    await connecting;

    expect(subMessages(first).at(-1)).toMatchObject({
      InstrumentCount: 1,
      InstrumentList: [{ SecurityId: '101' }],
    });
    first.emit('message', { data: packet('101', 111.25) });

    feed.subscribe([
      { exchangeSegment: 'NSE_FNO', brokerToken: '101', instrumentId: token1 },
      { exchangeSegment: 'NSE_FNO', brokerToken: '102', instrumentId: token2 },
    ]);
    expect(subMessages(first).at(-1)).toMatchObject({
      InstrumentCount: 2,
      InstrumentList: [{ SecurityId: '101' }, { SecurityId: '102' }],
    });

    first.emit('close');
    first.emit('close');
    await vi.advanceTimersByTimeAsync(10);
    expect(instances).toHaveLength(2);
    const second = instances[1]!;
    second.emit('open');

    expect(subMessages(second)).toHaveLength(1);
    expect(subMessages(second)[0]).toMatchObject({
      InstrumentCount: 2,
      InstrumentList: [{ SecurityId: '101' }, { SecurityId: '102' }],
    });

    first.emit('message', { data: packet('101', 222.5) });
    second.emit('message', { data: packet('101', 333.75) });

    expect(ticks).toEqual([11_125, 33_375]);
    await feed.close();
  });
});
