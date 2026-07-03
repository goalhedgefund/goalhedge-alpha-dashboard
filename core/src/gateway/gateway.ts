import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { JournalEvent, JournalEventType, JournalPayloads } from '../domain/events.js';
import { systemClock, type Clock } from '../domain/time.js';
import {
  applyChanges,
  type ClientMsg,
  type CommandType,
  type GatewayState,
  type ServerMsg,
  type StateChange,
} from './protocol.js';

export type CommandResult = { accepted: boolean; reason?: string };
export type CommandHandler = (payload: Record<string, unknown>) => CommandResult | Promise<CommandResult>;
export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

export interface GatewayOptions {
  /** 0 = ephemeral (tests read the bound port from `port()`). */
  port: number;
  initialState: GatewayState;
  clock?: Clock;
  /** Delta batch interval. Tests can call flushNow() instead of waiting. */
  flushMs?: number;
  heartbeatMs?: number;
  /** Cap for the journal-event ring in state.events. */
  eventRingSize?: number;
  /** Commands are journaled through this sink. */
  journal?: JournalSink;
}

/**
 * WebSocket gateway: holds the versioned state tree and fans it out as one
 * snapshot + sequenced delta batches. The hot path never talks to sockets —
 * trading components call set()/ingestJournal() which only mutate memory;
 * serialization happens on the flush timer.
 *
 * Sequencing is PER CLIENT: each connection's stream is numbered 1,2,3…
 * (snapshot and deltas increment; heartbeats carry the current seq without
 * incrementing). A client that sees delta.seq ≠ last+1, or hb.seq ≠ last,
 * missed something and must send `resnapshot`.
 *
 * Command channel: every command is journaled (received + acked), routed to
 * a registered handler, and always answered with an ack — the UI never
 * assumes success.
 */
export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly clock: Clock;
  private readonly ringSize: number;
  private readonly journal: JournalSink | undefined;
  private readonly handlers = new Map<CommandType, CommandHandler>();
  private readonly clientSeq = new Map<WsSocket, number>();

  private state: GatewayState;
  private dirty = new Map<keyof GatewayState, unknown>();
  private flushTimer: NodeJS.Timeout | undefined;
  private hbTimer: NodeJS.Timeout | undefined;

  constructor(opts: GatewayOptions) {
    this.state = opts.initialState;
    this.clock = opts.clock ?? systemClock;
    this.ringSize = opts.eventRingSize ?? 200;
    this.journal = opts.journal;

    this.wss = new WebSocketServer({ port: opts.port });
    this.wss.on('connection', (socket) => {
      this.clientSeq.set(socket, 0);
      socket.on('close', () => this.clientSeq.delete(socket));
      socket.on('message', (raw) => {
        void this.onClientMessage(socket, raw.toString());
      });
      this.sendSnapshot(socket);
    });

    this.flushTimer = setInterval(() => this.flushNow(), opts.flushMs ?? 100);
    this.flushTimer.unref();
    this.hbTimer = setInterval(() => {
      for (const socket of this.clientSeq.keys()) {
        this.sendRaw(socket, { kind: 'hb', ts: this.clock.now(), seq: this.clientSeq.get(socket) ?? 0 });
      }
    }, opts.heartbeatMs ?? 2000);
    this.hbTimer.unref();
  }

  /** The bound TCP port (after listening). */
  port(): number {
    const addr = this.wss.address();
    return typeof addr === 'object' && addr !== null ? addr.port : 0;
  }

  ready(): Promise<void> {
    if (this.wss.address() !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.wss.once('listening', resolve);
      this.wss.once('error', reject);
    });
  }

  currentState(): GatewayState {
    return this.state;
  }

  clientCount(): number {
    return this.clientSeq.size;
  }

  /** Update one top-level slice of the state tree; queued into the next delta. */
  set<K extends keyof GatewayState>(path: K, value: GatewayState[K]): void {
    this.state = { ...this.state, [path]: value };
    this.dirty.set(path, value);
  }

  /**
   * Feed a journal event into the state tree: updates the events ring and
   * the derived slices (orders/positions/trades/algo). One wire, one truth.
   */
  ingestJournal(ev: JournalEvent): void {
    const ring = [...this.state.events, ev];
    if (ring.length > this.ringSize) ring.splice(0, ring.length - this.ringSize);
    this.set('events', ring);

    switch (ev.type) {
      case 'order.created':
      case 'order.updated': {
        const order = ev.payload.order;
        const orders = this.state.orders.filter((o) => o.clientOrderId !== order.clientOrderId);
        orders.push(order);
        this.set('orders', orders);
        break;
      }
      case 'position.opened':
      case 'position.updated': {
        const position = ev.payload.position;
        const positions = this.state.positions.filter((p) => p.positionId !== position.positionId);
        positions.push(position);
        this.set('positions', positions);
        break;
      }
      case 'position.closed': {
        this.set(
          'positions',
          this.state.positions.filter((p) => p.positionId !== ev.payload.positionId),
        );
        break;
      }
      case 'trade.completed':
        this.set('trades', [...this.state.trades, ev.payload.trade]);
        break;
      case 'strategy.noTrade':
        this.set('algo', { ...this.state.algo, lastNoTradeReason: ev.payload.reason });
        break;
      default:
        break;
    }
  }

  /** Register the handler for a command type (e.g. ARM → runner.arm()). */
  onCommand(type: CommandType, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  /** Drain queued changes into one sequenced delta, sent to every client. */
  flushNow(): void {
    if (this.dirty.size === 0) return;
    const changes: StateChange[] = Array.from(this.dirty.entries()).map(([path, value]) => ({
      path,
      value,
    }));
    this.dirty = new Map();
    for (const socket of this.clientSeq.keys()) {
      this.sendSequenced(socket, (seq) => ({ kind: 'delta', v: 1, seq, changes }));
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer !== undefined) clearInterval(this.flushTimer);
    if (this.hbTimer !== undefined) clearInterval(this.hbTimer);
    for (const c of this.clientSeq.keys()) c.close();
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private sendSnapshot(socket: WsSocket): void {
    this.sendSequenced(socket, (seq) => ({ kind: 'snapshot', v: 1, seq, state: this.state }));
  }

  private sendSequenced(socket: WsSocket, build: (seq: number) => ServerMsg): void {
    const next = (this.clientSeq.get(socket) ?? 0) + 1;
    this.clientSeq.set(socket, next);
    this.sendRaw(socket, build(next));
  }

  private sendRaw(socket: WsSocket, msg: ServerMsg): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  private async onClientMessage(socket: WsSocket, raw: string): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }

    if (msg.kind === 'resnapshot') {
      this.sendSnapshot(socket);
      return;
    }
    if (msg.kind === 'hb') return;
    if (msg.kind !== 'command') return;

    this.journal?.('command.received', {
      commandId: msg.commandId,
      kind: msg.type,
      origin: 'UI',
      ...(msg.payload !== undefined ? { payload: msg.payload } : {}),
    });

    let result: CommandResult;
    const handler = this.handlers.get(msg.type);
    if (handler === undefined) {
      result = { accepted: false, reason: 'UNKNOWN_COMMAND' };
    } else {
      try {
        result = await handler(msg.payload ?? {});
      } catch (err) {
        result = { accepted: false, reason: `HANDLER_ERROR: ${String(err)}` };
      }
    }

    this.journal?.('command.acked', {
      commandId: msg.commandId,
      accepted: result.accepted,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    });
    this.sendRaw(socket, {
      kind: 'ack',
      commandId: msg.commandId,
      accepted: result.accepted,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    });
  }
}

export { applyChanges };
