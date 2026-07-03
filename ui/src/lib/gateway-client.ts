import {
  applyChanges,
  type ClientMsg,
  type CommandType,
  type GatewayState,
  type ServerMsg,
} from '@proto';

export type ConnStatus = 'CONNECTING' | 'LIVE' | 'STALE' | 'CLOSED';

export interface AckResult {
  accepted: boolean;
  reason?: string;
}

/** Minimal WebSocket surface so tests can inject a fake. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: (ev: { data?: unknown }) => void): void;
}

export interface GatewayClientOptions {
  url: string;
  makeWs?: (url: string) => WsLike;
  staleAfterMs?: number;
  reconnectDelayMs?: number;
  cmdTimeoutMs?: number;
  now?: () => number;
}

export interface GatewayClientStats {
  snapshots: number;
  deltas: number;
  gaps: number;
  resnapshots: number;
}

/**
 * Client side of the gateway protocol. Mirrors the server's per-client seq
 * contract (pinned by core/test/gateway.test.ts):
 *  - snapshot replaces the whole state and resets the baseline seq;
 *  - a delta must arrive at lastSeq+1, anything else is a gap → resnapshot;
 *  - a heartbeat carrying seq ≠ lastSeq means we missed a delta → resnapshot;
 *  - commands carry cmd-<n> ids; every command resolves via ack (or TIMEOUT).
 */
export class GatewayClient {
  state: GatewayState | undefined;
  status: ConnStatus = 'CONNECTING';
  lastSeq = 0;
  readonly stats: GatewayClientStats = { snapshots: 0, deltas: 0, gaps: 0, resnapshots: 0 };
  onChange: (() => void) | undefined;

  private ws: WsLike | undefined;
  private closed = false;
  private lastMsgTs = 0;
  private cmdN = 0;
  private readonly pending = new Map<string, (r: AckResult) => void>();
  private readonly makeWs: (url: string) => WsLike;
  private readonly staleAfterMs: number;
  private readonly reconnectDelayMs: number;
  private readonly cmdTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly optsIn: GatewayClientOptions) {
    this.makeWs = optsIn.makeWs ?? ((url) => new WebSocket(url) as unknown as WsLike);
    this.staleAfterMs = optsIn.staleAfterMs ?? 6_000;
    this.reconnectDelayMs = optsIn.reconnectDelayMs ?? 1_500;
    this.cmdTimeoutMs = optsIn.cmdTimeoutMs ?? 5_000;
    this.now = optsIn.now ?? (() => Date.now());
  }

  connect(): void {
    if (this.closed) return;
    this.status = 'CONNECTING';
    this.notify();
    const ws = this.makeWs(this.optsIn.url);
    this.ws = ws;
    ws.addEventListener('message', (ev) => this.handleRaw(String(ev.data)));
    ws.addEventListener('close', () => {
      this.status = 'CLOSED';
      this.notify();
      if (!this.closed) setTimeout(() => this.connect(), this.reconnectDelayMs);
    });
    ws.addEventListener('error', () => {
      /* close event follows and drives reconnect */
    });
  }

  handleRaw(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    this.handleMessage(msg);
  }

  handleMessage(msg: ServerMsg): void {
    this.lastMsgTs = this.now();
    switch (msg.kind) {
      case 'snapshot':
        this.state = msg.state;
        this.lastSeq = msg.seq;
        this.stats.snapshots++;
        this.status = 'LIVE';
        break;
      case 'delta':
        if (this.state === undefined || msg.seq !== this.lastSeq + 1) {
          this.gap();
          return;
        }
        this.state = applyChanges(this.state, msg.changes);
        this.lastSeq = msg.seq;
        this.stats.deltas++;
        this.status = 'LIVE';
        break;
      case 'hb':
        if (msg.seq !== this.lastSeq) {
          this.gap();
          return;
        }
        break;
      case 'ack': {
        const resolve = this.pending.get(msg.commandId);
        if (resolve !== undefined) {
          this.pending.delete(msg.commandId);
          resolve({ accepted: msg.accepted, ...(msg.reason !== undefined ? { reason: msg.reason } : {}) });
        }
        break;
      }
    }
    this.notify();
  }

  command(type: CommandType, payload?: Record<string, unknown>): Promise<AckResult> {
    const commandId = `cmd-${++this.cmdN}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(commandId)) resolve({ accepted: false, reason: 'TIMEOUT' });
      }, this.cmdTimeoutMs);
      this.pending.set(commandId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.sendMsg({ kind: 'command', commandId, type, ...(payload !== undefined ? { payload } : {}) });
    });
  }

  /** Test hook (Playwright seq-gap spec): make the next delta look gapped. */
  skipSeq(): void {
    this.lastSeq += 1;
  }

  /** Call on a 1s cadence: drives LIVE↔STALE off message recency. */
  tickStale(): void {
    if (this.status !== 'LIVE' && this.status !== 'STALE') return;
    const next: ConnStatus = this.now() - this.lastMsgTs > this.staleAfterMs ? 'STALE' : 'LIVE';
    if (next !== this.status) {
      this.status = next;
      this.notify();
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private gap(): void {
    this.stats.gaps++;
    this.requestResnapshot();
    this.notify();
  }

  private requestResnapshot(): void {
    this.stats.resnapshots++;
    this.sendMsg({ kind: 'resnapshot' });
  }

  private sendMsg(msg: ClientMsg): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* socket mid-close; reconnect will resync via snapshot */
    }
  }

  private notify(): void {
    this.onChange?.();
  }
}
