import type { IntentId, PositionId } from './ids.js';

export interface RiskVerdict {
  intentId: IntentId;
  ts: number;
  approved: boolean;
  /** Reason code when rejected, e.g. 'SPREAD_GATE', 'DAILY_LOSS_HALT'. */
  reason?: string;
  /** Computed rupee risk (paise) at approval time. */
  riskPaise?: number;
}

export type StopLayer = 'HARD' | 'BREAKEVEN' | 'TRAIL';

/**
 * Current stop status of one open position. Owned by the Stop Engine (M6);
 * the invariant everywhere: stopPremiumPaise may only ever move UP for a
 * long-premium position.
 */
export interface StopState {
  positionId: PositionId;
  layer: StopLayer;
  /** Current effective stop on the option premium. */
  stopPremiumPaise: number;
  /** Highest premium seen since entry (trail reference). */
  highWaterPremiumPaise: number;
  armedTs: number;
  timeStopDeadlineTs: number;
  lastMoveTs: number;
}

export type SessionStopKind = 'DAILY_LOSS' | 'GIVE_BACK' | 'LOSS_STREAK' | 'MAX_TRADES';
