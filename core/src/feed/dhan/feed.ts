import type { InstrumentId } from '../../domain/ids.js';
import type { Tick } from '../../domain/marketdata.js';
import type { IFeedAdapter, FeedHealth, SubscribeRequest } from '../interface.js';
import {
  decodeDhanBuffer,
  type DhanFullPacket,
  type DhanIndexPacket,
  type DhanLtpPacket,
  type DhanPacket,
  type DhanQuotePacket,
} from './packet-decoder.js';

const IST_OFFSET_MS = 330 * 60_000;
const IST_OFFSET_TOLERANCE_MS = 10 * 60_000;
const MAX_FUTURE_TICK_MS = 2_000;

export interface DhanFeedOptions {
  wsUrl: string;
  clientId: string;
  accessToken: string | (() => string);
  requestCode?: number;
  reconnectDelayMs?: number;
}

export function dhanPacketToTick(
  p: DhanPacket,
  recvTs: number,
  tokenToInstrument: ReadonlyMap<string, InstrumentId>,
): Tick | null {
  if (p.code !== 1 && p.code !== 2 && p.code !== 4 && p.code !== 8) return null;
  const instrId = tokenToInstrument.get(p.securityId);
  if (instrId === undefined) return null;

  const typed = p as DhanIndexPacket | DhanLtpPacket | DhanQuotePacket | DhanFullPacket;
  const ltpPaise = Math.round(typed.ltp * 100);
  const ts = typed.ltt > 0 ? normalizeDhanLttMs(typed.ltt, recvTs) : recvTs;

  if (typed.code === 1 || typed.code === 2) {
    return {
      instrumentId: instrId,
      ts,
      recvTs,
      ltpPaise,
      qty: 0,
      volume: 0,
      bidPaise: 0,
      askPaise: 0,
      bidQty: 0,
      askQty: 0,
    };
  }

  const q = typed as DhanQuotePacket | DhanFullPacket;
  const top = q.code === 8 ? q.depth[0] : undefined;
  const bidPaise = top !== undefined ? Math.round(top.bidPrice * 100) : 0;
  const askPaise = top !== undefined ? Math.round(top.askPrice * 100) : 0;

  return {
    instrumentId: instrId,
    ts,
    recvTs,
    ltpPaise,
    qty: q.qty,
    volume: q.volume,
    ...(q.code === 8 ? { oi: (q as DhanFullPacket).oi } : {}),
    bidPaise,
    askPaise,
    bidQty: q.code === 8 && top !== undefined ? top.bidQty : q.buyQty,
    askQty: q.code === 8 && top !== undefined ? top.askQty : q.sellQty,
  };
}

function normalizeDhanLttMs(lttSeconds: number, recvTs: number): number {
  const ts = lttSeconds * 1000;
  const futureBy = ts - recvTs;
  if (
    futureBy > IST_OFFSET_MS - IST_OFFSET_TOLERANCE_MS &&
    futureBy < IST_OFFSET_MS + IST_OFFSET_TOLERANCE_MS
  ) {
    return ts - IST_OFFSET_MS;
  }
  if (ts - recvTs > MAX_FUTURE_TICK_MS) return recvTs;
  return ts;
}

/**
 * Dhan v2 WebSocket feed adapter.
 *
 * Wraps the binary WS protocol decoded by `decodeDhanBuffer`. Normalizes
 * packets to the platform's canonical `Tick` type. All monetary values from
 * Dhan are floats in rupees — we convert to integer paise with Math.round.
 *
 * Connection uses Node 22+ built-in WebSocket (undici). Messages arrive as
 * ArrayBuffer for binary frames.
 */
export class DhanFeed implements IFeedAdapter {
  readonly adapterId = 'dhan';
  private ws: WebSocket | null = null;
  private connected = false;
  private shouldReconnect = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private pendingSubscriptions: SubscribeRequest[] = [];
  private tokenToInstrument = new Map<string, InstrumentId>();
  private handler: ((tick: Tick) => void) | undefined;
  private lastTickTs = 0;
  private readonly opts: Required<DhanFeedOptions>;

  constructor(opts: DhanFeedOptions) {
    this.opts = {
      requestCode: 15,
      reconnectDelayMs: 3000,
      ...opts,
    };
  }

  setTickHandler(cb: (tick: Tick) => void): void {
    this.handler = cb;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }
      this.shouldReconnect = true;
      const url = new URL(this.opts.wsUrl);
      url.searchParams.set('version', '2');
      const token = typeof this.opts.accessToken === 'function' ? this.opts.accessToken() : this.opts.accessToken;
      url.searchParams.set('token', token);
      url.searchParams.set('clientId', this.opts.clientId);
      url.searchParams.set('authType', '2');

      let resolved = false;
      const ws = new WebSocket(url.toString());
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.addEventListener('open', () => {
        if (this.ws !== ws) return;
        this.connected = true;
        this.reconnectAttempt = 0;
        this.flushSubscriptions();
        this.startKeepAlive();
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        if (this.ws !== ws || !this.connected) return;
        const data = event.data as ArrayBuffer | string;
        const packets = decodeDhanBuffer(
          typeof data === 'string' ? data : Buffer.from(data),
        );
        const recvTs = Date.now();
        for (const p of packets) {
          const tick = this.packetToTick(p, recvTs);
          if (tick !== null) {
            this.lastTickTs = tick.ts;
            this.handler?.(tick);
          }
        }
      });

      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.stopKeepAlive();
        if (this.shouldReconnect) this.scheduleReconnect();
      });

      ws.addEventListener('error', () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.stopKeepAlive();
        this.ws = null;
        try {
          ws.close();
        } catch {
          /* ignore close failure during error cleanup */
        }
        if (this.shouldReconnect) this.scheduleReconnect();
        if (!resolved) {
          resolved = true;
          reject(new Error('DhanFeed WebSocket connection failed'));
        }
      });
    });
  }

  subscribe(requests: SubscribeRequest[]): void {
    for (const r of requests) {
      this.tokenToInstrument.set(r.brokerToken, r.instrumentId);
    }
    // Accumulate instead of replacing: a reconnect re-flushes pending
    // subscriptions, so earlier subscribe() batches must survive here.
    const byKey = new Map(this.pendingSubscriptions.map((r) => [subscriptionKey(r), r]));
    for (const r of requests) byKey.set(subscriptionKey(r), r);
    this.pendingSubscriptions = [...byKey.values()];
    this.flushSubscriptions();
  }

  private flushSubscriptions(): void {
    if (!this.connected || this.ws === null || this.pendingSubscriptions.length === 0) return;
    const byRequestCode = new Map<number, SubscribeRequest[]>();
    for (const r of this.pendingSubscriptions) {
      const requestCode = r.requestCode ?? this.opts.requestCode;
      const group = byRequestCode.get(requestCode) ?? [];
      group.push(r);
      byRequestCode.set(requestCode, group);
    }
    for (const [requestCode, group] of byRequestCode) {
      const chunks: SubscribeRequest[][] = [];
      for (let i = 0; i < group.length; i += 100) {
        chunks.push(group.slice(i, i + 100));
      }
      for (const chunk of chunks) this.sendSubscriptionChunk(requestCode, chunk);
    }
  }

  private sendSubscriptionChunk(requestCode: number, chunk: SubscribeRequest[]): void {
    if (!this.connected || this.ws === null) return;
    const msg = JSON.stringify({
      RequestCode: requestCode,
      InstrumentCount: chunk.length,
      InstrumentList: chunk.map((r) => ({
        ExchangeSegment: r.exchangeSegment,
        SecurityId: r.brokerToken,
      })),
    });
    try {
      this.ws.send(msg);
    } catch {
      /* connection lost mid-flush; reconnect will re-flush */
    }
  }

  health(): FeedHealth {
    const staleness = Date.now() - this.lastTickTs;
    let status: FeedHealth['status'] = this.connected ? 'CONNECTED' : 'DISCONNECTED';
    if (status === 'CONNECTED' && this.lastTickTs > 0 && staleness > 5_000) status = 'STALE';
    return { status, lastTickTs: this.lastTickTs, tickRatePerSec: 0 };
  }

  close(): Promise<void> {
    this.shouldReconnect = false;
    this.stopKeepAlive();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ RequestCode: 12 }));
      } catch {
        /* ignore */
      }
      this.ws.close();
    }
    this.ws = null;
    this.connected = false;
    return Promise.resolve();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    const exponentialDelay = Math.min(60_000, this.opts.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    // Spread reconnects from the three paper gateways after a Dhan throttle.
    const jitterMs = Math.floor(Math.random() * Math.min(1_000, exponentialDelay * 0.2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.shouldReconnect) void this.connect().catch(() => undefined);
    }, exponentialDelay + jitterMs);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ RequestCode: 1, Message: 'PING' }));
        } catch {
          /* ignore */
        }
      }
    }, 25_000);
    this.keepAliveTimer.unref();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== undefined) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  private packetToTick(
    p: ReturnType<typeof decodeDhanBuffer>[number],
    recvTs: number,
  ): Tick | null {
    return dhanPacketToTick(p, recvTs, this.tokenToInstrument);
  }
}

function subscriptionKey(r: SubscribeRequest): string {
  return `${r.requestCode ?? 'default'}:${r.exchangeSegment}:${r.brokerToken}`;
}
