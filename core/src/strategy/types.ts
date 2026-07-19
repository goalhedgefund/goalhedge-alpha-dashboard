import type { InstrumentId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { OptionChainRow } from '../domain/marketdata.js';
import type { StopPlan } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import type { OptionFeatures, UnderlyingFeatures } from '../marketdata/features/library.js';

/**
 * Strategy lifecycle: DISARMED → ARMED → ACTIVE (position open) → COOLDOWN → ARMED.
 * Param changes apply only when flat; re-arms are operator actions.
 */
export type StrategyLifecycle = 'DISARMED' | 'ARMED' | 'ACTIVE' | 'COOLDOWN';

export type StrategyParams = Record<string, number | string | boolean>;

export interface OptionView {
  instrumentId: InstrumentId;
  row?: OptionChainRow;
  features?: OptionFeatures;
}

/** Read-only market view handed to a strategy. Strategies never touch the OMS. */
export interface StrategyView {
  nowMs: number;
  spotPaise?: number;
  underlyingFeatures?: UnderlyingFeatures;
  atmStrikePaise?: number;
  /** Resolve the current ATM option for a side (undefined if no quote yet). */
  atmOption(right: OptionRight): OptionView | undefined;
  position?: Position;
  params: StrategyParams;
}

/**
 * An entry proposal. The stopPlan is mandatory by type — a strategy cannot
 * propose an entry without a complete risk definition.
 */
export interface EntryProposal {
  kind: 'ENTRY';
  right: OptionRight;
  instrumentId: InstrumentId;
  qtyLots: number;
  entryType: 'LIMIT';
  limitPricePaise: number;
  ttlMs: number;
  stopPlan: StopPlan;
  confidence?: number;
  note?: string;
}

export interface NoSignal {
  kind: 'NONE';
  /** Machine-readable no-trade reason, journaled (deduplicated + heartbeat) by the runner. */
  reason?: string;
  /** Optional diagnostic detail forwarded to the journal alongside reason. */
  detail?: string;
}

export type StrategyDecision = EntryProposal | NoSignal;

/**
 * Pure decision logic. The runner owns lifecycle, eligibility, the risk
 * gate, order submission, and stop management — a strategy only ever answers
 * "given this view, do you want to be long CE, long PE, or nothing?".
 */
export interface IStrategy {
  readonly id: string;
  readonly version: string;
  decide(view: StrategyView): StrategyDecision;
  /** Clear internal counters (called on arm, param change, and after a trade). */
  reset(): void;
}

export function numParam(params: StrategyParams, key: string, dflt: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

export function none(reason: string, detail?: string): NoSignal {
  return { kind: 'NONE', reason, ...(detail !== undefined ? { detail } : {}) };
}
