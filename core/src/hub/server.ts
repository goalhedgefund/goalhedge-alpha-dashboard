import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSessionId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { DhanFeed, type DhanFeedOptions } from '../feed/dhan/feed.js';
import type { IFeedAdapter, SubscribeRequest } from '../feed/interface.js';
import { Recorder } from '../feed/recorder.js';
import { loadScripMaster } from '../marketdata/instrument-master.js';
import { loadDhanLiveDataPaperEnv, type DhanLiveDataPaperEnv } from '../host/dhan-live-data-paper-env.js';
import { HubUniverse, type HubInstrumentInput } from './universe.js';

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
  queue: string[];
  droppedCount: number;
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
  staleThresholdMs?: number;
  healthIntervalMs?: number;
}

export type HubHealthStatus = 'CONNECTED' | 'DISCONNECTED' | 'STALE';

export interface HubHealthMessage {
  t: 'health';
  status: HubHealthStatus;
  lastTickTs: number;
  tickRatePerSec: number;
  subscribed: number;
  dropped?: number;
  sessionId: string;
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
  private readonly maxClientQueue: number;
  private readonly staleThresholdMs: number;
  private readonly healthIntervalMs: number;

  private running = false;
  private lastTickTs = 0;
  private tickRateWindow: number[] = [];
  private healthTimer: NodeJS.Timeout | undefined;
  private lastHealthStatus: HubHealthStatus = 'DISCONNECTED';

  // Backoff and rate limit tracking for Dhan socket 4 (matching b4e56ca)
  private reconnectAttempts = 0;
  private rateLimitedUntilTs = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private static readonly BASE_RECONNECT_MS = 5_000;
  private static readonly MAX_RECONNECT_MS = 120_000;
  private static readonly RATE_LIMIT_COOLDOWN_MS = 120_000;

  constructor(opts: HubServerOptions = {}) {
    this.port = opts.port ?? 8795;
    // BIND LOOPBACK EXPLICITLY - NEVER 0.0.0.0 (§4)
    this.host = opts.host ?? '127.0.0.1';
    this.sessionId = opts.sessionId ?? `HUB-${istDate()}-${Math.floor(Date.now() / 1000)}`;
    this.universe = opts.universe ?? new HubUniverse();
    this.maxClientQueue = opts.maxClientQueue ?? 5_000;
    this.staleThresholdMs = opts.staleThresholdMs ?? 5_000;
    this.healthIntervalMs = opts.healthIntervalMs ?? 5_000;

    this.dhanFeed = opts.feed;
    this.feedOptions = opts.feedOptions;
    this.recorder = opts.recorder;

    this.wss = new WebSocketServer({
      host: this.host,
      port: this.port,
    });

    this.setupWebSocketServer();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (socket: WsSocket) => {
      const client: ClientConnection = {
        socket,
        clientId: 'anonymous',
        queue: [],
        droppedCount: 0,
      };
      this.clients.add(client);

      socket.on('message', (raw) => {
        this.handleClientMessage(client, raw.toString());
      });

      socket.on('close', () => {
        this.clients.delete(client);
      });

      socket.on('error', () => {
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
        const t = msg.t;
        if (t === 'hello') {
          if (typeof msg.client === 'string') {
            client.clientId = msg.client;
          }
          this.sendToClient(client, {
            t: 'welcome',
            proto: 1,
            sessionId: this.sessionId,
            universeVersion: this.universe.currentVersion(),
          });
          this.sendHealth(client);
        } else if (t === 'sub') {
          const instruments = (Array.isArray(msg.instruments) ? msg.instruments : []) as HubInstrumentInput[];
          const { added, universeVersion } = this.universe.add(instruments);
          if (added.length > 0 && this.dhanFeed) {
            this.dhanFeed.subscribe(added);
          }
          this.sendToClient(client, {
            t: 'subAck',
            added: added.length,
            universeVersion,
          });
        } else if (t === 'ping') {
          this.sendToClient(client, { t: 'pong' });
        }
        // Unknown 't' values are ignored, not fatal — forward compatibility (§4)
      } catch {
        // Ignore unparseable frames
      }
    }
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
    const payload = JSON.stringify({ t: 'tick', d: tick }) + '\n';
    for (const client of this.clients) {
      if (client.socket.readyState !== WsSocket.OPEN) continue;

      if (client.socket.bufferedAmount > 2 * 1024 * 1024) {
        // If client socket write buffer exceeds 2MB, drop tick to protect hub memory
        client.droppedCount++;
        continue;
      }

      if (client.queue.length >= this.maxClientQueue) {
        client.queue.shift(); // Drop oldest
        client.droppedCount++;
      }
      client.queue.push(payload);
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
        client.socket.send(frame);
      }
    }
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

    if (this.dhanFeed) {
      this.attachFeedHandlers(this.dhanFeed);
      await this.connectFeedWithBackoff();
    } else if (this.feedOptions) {
      await this.connectFeedWithBackoff();
    }

    this.healthTimer = setInterval(() => {
      this.checkAndBroadcastHealth();
    }, this.healthIntervalMs);
    this.healthTimer.unref();
  }

  private attachFeedHandlers(feed: IFeedAdapter): void {
    feed.setTickHandler((tick: Tick) => {
      this.onIncomingTick(tick);
    });
  }

  private onIncomingTick(tick: Tick): void {
    this.lastTickTs = tick.ts || Date.now();
    const now = Date.now();
    this.tickRateWindow.push(now);

    // Write to recorder
    try {
      this.recorder?.record(tick);
    } catch (err) {
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
      tickRatePerSec: this.calculateTickRate(),
      subscribed: this.universe.size(),
      dropped: client.droppedCount,
      sessionId: this.sessionId,
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
        tickRatePerSec: rate,
        subscribed: this.universe.size(),
        dropped: client.droppedCount,
        sessionId: this.sessionId,
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
      this.attachFeedHandlers(this.dhanFeed);
    }

    if (!this.dhanFeed) return;

    try {
      await this.dhanFeed.connect();
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

  const hub = new HubServer({
    port: 8795,
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
