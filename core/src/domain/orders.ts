import type { ClientOrderId, InstrumentId, IntentId, SessionId } from './ids.js';

export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET' | 'SL_LIMIT' | 'SL_MARKET';
export type IntentType = 'MARKET_PROTECT' | 'LIMIT';
export type IntentPurpose = 'ENTRY' | 'EXIT' | 'STOP' | 'SQUARE_OFF' | 'KILL';

/**
 * Complete risk definition attached to an entry intent BEFORE entry.
 * The Risk Gate rejects entry intents whose stop plan is missing or whose
 * implied rupee risk exceeds the per-trade budget.
 */
export interface StopPlan {
  /** L1: exit long option if premium <= this level. */
  hardStopPremiumPaise: number;
  /** L1: optional underlying invalidation level. */
  hardStopUnderlyingPaise?: number;
  hardStopUnderlyingDir?: 'BELOW' | 'ABOVE';
  /** L2: move stop to entry once premium >= this. */
  breakevenAtPaise?: number;
  /** L2: ratchet step size. */
  trailStepPaise?: number;
  /** L2: % of open profit locked per step. */
  trailLockPct?: number;
  /** L3: exit if neither stopped nor targeted within this many seconds. */
  timeStopSec: number;
  targetPaise?: number;
}

export interface OrderIntent {
  intentId: IntentId;
  sessionId: SessionId;
  strategyId: string;
  ts: number;
  side: Side;
  instrumentId: InstrumentId;
  /** Units (always a multiple of lot size). */
  qty: number;
  type: IntentType;
  limitPricePaise?: number;
  /** MARKET_PROTECT: protection band in ticks around LTP. */
  protectTicks?: number;
  ttlMs: number;
  /** Attribution tag, e.g. 's1:entry'. */
  tag: string;
  purpose: IntentPurpose;
  /** Mandatory for ENTRY intents (Risk Gate enforces). */
  stopPlan?: StopPlan;
  /**
   * Internal OMS allocation hint for covered exits. The broker still receives
   * one ordinary sell order; PositionKeeper uses these fill-lot ids only to
   * attribute the close to the intended inventory slices.
   */
  closeLotIds?: string[];
  confidence?: number;
}

export const ORDER_STATES = [
  'DRAFT',
  'RISK_APPROVED',
  'SENT',
  'ACKED',
  'PARTIAL',
  'FILLED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export function isTerminalOrderState(s: OrderState): boolean {
  return s === 'FILLED' || s === 'REJECTED' || s === 'CANCELLED' || s === 'EXPIRED';
}

export interface Order {
  clientOrderId: ClientOrderId;
  intentId: IntentId;
  sessionId: SessionId;
  instrumentId: InstrumentId;
  side: Side;
  qty: number;
  filledQty: number;
  /** Volume-weighted; 0 until first fill. */
  avgFillPricePaise: number;
  type: OrderType;
  limitPricePaise?: number;
  triggerPricePaise?: number;
  state: OrderState;
  purpose: IntentPurpose;
  tag: string;
  /** Internal close allocation copied from the originating intent. */
  closeLotIds?: string[];
  brokerOrderId?: string;
  rejectReason?: string;
  createdTs: number;
  updatedTs: number;
}

export interface Fill {
  clientOrderId: ClientOrderId;
  /** Broker fill id, or synthetic for paper. */
  fillId: string;
  ts: number;
  qty: number;
  pricePaise: number;
}
