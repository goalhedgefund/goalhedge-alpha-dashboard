import { buildLongOptionStopPlan } from '../stop-plan.js';
import { none, numParam, type IStrategy, type StrategyDecision, type StrategyView } from '../types.js';

/**
 * S1 — ATM momentum burst (long-only option buying).
 *
 * Underlying impulse (ret5s beyond ±impulsePct) + option confirmation
 * (premium velocity positive, order-flow imbalance not hostile) sustained
 * for confirmTicks consecutive ticks → buy the ATM option in the impulse
 * direction. Exits are owned entirely by the Stop Engine via the stopPlan
 * attached to the proposal (hard %, breakeven, step-trail, time stop, and
 * ATR-based underlying invalidation when ATR is available).
 *
 * Reference implementation to validate the platform; expected to be
 * cost-challenged. Its honest net-of-charges paper performance is the
 * deliverable.
 */
export class S1MomentumBurst implements IStrategy {
  readonly id = 's1-momentum-burst';
  readonly version = '0.1.0';

  private confirmCount = 0;
  private lastDir: 'CE' | 'PE' | undefined;

  reset(): void {
    this.confirmCount = 0;
    this.lastDir = undefined;
  }

  decide(view: StrategyView): StrategyDecision {
    const p = view.params;
    const impulsePct = numParam(p, 'impulsePct', 0.0008);
    const confirmTicks = numParam(p, 'confirmTicks', 3);

    const f = view.underlyingFeatures;
    if (f?.ret5s === undefined) return none('WARMUP');

    const dir: 'CE' | 'PE' | undefined =
      f.ret5s >= impulsePct ? 'CE' : f.ret5s <= -impulsePct ? 'PE' : undefined;
    if (dir === undefined) {
      this.confirmCount = 0;
      this.lastDir = undefined;
      return none('NO_IMPULSE');
    }
    if (dir !== this.lastDir) {
      this.lastDir = dir;
      this.confirmCount = 0;
    }

    const opt = view.atmOption(dir);
    if (opt?.row === undefined || opt.row.askPaise <= 0) return none('NO_OPTION_QUOTE');

    const velocity = opt.features?.premiumVelocityPaisePerSec;
    const imbalance = opt.features?.bidAskImbalance;
    const minImbalance = numParam(p, 'minImbalance', 0);
    const confirmed =
      (velocity === undefined || velocity > 0) &&
      (imbalance === undefined || imbalance >= minImbalance);
    if (!confirmed) {
      this.confirmCount = 0;
      return none('NO_CONFIRM');
    }

    this.confirmCount++;
    if (this.confirmCount < confirmTicks) return none('CONFIRMING');
    this.confirmCount = 0;

    const entry = opt.row.askPaise;
    const tick = numParam(p, 'tickSizePaise', 5);
    const atr = f.atr1mPaise;
    const spot = view.spotPaise;
    const atrMult = numParam(p, 'atrMult', 1);

    const stopPlan = buildLongOptionStopPlan({
      entryPremiumPaise: entry,
      tickSizePaise: tick,
      right: dir,
      pcts: {
        hardStopPremiumPct: numParam(p, 'hardStopPremiumPct', 25),
        breakevenAtPct: numParam(p, 'breakevenAtPct', 12),
        trailStepPct: numParam(p, 'trailStepPct', 8),
        trailLockPct: numParam(p, 'trailLockPct', 50),
        timeStopSec: numParam(p, 'timeStopSec', 90),
      },
      ...(spot !== undefined && atr !== undefined && atr > 0
        ? { invalidation: { kind: 'atr' as const, spotPaise: spot, atrPaise: atr, mult: atrMult } }
        : {}),
    });

    return {
      kind: 'ENTRY',
      right: dir,
      instrumentId: opt.instrumentId,
      qtyLots: numParam(p, 'lots', 1),
      entryType: 'LIMIT',
      limitPricePaise: entry,
      ttlMs: numParam(p, 'ttlMs', 1500),
      stopPlan,
      note: `ret5s=${f.ret5s.toFixed(5)}`,
    };
  }
}
