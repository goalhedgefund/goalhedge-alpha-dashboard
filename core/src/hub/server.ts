import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSessionId } from '../domain/ids.js';
import type { InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { DhanFeed, type DhanFeedOptions } from '../feed/dhan/feed.js';
import type { IFeedAdapter, SubscribeRequest } from '../feed/interface.js';
import { Recorder } from '../feed/recorder.js';
import { loadScripMaster } from '../marketdata/instrument-master.js';
import { loadDhanLiveDataPaperEnv, type DhanLiveDataPaperEnv } from '../host/dhan-live-data-paper-env.js';
import { HubUniverse, type HubInstrumentInput } from './universe.js';
import {
  HUB_PROTOCOL_V2,
  MAX_HUB_FRAME_BYTES,
  makeHubError,
  makeHubTickV2,
  makeHubWelcomeV2,
  parseHubClientFrameV2,
  type HubSubscribeV2,
  type HubUnsubscribeV2,
} from './protocol-v2.js';

const IST_OFFSET_MS = 330 * 60_000;

export function istDate(nowMs = Date.now()): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

function resolveRepoPath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

export interface ClientConnection {
  socket: WsSocket;
  clientId: string;
  instanceId?: string;
  connectionId: string;
  protocol?: 1 | 2;
  handshaken: boolean;
  responseByRequestId: Map<string, Record<string, unknown>>;
  queue: string[];
  queueBytes: number;
  droppedCount: number;
  /** Receive time of the last tick actually routed to this client. */
  lastRelevantTickAt: number;
  /** Monotonic only across ticks routed to this specific v2 client. */
  sequence: number;
  sequenceIdentity?: string;
}

export interface HubServerOptions {
  port?: number;
  host?: string;
  universe?: HubUniverse;
  feed?: IFeedAdapter;
  feedOptions?: DhanFeedOptions;
  recorder?: Recorder;
  recordingsDir?: string;
  sessionId?: string;
  maxClientQueue?: number;
  maxClientQueueBytes?: number;
  staleThresholdMs?: number;
  healthIntervalMs?: number;
  maxInstrumentsPerClient?: number;
  /** Bounded idempotency cache; old request IDs may be safely retried as new. */
  maxResponseCacheEntries?: number;
}

export type HubHealthStatus = 'CONNECTED' | 'DISCONNECTED' | 'STALE';

export interface HubHealthMessage {
  t: 'health';
  status: HubHealthStatus;
  lastTickTs: number;
  /** Per-client receive timestamp; never advanced by another consumer's tick. */
  lastRelevantTickAt: number;
  tickRatePerSec: number;
  subscribed: number;
  dropped?: number;
  sessionId: string;
  recorderStatus?: 'HEALTHY' | 'FAILED';
  recorderLastWriteTs?: number;
  providerEpoch?: number;
  unknownFrames?: number;
}

export class HubServer {
  readonly port: number;
  readonly host: string;
  readonly sessionId: string;
  private readonly wss: WebSocketServer;
  private readonly universe: HubUniverse;
  private dhanFeed: IFeedAdapter | undefined;
  private readonly feedOptions: DhanFeedOptions | undefined;
  private recorder: Recorder | undefined;
  private readonly clients = new Set<ClientConnection>();
  /** Session-scoped cursors preserve v2 sequence continuity across reconnects. */
  private readonly sequenceByClientIdentity = new Map<string, number>();
  private static readonly MAX_SEQUENCE_IDENTITIES = 1_024;
  private readonly maxClientQueue: number;
  private readonly maxClientQueueBytes: number;
  private readonly staleThresholdMs: number;
  private readonly healthIntervalMs: number;
  private readonly maxInstrumentsPerClient: number;
  private readonly maxResponseCacheEntries: number;

  private running = false;
  private lastTickTs = 0;
  private tickRateWindow: number[] = [];
  private healthTimer: NodeJS.Timeout | undefined;
  private lastHealthStatus: HubHealthStatus = 'DISCONNECTED';
  /** Zero means no accepted provider connection; increment only after connect succeeds. */
  private providerEpoch = 0;
  private unknownFrameCount = 0;
  private recorderStatus: 'HEALTHY' | 'FAILED' = 'HEALTHY';
  private recorderLastWriteTs = 0;
  private recorderErrorCategory: string | undefined;

  // Backoff and rate limit tracking for Dhan socket 4 (matching b4e56ca)
  private reconnectAttempts = 0;
  private rateLimitedUntilTs = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private static readonly BASE_RECONNECT_MS = 5_000;
  private static readonly MAX_RECONNECT_MS = 120_000;
  private static readonly RATE_LIMIT_COOLDOWN_MS = 120_000;

  constructor(opts: HubServerOptions = {}) {
    this.port = opts.port ?? (process.env.HUB_PORT ? parseInt(process.env.HUB_PORT, 10) : 8700);
    // BIND LOOPBACK EXPLICITLY - NEVER 0.0.0.0 (§4)
    this.host = opts.host ?? '127.0.0.1';
    this.sessionId = opts.sessionId ?? `HUB-${istDate()}-${Math.floor(Date.now() / 1000)}`;
    this.universe = opts.universe ?? new HubUniverse();
    this.maxClientQueue = opts.maxClientQueue ?? 5_000;
    this.maxClientQueueBytes = opts.maxClientQueueBytes ?? 2 * 1024 * 1024;
    this.staleThresholdMs = opts.staleThresholdMs ?? 5_000;
    this.healthIntervalMs = opts.healthIntervalMs ?? 5_000;
    this.maxInstrumentsPerClient = opts.maxInstrumentsPerClient ?? 500;
    this.maxResponseCacheEntries = opts.maxResponseCacheEntries ?? 256;

    this.dhanFeed = opts.feed;
    this.feedOptions = opts.feedOptions;
    this.recorder = opts.recorder;

    this.wss = new WebSocketServer({
      host: this.host,
      port: this.port,
      // We additionally check every incoming frame before JSON.parse. Keeping
      // a small transport cap prevents an unauthenticated local client from
      // allocating arbitrarily large buffers.
      maxPayload: MAX_HUB_FRAME_BYTES,
    });

    this.setupWebSocketServer();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (socket: WsSocket) => {
      const client: ClientConnection = {
        socket,
        clientId: 'anonymous',
        connectionId: randomUUID(),
        handshaken: false,
        responseByRequestId: new Map(),
        queue: [],
        queueBytes: 0,
        droppedCount: 0,
        lastRelevantTickAt: 0,
        sequence: 0,
      };
      this.clients.add(client);

      socket.on('message', (raw) => {
        if (Buffer.byteLength(raw.toString()) > MAX_HUB_FRAME_BYTES) {
          this.sendProtocolError(client, { code: 'FRAME_TOO_LARGE', message: 'frame exceeds maximum size' });
          socket.close(1009, 'frame too large');
          return;
        }
        this.handleClientMessage(client, raw.toString());
      });

      socket.on('close', () => {
        this.universe.releaseConnection(client.connectionId);
        this.clients.delete(client);
      });

      socket.on('error', () => {
        this.universe.releaseConnection(client.connectionId);
        this.clients.delete(client);
      });
    });
  }

  private handleClientMessage(client: ClientConnection, text: string): void {
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        this.handleParsedClientMessage(client, msg);
      } catch {
        this.sendProtocolError(client, { code: 'MALFORMED_JSON', message: 'frame is not valid JSON' });
      }
    }
  }

  private handleParsedClientMessage(client: ClientConnection, msg: Record<string, unknown>): void {
    // Protocol v1 remains compatibility-only. It is validated enough to avoid
    // anonymous subscriptions, but never gains Phase 2 behaviour implicitly.
    if (!client.handshaken && msg.t === 'hello' && msg.proto === 1) {
      const legacyClientId = typeof msg.client === 'string' ? msg.client.trim() : '';
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(legacyClientId)) {
        this.sendToClient(client, { t: 'error', code: 'INVALID_FRAME', message: 'valid legacy client is required' });
        return;
      }
      client.clientId = legacyClientId;
      client.protocol = 1;
      client.handshaken = true;
      this.sendToClient(client, { t: 'welcome', proto: 1, sessionId: this.sessionId, universeVersion: this.universe.currentVersion() });
      this.sendHealth(client);
      return;
    }

    if (!client.handshaken && msg.t === 'hello' && msg.proto !== HUB_PROTOCOL_V2) {
      this.sendProtocolError(client, { code: 'UNSUPPORTED_PROTOCOL', message: 'only protocol versions 1 and 2 are supported' });
      return;
    }

    if (!client.handshaken) {
      const parsed = parseHubClientFrameV2(msg);
      if (!parsed.ok) {
        this.sendProtocolError(client, parsed.error);
        return;
      }
      if (parsed.frame.t !== 'hello') {
        this.sendProtocolError(client, { code: 'HANDSHAKE_REQUIRED', message: 'hello handshake is required before commands' });
        return;
      }
      client.clientId = parsed.frame.clientId;
      client.instanceId = parsed.frame.instanceId;
      client.sequenceIdentity = `${client.clientId}:${client.instanceId}`;
      client.sequence = this.sequenceByClientIdentity.get(client.sequenceIdentity) ?? 0;
      client.protocol = HUB_PROTOCOL_V2;
      client.handshaken = true;
      this.sendToClient(client, makeHubWelcomeV2({
        sessionId: this.sessionId,
        connectionId: client.connectionId,
        providerEpoch: this.providerEpoch,
        universeVersion: this.universe.currentVersion(),
      }));
      this.sendHealth(client);
      return;
    }

    if (client.protocol === 1) {
      this.handleLegacyCommand(client, msg);
      return;
    }

    const parsed = parseHubClientFrameV2(msg);
    if (!parsed.ok) {
      if (parsed.error.code === 'UNKNOWN_MESSAGE') this.unknownFrameCount++;
      this.sendProtocolError(client, parsed.error);
      return;
    }
    if (parsed.frame.t === 'hello') {
      this.sendProtocolError(client, { code: 'INVALID_FRAME', message: 'hello may only be sent once' });
    } else if (parsed.frame.t === 'sub') {
      this.handleV2Subscribe(client, parsed.frame);
    } else if (parsed.frame.t === 'unsub') {
      this.handleV2Unsubscribe(client, parsed.frame);
    } else if (parsed.frame.t === 'status') {
      this.sendToClient(client, { t: 'status', proto: HUB_PROTOCOL_V2, requestId: parsed.frame.requestId, ...this.diagnostics() });
    } else {
      this.sendToClient(client, { t: 'pong', proto: HUB_PROTOCOL_V2, ...(parsed.frame.requestId ? { requestId: parsed.frame.requestId } : {}) });
    }
  }

  private handleLegacyCommand(client: ClientConnection, msg: Record<string, unknown>): void {
    if (msg.t === 'sub') {
      const instruments = (Array.isArray(msg.instruments) ? msg.instruments : []) as HubInstrumentInput[];
      const { added, universeVersion } = this.universe.add(instruments);
      if (added.length > 0 && this.dhanFeed) this.dhanFeed.subscribe(added);
      this.sendToClient(client, { t: 'subAck', added: added.length, universeVersion });
    } else if (msg.t === 'ping') {
      this.sendToClient(client, { t: 'pong' });
    }
  }

  private handleV2Subscribe(client: ClientConnection, frame: HubSubscribeV2): void {
    const previous = client.responseByRequestId.get(frame.requestId);
    if (previous) {
      this.sendToClient(client, previous);
      return;
    }
    const instruments: HubInstrumentInput[] = frame.instruments.map((instrument) => ({
      exchangeSegment: instrument.exchangeSegment,
      brokerToken: instrument.brokerToken,
      ...(instrument.instrumentId ? { instrumentId: instrument.instrumentId as InstrumentId } : {}),
      ...(instrument.requestCode !== undefined ? { requestCode: instrument.requestCode } : {}),
    }));
    if (this.universe.connectionSubscriptionCount(client.connectionId) + instruments.length > this.maxInstrumentsPerClient) {
      this.sendProtocolError(client, { code: 'INVALID_FRAME', message: 'consumer subscription limit exceeded', requestId: frame.requestId });
      return;
    }
    const { added, owned, activeCount, universeVersion } = this.universe.subscribe(client.connectionId, instruments);
    if (added.length > 0 && this.dhanFeed) this.dhanFeed.subscribe(added);
    const ack = {
      t: 'subAck', proto: HUB_PROTOCOL_V2, requestId: frame.requestId,
      added: added.length, owned, activeCount, universeVersion, providerEpoch: this.providerEpoch,
    } as Record<string, unknown>;
    this.cacheResponse(client, frame.requestId, ack);
    this.sendToClient(client, ack);
  }

  private handleV2Unsubscribe(client: ClientConnection, frame: HubUnsubscribeV2): void {
    const previous = client.responseByRequestId.get(frame.requestId);
    if (previous) { this.sendToClient(client, previous); return; }
    const instruments: HubInstrumentInput[] = frame.instruments.map((instrument) => ({
      exchangeSegment: instrument.exchangeSegment,
      brokerToken: instrument.brokerToken,
    }));
    const { removed, activeCount } = this.universe.unsubscribe(client.connectionId, instruments);
    const ack = { t: 'unsubAck', proto: HUB_PROTOCOL_V2, requestId: frame.requestId, removed, activeCount } as Record<string, unknown>;
    this.cacheResponse(client, frame.requestId, ack);
    this.sendToClient(client, ack);
  }

  private sendProtocolError(client: ClientConnection, error: Parameters<typeof makeHubError>[0]): void {
    this.sendToClient(client, makeHubError(error));
  }

  private cacheResponse(client: ClientConnection, requestId: string, response: Record<string, unknown>): void {
    // Map insertion order gives deterministic least-recently-created eviction.
    // A per-connection cap prevents a local misbehaving client from retaining
    // an unbounded number of idempotency responses for the whole session.
    while (client.responseByRequestId.size >= this.maxResponseCacheEntries) {
      const oldest = client.responseByRequestId.keys().next().value;
      if (oldest === undefined) break;
      client.responseByRequestId.delete(oldest);
    }
    client.responseByRequestId.set(requestId, response);
  }

  private sendToClient(client: ClientConnection, data: unknown): void {
    if (client.socket.readyState !== WsSocket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(data) + '\n');
    } catch {
      // client error handled via socket error listener
    }
  }

  /**
   * Fans out tick to connected clients using bounded queue with drop-oldest backpressure.
   */
  private fanoutTick(tick: Tick): void {
    for (const client of this.clients) {
      if (client.socket.readyState !== WsSocket.OPEN) continue;
      if (client.protocol === HUB_PROTOCOL_V2 && !this.universe.connectionOwnsInstrument(client.connectionId, tick.instrumentId, tick.exchangeSegment)) continue;

      client.lastRelevantTickAt = Date.now();
      // V2 clients see filtered streams.  Their sequence must advance only
      // for a tick that is relevant to them; a hub-global sequence would turn
      // ordinary filtering into a false gap and permanently mark them stale.
      const sequence = client.protocol === HUB_PROTOCOL_V2 ? ++client.sequence : undefined;
      if (client.sequenceIdentity !== undefined && sequence !== undefined) {
        this.rememberClientSequence(client.sequenceIdentity, sequence);
      }

      const payload = JSON.stringify(client.protocol === HUB_PROTOCOL_V2
        ? makeHubTickV2({ sessionId: this.sessionId, providerEpoch: this.providerEpoch, sequence: sequence!, tick })
        : { t: 'tick', d: tick }) + '\n';

      if (client.socket.bufferedAmount > 2 * 1024 * 1024) {
        // If client socket write buffer exceeds 2MB, drop tick to protect hub memory
        client.droppedCount++;
        continue;
      }

      const payloadBytes = Buffer.byteLength(payload);
      while (client.queue.length >= this.maxClientQueue || client.queueBytes + payloadBytes > this.maxClientQueueBytes) {
        const dropped = client.queue.shift(); // Drop oldest
        if (dropped === undefined) break;
        client.queueBytes -= Buffer.byteLength(dropped);
        client.droppedCount++;
      }
      if (client.droppedCount >= this.maxClientQueue) {
        client.socket.close(1013, 'slow consumer');
        continue;
      }
      client.queue.push(payload);
      client.queueBytes += payloadBytes;
      this.drainClientQueue(client);
    }
  }

  private drainClientQueue(client: ClientConnection): void {
    while (client.queue.length > 0 && client.socket.readyState === WsSocket.OPEN) {
      if (client.socket.bufferedAmount > 1024 * 1024) {
        break; // Pause draining until buffer drops
      }
      const frame = client.queue.shift();
      if (frame !== undefined) {
        client.queueBytes -= Buffer.byteLength(frame);
        try {
          client.socket.send(frame);
        } catch {
          break;
        }
      }
    }
  }

  private rememberClientSequence(identity: string, sequence: number): void {
    // Preserve a bounded session cursor for reconnecting clients.  Eviction
    // is safe: a client whose old cursor is evicted will detect a gap and
    // request its normal resync rather than silently accepting data loss.
    if (!this.sequenceByClientIdentity.has(identity)
      && this.sequenceByClientIdentity.size >= HubServer.MAX_SEQUENCE_IDENTITIES) {
      const oldest = this.sequenceByClientIdentity.keys().next().value;
      if (oldest !== undefined) this.sequenceByClientIdentity.delete(oldest);
    }
    this.sequenceByClientIdentity.set(identity, sequence);
  }

  ready(): Promise<void> {
    if (this.wss.address() !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });
  }

  async start(): Promise<void> {
    this.running = true;
    await this.ready();

    if (this.dhanFeed || this.feedOptions) {
      await this.connectFeedWithBackoff();
    }

    this.healthTimer = setInterval(() => {
      this.checkAndBroadcastHealth();
    }, this.healthIntervalMs);
    this.healthTimer.unref();
  }

  private attachFeedHandlers(feed: IFeedAdapter, epoch: number): void {
    feed.setTickHandler((tick: Tick) => {
      // A callback from a replaced provider must never cross its epoch fence.
      if (this.running && epoch === this.providerEpoch) this.onIncomingTick(tick);
    });
  }

  private onIncomingTick(tick: Tick): void {
    const now = Date.now();
    // Report transport freshness from local receipt time. `tick.ts` is Dhan's
    // last-traded/exchange time and may be old for illiquid option contracts.
    this.lastTickTs = Math.min(tick.recvTs || now, now);
    this.tickRateWindow.push(now);

    // Write to recorder
    try {
      this.recorder?.record(tick);
      this.recorderLastWriteTs = Date.now();
    } catch (err) {
      this.recorderStatus = 'FAILED';
      this.recorderErrorCategory = err instanceof Error ? err.name : 'RecorderError';
      console.error('[HubServer] Recorder write failed; ignoring error to keep tick path live:', err);
    }

    // Fan out to clients
    this.fanoutTick(tick);
  }

  private calculateTickRate(): number {
    const cutoff = Date.now() - 1000;
    while (this.tickRateWindow.length > 0 && (this.tickRateWindow[0] ?? 0) < cutoff) {
      this.tickRateWindow.shift();
    }
    return this.tickRateWindow.length;
  }

  currentHealthStatus(): HubHealthStatus {
    const feedHealth = this.dhanFeed?.health();
    if (!feedHealth || feedHealth.status === 'DISCONNECTED') {
      return 'DISCONNECTED';
    }

    const staleness = Date.now() - this.lastTickTs;
    if (this.lastTickTs > 0 && staleness > this.staleThresholdMs) {
      return 'STALE';
    }

    return feedHealth.status;
  }

  private sendHealth(client: ClientConnection): void {
    const status = this.currentHealthStatus();
    const msg: HubHealthMessage = {
      t: 'health',
      status,
      lastTickTs: this.lastTickTs,
      lastRelevantTickAt: client.lastRelevantTickAt,
      tickRatePerSec: this.calculateTickRate(),
      subscribed: this.universe.size(),
      dropped: client.droppedCount,
      sessionId: this.sessionId,
      ...(client.protocol === HUB_PROTOCOL_V2 ? { proto: HUB_PROTOCOL_V2, providerEpoch: this.providerEpoch, unknownFrames: this.unknownFrameCount } : {}),
      recorderStatus: this.recorderStatus,
      recorderLastWriteTs: this.recorderLastWriteTs,
    };
    this.sendToClient(client, msg);
  }

  private checkAndBroadcastHealth(): void {
    const status = this.currentHealthStatus();
    const statusChanged = status !== this.lastHealthStatus;
    this.lastHealthStatus = status;

    const rate = this.calculateTickRate();
    for (const client of this.clients) {
      const msg: HubHealthMessage = {
        t: 'health',
        status,
        lastTickTs: this.lastTickTs,
        lastRelevantTickAt: client.lastRelevantTickAt,
        tickRatePerSec: rate,
        subscribed: this.universe.size(),
        dropped: client.droppedCount,
        sessionId: this.sessionId,
        ...(client.protocol === HUB_PROTOCOL_V2 ? { proto: HUB_PROTOCOL_V2, providerEpoch: this.providerEpoch, unknownFrames: this.unknownFrameCount } : {}),
        recorderStatus: this.recorderStatus,
        recorderLastWriteTs: this.recorderLastWriteTs,
      };
      this.sendToClient(client, msg);
    }

    if (statusChanged) {
      console.log(`[HubServer] Health status transition: ${status}`);
    }
  }

  private async connectFeedWithBackoff(): Promise<void> {
    if (!this.running) return;

    if (!this.dhanFeed && this.feedOptions) {
      this.dhanFeed = new DhanFeed(this.feedOptions);
    }

    if (!this.dhanFeed) return;

    try {
      const candidateEpoch = this.providerEpoch + 1;
      this.attachFeedHandlers(this.dhanFeed, candidateEpoch);
      await this.dhanFeed.connect();
      this.providerEpoch = candidateEpoch;
      this.reconnectAttempts = 0;
      this.rateLimitedUntilTs = 0;
      console.log('[HubServer] Connected to Dhan feed (socket 4). Subscribing option universe...');
      this.dhanFeed.subscribe(this.universe.allSubscriptions());
      this.checkAndBroadcastHealth();
    } catch (err: any) {
      const errMsg = String(err?.message ?? err);
      console.warn(`[HubServer] Dhan connection attempt failed: ${errMsg}`);
      if (/\b429\b/.test(errMsg)) {
        this.rateLimitedUntilTs = Date.now() + HubServer.RATE_LIMIT_COOLDOWN_MS;
        console.warn(
          `[HubServer] Dhan returned 429; holding off ${HubServer.RATE_LIMIT_COOLDOWN_MS / 1000}s before retrying.`
        );
      }
      this.scheduleFeedReconnect();
    }
  }

  private scheduleFeedReconnect(): void {
    if (!this.running || this.reconnectTimer !== undefined) return;

    const backoffMs = Math.min(
      HubServer.BASE_RECONNECT_MS * 2 ** this.reconnectAttempts,
      HubServer.MAX_RECONNECT_MS
    );
    const rateLimitWaitMs = Math.max(0, this.rateLimitedUntilTs - Date.now());
    const jitterMs = Math.floor(Math.random() * 1_000);
    const delayMs = Math.max(backoffMs, rateLimitWaitMs) + jitterMs;
    this.reconnectAttempts += 1;

    console.log(`[HubServer] Scheduling Dhan feed reconnect in ${(delayMs / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}).`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectFeedWithBackoff();
    }, delayMs);
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    for (const client of this.clients) {
      try {
        client.socket.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    if (this.dhanFeed) {
      try {
        await this.dhanFeed.close();
      } catch {
        // ignore
      }
    }

    if (this.recorder) {
      try {
        await this.recorder.close();
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  clientCount(): number {
    return this.clients.size;
  }

  getUniverse(): HubUniverse {
    return this.universe;
  }

  /** Copy-only diagnostics for the supervisor/dashboard; never expose sockets or mutable sets. */
  diagnostics(): Record<string, unknown> {
    const feedHealth = this.dhanFeed?.health();
    return {
      sessionId: this.sessionId,
      providerEpoch: this.providerEpoch,
      status: this.currentHealthStatus(),
      lastTickTs: this.lastTickTs,
      tickRatePerSec: this.calculateTickRate(),
      providerDetail: feedHealth?.detail,
      recorder: { status: this.recorderStatus, lastWriteTs: this.recorderLastWriteTs, errorCategory: this.recorderErrorCategory },
      clients: Array.from(this.clients, (client) => ({
        clientId: client.clientId, connectionId: client.connectionId, protocol: client.protocol ?? 0,
        subscriptions: this.universe.connectionSubscriptionCount(client.connectionId),
        queuedMessages: client.queue.length, queuedBytes: client.queueBytes, dropped: client.droppedCount,
        lastRelevantTickAt: client.lastRelevantTickAt, sequence: client.sequence,
      })),
    };
  }
}

/**
 * Standalone runner entry point when executed directly via node.
 */
async function main(): Promise<void> {
  const env: DhanLiveDataPaperEnv = loadDhanLiveDataPaperEnv();
  const root = repoRoot();
  const date = istDate();

  console.log(`[HubServer] Initializing Workstation Tick Hub for ${date}...`);

  const scripMasterPath = resolveRepoPath(root, env.scripMasterPath);
  const scripRows = loadScripMaster(scripMasterPath);
  const universe = HubUniverse.seedFromScripMaster({
    scripRows,
    date,
    underlyingSymbol: env.underlyingSymbol,
    spotSecurityId: env.spotSecurityId,
    spotExchangeSegment: env.spotExchangeSegment,
    optionExchangeSegment: env.optionExchangeSegment,
    requestCode: env.feedRequestCode,
  });

  console.log(`[HubServer] Universe seeded with ${universe.size()} instruments from full weekly chain.`);

  // Recordings directory under services/scalper/data/hub-recordings/ (Vite-ignored)
  const recordingsDir = join(root, 'data', 'hub-recordings', date);
  const recorder = new Recorder({ dir: recordingsDir, compression: 'gzip' });
  console.log(`[HubServer] Recorder output directory: ${recordingsDir}`);

  const hubPort = process.env.HUB_PORT ? parseInt(process.env.HUB_PORT, 10) : 8700;
  const hub = new HubServer({
    port: hubPort,
    host: '127.0.0.1',
    universe,
    recorder,
    feedOptions: {
      wsUrl: env.wsUrl,
      clientId: env.clientId,
      accessToken: () => loadDhanLiveDataPaperEnv().accessToken,
      requestCode: env.feedRequestCode,
    },
  });

  await hub.start();
  console.log(`[HubServer] Tick Hub running and serving ws://127.0.0.1:${hub.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[HubServer] Received ${signal}; shutting down cleanly...`);
    await hub.close();
    console.log('[HubServer] Shutdown complete.');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((err: unknown) => {
    console.error('[HubServer] Fatal server error:', err);
    process.exit(1);
  });
}
