import type { JournalEvent } from '../domain/events.js';
import type { Order } from '../domain/orders.js';
import type { Bar, OptionChainRow } from '../domain/marketdata.js';
import type { Position, Trade } from '../domain/positions.js';
import type { PreflightCheck } from '../domain/session.js';
import type { SessionRiskSnapshot } from '../risk/session-risk.js';
import type { StrategyLifecycle, StrategyParams } from '../strategy/types.js';

/**
 * Gateway wire protocol (JSON text frames).
 *
 * Server → client: one full `snapshot` on connect (and on request), then
 * sequenced `delta` batches. seq increases by exactly 1 per server message
 * (snapshot or delta); a client that observes a gap must send `resnapshot`.
 * The UI is stateless by design: snapshot + deltas reconstruct everything.
 */

/** Internal tick→order latency for the Health HUD (01-DESIGN §7). */
export interface GatewayLatency {
  /** recv→sent total, milliseconds. */
  totalP50Ms: number;
  totalP99Ms: number;
  maxMs: number;
  /** Samples observed this session. */
  count: number;
  /** Per-hop p99 (ms) so the HUD can name the slow hop. */
  hopP99Ms: { features: number; signal: number; risk: number; sent: number };
}

export interface GatewayHealth {
  feedStatus: 'CONNECTED' | 'DISCONNECTED' | 'STALE';
  lastTickTs: number;
  gatewayTs: number;
  /** Absent until the first timed decision. */
  latency?: GatewayLatency;
}

export interface GatewayAlgoState {
  strategyId: string;
  lifecycle: StrategyLifecycle;
  params: StrategyParams;
  lastNoTradeReason?: string;
}

export interface GatewayRiskState {
  snapshot: SessionRiskSnapshot;
  limits: {
    dailyMaxLossPaise: number;
    perTradeRiskPaise: number;
    maxTradesPerDay: number;
    maxConcurrentPositions: number;
  };
}

export interface GatewaySessionState {
  sessionId: string;
  mode: 'paper' | 'live';
  phase: string;
  date: string;
  /** Preflight checklist (technical checks + operator ACK), newest run. */
  preflight?: PreflightCheck[];
}

export interface GatewayKillState {
  state: 'READY' | 'TRIPPING' | 'LOCKED';
  reason?: string;
}

export interface GatewayState {
  session: GatewaySessionState;
  /** Kill-switch state mirror, derived from kill.* journal events. */
  kill: GatewayKillState;
  health: GatewayHealth;
  algo: GatewayAlgoState;
  risk: GatewayRiskState;
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  chain: OptionChainRow[];
  /** Underlying 1m bars for the chart (capped ring, newest last). */
  bars: Bar[];
  /** Ring buffer of the most recent journal events (UI event stream). */
  events: JournalEvent[];
}

export interface StateChange {
  /** Top-level key of GatewayState that changed. */
  path: keyof GatewayState;
  value: unknown;
}

export type ServerMsg =
  | { kind: 'snapshot'; v: 1; seq: number; state: GatewayState }
  | { kind: 'delta'; v: 1; seq: number; changes: StateChange[] }
  | { kind: 'hb'; ts: number; seq: number }
  | { kind: 'ack'; commandId: string; accepted: boolean; reason?: string };

export type CommandType = 'ARM' | 'DISARM' | 'KILL' | 'REARM' | 'SET_PARAMS' | 'ACK_PREFLIGHT';

export type ClientMsg =
  | { kind: 'command'; commandId: string; type: CommandType; payload?: Record<string, unknown> }
  | { kind: 'resnapshot' }
  | { kind: 'hb'; ts: number };

/**
 * Map a LatencySampler snapshot onto the wire shape. Structurally typed so the
 * protocol layer (shared with the UI) never imports the telemetry module.
 */
export function toGatewayLatency(snap: {
  total: { p50Ms: number; p99Ms: number; maxMs: number; count: number };
  hops: {
    features: { p99Ms: number };
    signal: { p99Ms: number };
    risk: { p99Ms: number };
    sent: { p99Ms: number };
  };
}): GatewayLatency {
  return {
    totalP50Ms: snap.total.p50Ms,
    totalP99Ms: snap.total.p99Ms,
    maxMs: snap.total.maxMs,
    count: snap.total.count,
    hopP99Ms: {
      features: snap.hops.features.p99Ms,
      signal: snap.hops.signal.p99Ms,
      risk: snap.hops.risk.p99Ms,
      sent: snap.hops.sent.p99Ms,
    },
  };
}

/** Apply a delta's changes to a state object (used by the UI client too). */
export function applyChanges(state: GatewayState, changes: StateChange[]): GatewayState {
  const next = { ...state };
  for (const c of changes) {
    (next as Record<string, unknown>)[c.path] = c.value;
  }
  return next;
}
