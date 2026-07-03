import type { OptionRight } from '../domain/instrument.js';
import type { StopPlan } from '../domain/orders.js';

export interface StopPlanPcts {
  /** L1 hard stop as % below entry premium. */
  hardStopPremiumPct: number;
  /** L2 breakeven arms at entry × (1 + pct/100). */
  breakevenAtPct?: number;
  /** L2 trail step as % of entry premium. */
  trailStepPct?: number;
  /** L2 % of open profit locked per step. */
  trailLockPct?: number;
  /** L3 time stop. */
  timeStopSec: number;
}

export type UnderlyingInvalidation =
  | { kind: 'atr'; spotPaise: number; atrPaise: number; mult: number }
  | { kind: 'pct'; spotPaise: number; pct: number };

/**
 * Build a complete long-option StopPlan from percentage params.
 * All levels snap to the tick grid; the hard stop is always strictly below
 * the entry premium (floored at one tick).
 */
export function buildLongOptionStopPlan(args: {
  entryPremiumPaise: number;
  tickSizePaise: number;
  right: OptionRight;
  pcts: StopPlanPcts;
  invalidation?: UnderlyingInvalidation;
}): StopPlan {
  const { entryPremiumPaise: entry, tickSizePaise: tick, right, pcts } = args;
  const snap = (v: number): number => Math.max(tick, Math.round(v / tick) * tick);

  let hard = snap(entry * (1 - pcts.hardStopPremiumPct / 100));
  if (hard >= entry) hard = Math.max(tick, entry - tick);

  const plan: StopPlan = {
    hardStopPremiumPaise: hard,
    timeStopSec: pcts.timeStopSec,
    ...(pcts.breakevenAtPct !== undefined
      ? { breakevenAtPaise: snap(entry * (1 + pcts.breakevenAtPct / 100)) }
      : {}),
    ...(pcts.trailStepPct !== undefined
      ? { trailStepPaise: Math.max(tick, snap(entry * (pcts.trailStepPct / 100))) }
      : {}),
    ...(pcts.trailLockPct !== undefined ? { trailLockPct: pcts.trailLockPct } : {}),
  };

  const inv = args.invalidation;
  if (inv !== undefined) {
    // Long CE is invalidated by spot falling; long PE by spot rising.
    const distance = inv.kind === 'atr' ? inv.atrPaise * inv.mult : inv.spotPaise * (inv.pct / 100);
    if (distance > 0) {
      const level = right === 'CE' ? Math.round(inv.spotPaise - distance) : Math.round(inv.spotPaise + distance);
      return {
        ...plan,
        hardStopUnderlyingPaise: level,
        hardStopUnderlyingDir: right === 'CE' ? 'BELOW' : 'ABOVE',
      };
    }
  }
  return plan;
}
