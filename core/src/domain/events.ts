import type { Bar, Tick } from './marketdata.js';
import type { Fill, Order, OrderIntent, OrderState } from './orders.js';
import type { Position, Trade } from './positions.js';
import type { RiskVerdict, SessionStopKind, StopState } from './risk.js';
import type { PositionId, SessionId } from './ids.js';
import type { SessionPhase, SessionState } from './session.js';

/**
 * Every event the platform can journal, as a single discriminated union.
 * The journal is append-only truth: replaying it must reproduce state, so
 * order/position events carry FULL snapshots (small volumes, maximal
 * robustness), never deltas.
 */
export interface JournalPayloads {
  'session.started': { session: SessionState };
  'session.phase': { sessionId: SessionId; phase: SessionPhase; reason?: string };
  'session.closed': { sessionId: SessionId; summary?: Record<string, unknown> };
  'config.loaded': { sessionId: SessionId; name: string; hash: string; path: string };
  'feed.status': {
    adapter: string;
    status: 'CONNECTED' | 'DISCONNECTED' | 'STALE';
    detail?: string;
  };
  'md.tick': { tick: Tick };
  'md.bar': { bar: Bar };
  'strategy.signal': {
    strategyId: string;
    instrumentId: string;
    direction: 'LONG_CE' | 'LONG_PE' | 'FLAT';
    features?: Record<string, number>;
    note?: string;
  };
  'strategy.noTrade': { strategyId: string; reason: string; detail?: string };
  'intent.proposed': { intent: OrderIntent };
  'risk.verdict': { verdict: RiskVerdict };
  'order.created': { order: Order };
  'order.updated': { order: Order; cause: 'TRANSITION' | 'FILL'; from?: OrderState; fill?: Fill };
  'position.opened': { position: Position };
  'position.updated': { position: Position };
  'position.closed': { positionId: PositionId; sessionId: SessionId };
  'trade.completed': { trade: Trade };
  'stop.moved': { positionId: PositionId; from: StopState; to: StopState; trigger: string };
  'stop.triggered': {
    positionId: PositionId;
    layer: string;
    reason: string;
    premiumPaise: number;
  };
  'risk.sessionStop': { kind: SessionStopKind; detail?: string };
  'kill.tripped': { source: 'MANUAL' | 'AUTO'; reason: string };
  'kill.completed': { durationMs: number; cancelledOrders: number; flattenedPositions: number };
  'recon.result': { ok: boolean; diffs?: Record<string, unknown> };
  'command.received': {
    commandId: string;
    kind: string;
    origin: 'UI' | 'CLI' | 'AUTO';
    payload?: Record<string, unknown>;
  };
  'command.acked': { commandId: string; accepted: boolean; reason?: string };
  'latency.sample': { hops: Record<string, number> };
  'diag.error': { where: string; message: string; stack?: string };
}

export type JournalEventType = keyof JournalPayloads;

export type JournalEvent = {
  [K in JournalEventType]: { seq: number; ts: number; type: K; payload: JournalPayloads[K] };
}[JournalEventType];

export type JournalEventOf<K extends JournalEventType> = Extract<JournalEvent, { type: K }>;

const ALL_EVENT_TYPES = [
  'session.started',
  'session.phase',
  'session.closed',
  'config.loaded',
  'feed.status',
  'md.tick',
  'md.bar',
  'strategy.signal',
  'strategy.noTrade',
  'intent.proposed',
  'risk.verdict',
  'order.created',
  'order.updated',
  'position.opened',
  'position.updated',
  'position.closed',
  'trade.completed',
  'stop.moved',
  'stop.triggered',
  'risk.sessionStop',
  'kill.tripped',
  'kill.completed',
  'recon.result',
  'command.received',
  'command.acked',
  'latency.sample',
  'diag.error',
] as const satisfies readonly JournalEventType[];

/** Compile-time completeness check: fails to typecheck if a type is missing above. */
export type _JournalTypesCovered = Exclude<
  JournalEventType,
  (typeof ALL_EVENT_TYPES)[number]
> extends never
  ? true
  : ['missing journal event types in ALL_EVENT_TYPES'];

export const JOURNAL_EVENT_TYPES: ReadonlySet<string> = new Set(ALL_EVENT_TYPES);
