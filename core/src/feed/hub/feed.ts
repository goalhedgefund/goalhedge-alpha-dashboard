import { WebSocket as WsSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { Tick } from '../../domain/marketdata.js';
import type { FeedHealth, FeedStatus, IFeedAdapter, SubscribeRequest } from '../interface.js';
import { HUB_PROTOCOL_V2 } from '../../hub/protocol-v2.js';

export interface HubFeedOptions {
  /** Hub WebSocket URL. Defaults to 'ws://127.0.0.1:8795'. */
  url?: string;
  /** Desk or client identifier, e.g. 'S1', 'ALL_OP'. */
  clientId?: string;
  /** Stable process identity required by the opt-in protocol-v2 path. */
  instanceId?: string;
  /** Defaults to legacy protocol v1. Set only from useSharedHubTransport. */
  protocolVersion?: 1 | 2;
  /** Staleness timeout in milliseconds. Defaults to 5,000ms. */
  staleTimeoutMs?: number;
  /** Minimum reconnect delay in milliseconds. Defaults to 1,000ms. */
  reconnectMinMs?: number;
  /** Maximum reconnect delay in milliseconds. Defaults to 30,000ms. */
  reconnectMaxMs?: number;
}

/**
 * HubFeed is the 3rd IFeedAdapter implementation.
 *
 * It connects to the standalone Workstation Feed Hub over loopback WS (127.0.0.1:8795),
 * receives normalized Tick objects verbatim, tracks silence/staleness,
 * and automatically re-subscribes upon reconnect without opening Dhan sockets.
 */
export class HubFeed implements IFeedAdapter {
  readonly adapterId: string;

  private ws: WsSocket | null = null;
  private connected = false;
  private shouldReconnect = true;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private handler: ((tick: Tick) => void) | undefined;

  private readonly subscriptions = new Map<string, SubscribeRequest>();
  private lastTickTs = 0;
  private lastMessageTs = 0;
  private hubReportedStatus: FeedStatus = 'DISCONNECTED';
  private tickCountInWindow = 0;
  private tickRatePerSec = 0;
  private rateTimer: NodeJS.Timeout | undefined;

  private readonly url: string;
  private readonly clientId: string;
  private readonly instanceId: string;
  private readonly protocolVersion: 1 | 2;
  private readonly staleTimeoutMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private requestSequence = 0;
  private lastSessionId: string | null = null;
  private lastSequence: number | null = null;
  private lastProviderEpoch: number | null = null;
  private resyncRequired = false;
  private lastSubscriptionError: string | undefined;
  private readonly pendingSubscriptionRequests = new Set<string>();

  constructor(opts: HubFeedOptions = {}) {
    this.url = opts.url ?? 'ws://127.0.0.1:8795';
    this.clientId = opts.clientId ?? 'hub-client';
    this.protocolVersion = opts.protocolVersion ?? 1;
    this.instanceId = opts.instanceId ?? `${this.clientId}-${process.pid}-${randomUUID()}`;
    this.adapterId = this.protocolVersion === HUB_PROTOCOL_V2 ? 'hub-v2' : 'hub';
    this.staleTimeoutMs = opts.staleTimeoutMs ?? 5_000;
    this.reconnectMinMs = opts.reconnectMinMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
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
      let resolved = false;

      const ws = new WsSocket(this.url);
      this.ws = ws;

      const finishConnect = (err?: Error): void => {
        if (resolved) return;
        resolved = true;
        if (err) reject(err);
        else resolve();
      };

      ws.on('open', () => {
        if (this.ws !== ws) return;
        // Send hello handshake frame (§4)
        const hello = JSON.stringify(this.protocolVersion === HUB_PROTOCOL_V2
          ? { t: 'hello', proto: HUB_PROTOCOL_V2, clientId: this.clientId, instanceId: this.instanceId, lastSessionId: this.lastSessionId, lastSequence: this.lastSequence ?? undefined }
          : { t: 'hello', client: this.clientId, proto: 1 }) + '\n';
        try {
          ws.send(hello);
        } catch (err: any) {
          finishConnect(err);
        }
      });

      ws.on('message', (raw) => {
        if (this.ws !== ws) return;
        const text = raw.toString();
        const lines = text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as Record<string, any>;
            const t = msg.t;
            this.lastMessageTs = Date.now();

            if (t === 'welcome') {
              if (msg.proto !== this.protocolVersion) {
                finishConnect(new Error(`Hub protocol mismatch: expected ${this.protocolVersion}, got ${String(msg.proto)}`));
                ws.close();
                return;
              }
              this.connected = true;
              if (this.protocolVersion === HUB_PROTOCOL_V2) {
                if (typeof msg.sessionId === 'string' && this.lastSessionId !== null && this.lastSessionId !== msg.sessionId) {
                  this.resyncRequired = true;
                  this.lastSequence = null;
                }
                if (typeof msg.sessionId === 'string') this.lastSessionId = msg.sessionId;
                if (typeof msg.providerEpoch === 'number') this.lastProviderEpoch = msg.providerEpoch;
              }
              this.hubReportedStatus = 'CONNECTED';
              this.reconnectAttempt = 0;
              this.startRateTimer();
              // Re-subscribe on reconnect: adapter replays its registered subscriptions (§5 H2)
              this.flushSubscriptions();
              // The desired set has been replayed on the new session. A later
              // sequence/epoch gap will set this again if replay is incomplete.
              this.resyncRequired = false;
              finishConnect();
            } else if (t === 'tick') {
              const tick = msg.d as Tick;
              if (tick) {
                this.lastTickTs = tick.ts || Date.now();
                if (this.protocolVersion === HUB_PROTOCOL_V2) {
                  const sequence = typeof msg.sequence === 'number' ? msg.sequence : undefined;
                  const epoch = typeof msg.providerEpoch === 'number' ? msg.providerEpoch : undefined;
                  if (epoch !== undefined && this.lastProviderEpoch !== null && epoch !== this.lastProviderEpoch) this.resyncRequired = true;
                  if (sequence !== undefined && this.lastSequence !== null && sequence !== this.lastSequence + 1) this.resyncRequired = true;
                  if (epoch !== undefined) this.lastProviderEpoch = epoch;
                  if (sequence !== undefined) this.lastSequence = sequence;
                }
                this.tickCountInWindow++;
                this.handler?.(tick);
              }
            } else if (t === 'health') {
              if (typeof msg.status === 'string') {
                this.hubReportedStatus = msg.status as FeedStatus;
              }
            } else if (t === 'subAck') {
              if (typeof msg.requestId === 'string') this.pendingSubscriptionRequests.delete(msg.requestId);
              if (msg.ok === false) {
                this.lastSubscriptionError = `hub rejected subscription: ${typeof msg.code === 'string' ? msg.code : 'UNKNOWN'}`;
              } else if (this.pendingSubscriptionRequests.size === 0) {
                this.lastSubscriptionError = undefined;
              }
            } else if (t === 'error') {
              const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
              const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN';
              if (requestId === undefined || this.pendingSubscriptionRequests.delete(requestId)) {
                this.lastSubscriptionError = `hub rejected subscription${requestId ? ` (${requestId})` : ''}: ${code}`;
              }
              if (!this.connected) finishConnect(new Error(`Hub rejected connection: ${code}`));
            }
          } catch {
            // Ignore malformed lines
          }
        }
      });

      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.stopRateTimer();
        this.ws = null;
        if (!resolved) {
          finishConnect(new Error(`HubFeed WebSocket closed before welcome (${this.url})`));
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.stopRateTimer();
        this.ws = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
        if (!resolved) {
          finishConnect(err);
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  subscribe(requests: SubscribeRequest[]): void {
    for (const r of requests) {
      const key = `${r.exchangeSegment}:${r.brokerToken}`;
      this.subscriptions.set(key, r);
    }
    if (this.connected && this.ws && this.ws.readyState === WsSocket.OPEN) {
      this.sendSubscriptionChunk(requests);
    }
  }

  private flushSubscriptions(): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WsSocket.OPEN) return;
    const all = Array.from(this.subscriptions.values());
    if (all.length === 0) return;

    // Send in chunks of 100
    for (let i = 0; i < all.length; i += 100) {
      const chunk = all.slice(i, i + 100);
      this.sendSubscriptionChunk(chunk);
    }
  }

  private sendSubscriptionChunk(chunk: SubscribeRequest[]): void {
    if (!this.ws || this.ws.readyState !== WsSocket.OPEN) return;
    const requestId = `${this.clientId}-sub-${++this.requestSequence}`;
    const payload = JSON.stringify(this.protocolVersion === HUB_PROTOCOL_V2
      ? {
          t: 'sub', requestId,
          instruments: chunk.map((r) => ({ exchangeSegment: r.exchangeSegment, brokerToken: r.brokerToken })),
        }
      : {
          t: 'sub',
          instruments: chunk.map((r) => ({ exchangeSegment: r.exchangeSegment, brokerToken: r.brokerToken })),
        }) + '\n';
    try {
      if (this.protocolVersion === HUB_PROTOCOL_V2) this.pendingSubscriptionRequests.add(requestId);
      this.ws.send(payload);
    } catch {
      // Reconnect will re-send
    }
  }

  /**
   * Health reporting:
   * - If disconnected: DISCONNECTED.
   * - If connected but no message/tick received within staleness window: STALE.
   * - If hub reports DISCONNECTED or STALE: reflects that status.
   * - Never fakes CONNECTED during data absence.
   */
  health(): FeedHealth {
    if (!this.connected) {
      return {
        status: 'DISCONNECTED',
        lastTickTs: this.lastTickTs,
        tickRatePerSec: 0,
        detail: 'disconnected from hub',
      };
    }

    const silenceMs = Date.now() - this.lastMessageTs;
    if (this.lastMessageTs > 0 && silenceMs > this.staleTimeoutMs) {
      return {
        status: 'STALE',
        lastTickTs: this.lastTickTs,
        tickRatePerSec: 0,
        detail: `hub silent for ${Math.round(silenceMs / 1000)}s`,
      };
    }

    if (this.hubReportedStatus === 'DISCONNECTED') {
      return {
        status: 'DISCONNECTED',
        lastTickTs: this.lastTickTs,
        tickRatePerSec: 0,
        detail: 'hub reports disconnected from Dhan',
      };
    }

    if (this.hubReportedStatus === 'STALE') {
      return {
        status: 'STALE',
        lastTickTs: this.lastTickTs,
        tickRatePerSec: this.tickRatePerSec,
        detail: 'hub reports stale Dhan feed',
      };
    }

    if (this.resyncRequired) {
      return {
        status: 'STALE', lastTickTs: this.lastTickTs, tickRatePerSec: this.tickRatePerSec,
        detail: 'hub session, provider epoch, or sequence discontinuity; resubscription required',
      };
    }

    if (this.lastSubscriptionError !== undefined) {
      return {
        status: 'STALE', lastTickTs: this.lastTickTs, tickRatePerSec: this.tickRatePerSec,
        detail: this.lastSubscriptionError,
      };
    }

    return {
      status: 'CONNECTED',
      lastTickTs: this.lastTickTs,
      tickRatePerSec: this.tickRatePerSec,
      detail: 'hub streaming',
    };
  }

  close(): Promise<void> {
    this.shouldReconnect = false;
    this.stopRateTimer();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.connected = false;
    return Promise.resolve();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || !this.shouldReconnect) return;

    // Own backoff to the hub: 1s → 30s (§5 H2)
    const exponential = Math.min(
      this.reconnectMaxMs,
      this.reconnectMinMs * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    this.reconnectAttempt += 1;
    const jitter = Math.floor(Math.random() * Math.min(500, exponential * 0.2));
    const delay = exponential + jitter;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.shouldReconnect) {
        void this.connect().catch(() => undefined);
      }
    }, delay);
  }

  private startRateTimer(): void {
    this.stopRateTimer();
    this.rateTimer = setInterval(() => {
      this.tickRatePerSec = this.tickCountInWindow;
      this.tickCountInWindow = 0;
    }, 1000);
    this.rateTimer.unref();
  }

  private stopRateTimer(): void {
    if (this.rateTimer !== undefined) {
      clearInterval(this.rateTimer);
      this.rateTimer = undefined;
    }
  }
}
