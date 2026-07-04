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

export interface GatewayHealth {
  feedStatus: 'CONNECTED' | 'DISCONNECTED' | 'STALE';
  lastTickTs: number;
  gatewayTs: number;
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

/** Apply a delta's changes to a state object (used by the UI client too). */
export function applyChanges(state: GatewayState, changes: StateChange[]): GatewayState {
  const next = { ...state };
  for (const c of changes) {
    (next as Record<string, unknown>)[c.path] = c.value;
  }
  return next;
}
