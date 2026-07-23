import type { ChargeBreakdown } from './charges.js';
import type { ClientOrderId, InstrumentId, PositionId, SessionId, TradeId } from './ids.js';
import type { OptionRight } from './instrument.js';
import type { Side } from './orders.js';
import type { StopState } from './risk.js';

export type PositionState = 'OPEN' | 'CLOSING' | 'CLOSED';

export interface Position {
  positionId: PositionId;
  sessionId: SessionId;
  strategyId: string;
  instrumentId: InstrumentId;
  /** Entry side: BUY for long premium, SELL for a short option. */
  side: Side;
  /** Current open quantity in units. */
  qty: number;
  avgEntryPricePaise: number;
  state: PositionState;
  /** Accumulated gross P&L from partial exits. */
  realizedGrossPaise: number;
  stop?: StopState;
  openedTs: number;
  updatedTs: number;
}

export interface TradeLeg {
  side: Side;
  qty: number;
  pricePaise: number;
  ts: number;
  clientOrderId: ClientOrderId;
}

/** A completed round trip, with the full cost waterfall. */
export interface Trade {
  tradeId: TradeId;
  sessionId: SessionId;
  strategyId: string;
  instrumentId: InstrumentId;
  qty: number;
  entry: TradeLeg;
  exit: TradeLeg;
  grossPnlPaise: number;
  charges: ChargeBreakdown;
  netPnlPaise: number;
  /** e.g. 'L1_HARD_STOP', 'L2_TRAIL', 'L3_TIME', 'SQUARE_OFF', 'KILL'. */
  exitReason: string;
  holdMs: number;
  /**
   * Option contract labels resolved at fill time. Present when the OMS was
   * given an instrument-info port; lets the UI blotter show strike/right
   * without a live chain lookup (which breaks after an expiry roll).
   */
  strikePaise?: number;
  right?: OptionRight;
}
