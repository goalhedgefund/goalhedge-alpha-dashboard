import { buildLongOptionStopPlan } from '../stop-plan.js';
import { none, numParam, type IStrategy, type StrategyDecision, type StrategyView } from '../types.js';

/**
 * S2 — VWAP fade (long-only counter-scalp).
 *
 * When spot stretches beyond ±stretchPct from VWAP AND momentum is fading
 * (ret1s opposing the stretch, or decelerating vs ret5s), buy the opposite
 * option: stretched up → PE, stretched down → CE. Refuses to fade a strong
 * trend (|ret30s| > bigTrendPct). Tighter time stop than S1 — a fade must
 * work quickly or it is wrong. Underlying invalidation: spot continuing
 * invalidatePct beyond entry spot kills the fade thesis.
 */
export class S2VwapFade implements IStrategy {
  readonly id = 's2-vwap-fade';
  readonly version = '0.1.0';

  private confirmCount = 0;
  private lastDir: 'CE' | 'PE' | undefined;

  reset(): void {
    this.confirmCount = 0;
    this.lastDir = undefined;
  }

  decide(view: StrategyView): StrategyDecision {
    const p = view.params;
    const f = view.underlyingFeatures;
    const spot = view.spotPaise;
    if (f?.vwapPaise === undefined || spot === undefined) {
      const missing: string[] = [];
      if (f?.vwapPaise === undefined) missing.push('vwap');
      if (spot === undefined) missing.push('spot');
      return none('WARMUP', missing.join('+'));
    }

    const stretch = (spot - f.vwapPaise) / f.vwapPaise;
    const stretchPct = numParam(p, 'stretchPct', 0.0015);
    const bigTrendPct = numParam(p, 'bigTrendPct', 0.004);

    if (f.ret30s !== undefined && Math.abs(f.ret30s) > bigTrendPct) {
      this.confirmCount = 0;
      return none('TRENDING');
    }

    const dir: 'CE' | 'PE' | undefined =
      stretch >= stretchPct ? 'PE' : stretch <= -stretchPct ? 'CE' : undefined;
    if (dir === undefined) {
      this.confirmCount = 0;
      this.lastDir = undefined;
      return none('NO_STRETCH');
    }
    if (dir !== this.lastDir) {
      this.lastDir = dir;
      this.confirmCount = 0;
    }

    // Fade needs fading momentum: ret1s opposing the stretch, or clearly
    // decelerating relative to ret5s.
    const decelRatio = numParam(p, 'decelRatio', 0.2);
    const r1 = f.ret1s;
    const r5 = f.ret5s;
    const opposing = r1 !== undefined && Math.sign(r1) !== Math.sign(stretch) && r1 !== 0;
    const decelerating = r1 !== undefined && r5 !== undefined && Math.abs(r1) <= Math.abs(r5) * decelRatio;
    if (!opposing && !decelerating) {
      this.confirmCount = 0;
      return none('NO_FADE');
    }

    const opt = view.atmOption(dir);
    if (opt?.row === undefined || opt.row.askPaise <= 0) return none('NO_OPTION_QUOTE');

    this.confirmCount++;
    if (this.confirmCount < numParam(p, 'confirmTicks', 2)) return none('CONFIRMING');
    this.confirmCount = 0;

    const entry = opt.row.askPaise;
    const stopPlan = buildLongOptionStopPlan({
      entryPremiumPaise: entry,
      tickSizePaise: numParam(p, 'tickSizePaise', 5),
      right: dir,
      pcts: {
        hardStopPremiumPct: numParam(p, 'hardStopPremiumPct', 20),
        breakevenAtPct: numParam(p, 'breakevenAtPct', 10),
        trailStepPct: numParam(p, 'trailStepPct', 6),
        trailLockPct: numParam(p, 'trailLockPct', 50),
        // Take-profit is opt-in via config (targetPct); 0/absent leaves it off.
        targetPct: numParam(p, 'targetPct', 0),
        timeStopSec: numParam(p, 'timeStopSec', 60),
      },
      invalidation: { kind: 'pct', spotPaise: spot, pct: numParam(p, 'invalidatePct', 0.1) },
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
      note: `stretch=${(stretch * 100).toFixed(3)}%`,
    };
  }
}
