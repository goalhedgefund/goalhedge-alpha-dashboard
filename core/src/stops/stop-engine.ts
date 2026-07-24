import { IdFactory } from '../domain/ids.js';
import type { OrderIntent, StopPlan } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import type { SessionStopKind, StopState } from '../domain/risk.js';

export type StopTriggerReason =
  | 'L1_HARD_PREMIUM'
  | 'L1_UNDERLYING'
  | 'L2_TARGET'
  | 'L2_TRAIL'
  | 'L3_TIME'
  | 'L4_SESSION';

export interface StopEngineOptions {
  ids: IdFactory;
  tickSizePaise: number;
  protectionTicks?: number;
}

export interface StopTick {
  nowMs: number;
  premiumPaise: number;
  underlyingPaise?: number;
}

export interface StopDecision {
  state: StopState;
  moved: boolean;
  trigger?: {
    reason: StopTriggerReason;
    exitIntent: OrderIntent;
  };
}

interface ManagedPosition {
  position: Position;
  stopPlan: StopPlan;
  state: StopState;
}

export class StopEngine {
  private readonly managed = new Map<string, ManagedPosition>();
  private readonly protectionTicks: number;

  constructor(private readonly opts: StopEngineOptions) {
    this.protectionTicks = opts.protectionTicks ?? 3;
  }

  arm(position: Position, stopPlan: StopPlan): StopState {
    const state: StopState = {
      positionId: position.positionId,
      layer: 'HARD',
      stopPremiumPaise: stopPlan.hardStopPremiumPaise,
      highWaterPremiumPaise: position.avgEntryPricePaise,
      armedTs: position.openedTs,
      timeStopDeadlineTs: position.openedTs + stopPlan.timeStopSec * 1000,
      lastMoveTs: position.openedTs,
    };
    this.managed.set(position.positionId, { position, stopPlan, state });
    return state;
  }

  update(position: Position, tick: StopTick, sessionStop?: SessionStopKind): StopDecision | undefined {
    const managed = this.managed.get(position.positionId);
    if (managed === undefined) return undefined;
    managed.position = position;
    const prev = managed.state;
    let next = { ...prev, highWaterPremiumPaise: Math.max(prev.highWaterPremiumPaise, tick.premiumPaise) };

    const breakevenAt = managed.stopPlan.breakevenAtPaise;
    if (breakevenAt !== undefined && tick.premiumPaise >= breakevenAt) {
      next = this.raiseStop(next, position.avgEntryPricePaise, 'BREAKEVEN', tick.nowMs);
    }

    if (managed.stopPlan.trailStepPaise !== undefined && managed.stopPlan.trailLockPct !== undefined) {
      const openProfit = next.highWaterPremiumPaise - position.avgEntryPricePaise;
      if (openProfit >= managed.stopPlan.trailStepPaise) {
        const locked = position.avgEntryPricePaise + Math.floor(openProfit * (managed.stopPlan.trailLockPct / 100));
        next = this.raiseStop(next, locked, 'TRAIL', tick.nowMs);
      }
    }

    let reason: StopTriggerReason | undefined;
    const target = managed.stopPlan.targetPaise;
    if (sessionStop !== undefined) reason = 'L4_SESSION';
    // Take-profit takes priority over the time stop: a long fade that has hit
    // its target should bank it rather than wait out the clock.
    else if (target !== undefined && tick.premiumPaise >= target) reason = 'L2_TARGET';
    else if (tick.premiumPaise <= next.stopPremiumPaise) reason = next.layer === 'TRAIL' || next.layer === 'BREAKEVEN' ? 'L2_TRAIL' : 'L1_HARD_PREMIUM';
    else if (this.underlyingInvalidated(managed.stopPlan, tick.underlyingPaise)) reason = 'L1_UNDERLYING';
    else if (tick.nowMs >= next.timeStopDeadlineTs) reason = 'L3_TIME';

    managed.state = next;
    const moved = next.stopPremiumPaise !== prev.stopPremiumPaise || next.layer !== prev.layer;
    if (reason === undefined) return { state: next, moved };
    return {
      state: next,
      moved,
      trigger: {
        reason,
        exitIntent: this.exitIntent(position, reason, tick),
      },
    };
  }

  get(positionId: string): StopState | undefined {
    return this.managed.get(positionId)?.state;
  }

  /**
   * Stop managing a position. The caller MUST disarm as soon as it acts on a
   * trigger (or the position closes) — otherwise every subsequent update()
   * re-fires the trigger and mints a duplicate exit intent (oversell risk).
   */
  disarm(positionId: string): boolean {
    return this.managed.delete(positionId);
  }

  private raiseStop(state: StopState, candidatePaise: number, layer: StopState['layer'], nowMs: number): StopState {
    if (candidatePaise <= state.stopPremiumPaise) return state;
    return {
      ...state,
      layer,
      stopPremiumPaise: candidatePaise,
      lastMoveTs: nowMs,
    };
  }

  private underlyingInvalidated(stopPlan: StopPlan, underlyingPaise: number | undefined): boolean {
    if (underlyingPaise === undefined || stopPlan.hardStopUnderlyingPaise === undefined || stopPlan.hardStopUnderlyingDir === undefined) return false;
    return stopPlan.hardStopUnderlyingDir === 'BELOW'
      ? underlyingPaise <= stopPlan.hardStopUnderlyingPaise
      : underlyingPaise >= stopPlan.hardStopUnderlyingPaise;
  }

  private exitIntent(position: Position, reason: StopTriggerReason, tick: StopTick): OrderIntent {
    return {
      intentId: this.opts.ids.intentId(),
      sessionId: position.sessionId,
      strategyId: position.strategyId,
      ts: tick.nowMs,
      side: 'SELL',
      instrumentId: position.instrumentId,
      qty: position.qty,
      type: 'LIMIT',
      limitPricePaise: Math.max(this.opts.tickSizePaise, tick.premiumPaise - this.protectionTicks * this.opts.tickSizePaise),
      protectTicks: this.protectionTicks,
      ttlMs: 500,
      tag: `${position.strategyId}:stop:${reason}`,
      purpose: 'STOP',
    };
  }
}
