import { describe, expect, it } from 'vitest';
import { S1MomentumBurst } from '../src/strategy/strategies/s1-momentum-burst.js';
import { CE_ID, PE_ID, mkFeatures, mkView } from './helpers/strategy-fixtures.js';

const PARAMS = {
  impulsePct: 0.001,
  confirmTicks: 2,
  lots: 1,
  ttlMs: 1500,
  tickSizePaise: 5,
  timeStopSec: 90,
  hardStopPremiumPct: 25,
  breakevenAtPct: 12,
  trailStepPct: 8,
  trailLockPct: 50,
  atrMult: 1,
};

describe('S1 momentum burst', () => {
  it('WARMUP without ret5s, NO_IMPULSE when flat', () => {
    const s = new S1MomentumBurst();
    const warm = s.decide(mkView({ params: PARAMS, features: mkFeatures({ ret5s: undefined }) }));
    expect(warm).toMatchObject({ kind: 'NONE', reason: 'WARMUP' });
    const flat = s.decide(mkView({ params: PARAMS, features: mkFeatures({ ret5s: 0.0001 }) }));
    expect(flat).toMatchObject({ kind: 'NONE', reason: 'NO_IMPULSE' });
  });

  it('requires confirmTicks consecutive confirming ticks, then proposes CE on an up-impulse', () => {
    const s = new S1MomentumBurst();
    const view = (): ReturnType<typeof mkView> =>
      mkView({ params: PARAMS, features: mkFeatures({ ret5s: 0.002 }) });

    const first = s.decide(view());
    expect(first).toMatchObject({ kind: 'NONE', reason: 'CONFIRMING' });

    const second = s.decide(view());
    expect(second.kind).toBe('ENTRY');
    if (second.kind === 'ENTRY') {
      expect(second.right).toBe('CE');
      expect(second.instrumentId).toBe(CE_ID);
      expect(second.limitPricePaise).toBe(15_000); // buys at ask
      expect(second.qtyLots).toBe(1);
    }
  });

  it('down-impulse proposes PE', () => {
    const s = new S1MomentumBurst();
    const view = (): ReturnType<typeof mkView> =>
      mkView({ params: PARAMS, features: mkFeatures({ ret5s: -0.002 }) });
    s.decide(view());
    const d = s.decide(view());
    expect(d.kind).toBe('ENTRY');
    if (d.kind === 'ENTRY') {
      expect(d.right).toBe('PE');
      expect(d.instrumentId).toBe(PE_ID);
    }
  });

  it('direction flip resets the confirmation counter', () => {
    const s = new S1MomentumBurst();
    s.decide(mkView({ params: PARAMS, features: mkFeatures({ ret5s: 0.002 }) })); // CE confirm 1
    const flipped = s.decide(mkView({ params: PARAMS, features: mkFeatures({ ret5s: -0.002 }) }));
    expect(flipped).toMatchObject({ kind: 'NONE', reason: 'CONFIRMING' }); // PE confirm restarts at 1
  });

  it('the proposal carries a complete, sane stop plan', () => {
    const s = new S1MomentumBurst();
    const v = (): ReturnType<typeof mkView> =>
      mkView({ params: PARAMS, features: mkFeatures({ ret5s: 0.002, atr1mPaise: 1_500 }), spotPaise: 2_450_000 });
    s.decide(v());
    const d = s.decide(v());
    expect(d.kind).toBe('ENTRY');
    if (d.kind !== 'ENTRY') return;

    const plan = d.stopPlan;
    const entry = d.limitPricePaise;
    // Hard stop strictly below entry, on the tick grid, 25% down.
    expect(plan.hardStopPremiumPaise).toBe(11_250);
    expect(plan.hardStopPremiumPaise % 5).toBe(0);
    expect(plan.hardStopPremiumPaise).toBeLessThan(entry);
    // Breakeven above entry; trail step positive; time stop set.
    expect(plan.breakevenAtPaise).toBe(16_800);
    expect(plan.trailStepPaise).toBe(1_200);
    expect(plan.trailLockPct).toBe(50);
    expect(plan.timeStopSec).toBe(90);
    // ATR-based underlying invalidation for a long CE sits BELOW spot.
    expect(plan.hardStopUnderlyingDir).toBe('BELOW');
    expect(plan.hardStopUnderlyingPaise).toBe(2_450_000 - 1_500);
  });

  it('omits underlying invalidation when ATR is unavailable', () => {
    const s = new S1MomentumBurst();
    const v = (): ReturnType<typeof mkView> =>
      mkView({ params: PARAMS, features: mkFeatures({ ret5s: 0.002, atr1mPaise: undefined }) });
    s.decide(v());
    const d = s.decide(v());
    expect(d.kind).toBe('ENTRY');
    if (d.kind === 'ENTRY') {
      expect(d.stopPlan.hardStopUnderlyingPaise).toBeUndefined();
    }
  });

  it('hostile order-flow imbalance blocks confirmation', () => {
    const s = new S1MomentumBurst();
    const params = { ...PARAMS, minImbalance: 0.2 };
    const ce = mkView({ params, features: mkFeatures({ ret5s: 0.002 }) });
    // Default view has no option features → imbalance undefined → passes.
    // Craft a view whose CE has hostile imbalance via features.
    const view = {
      ...ce,
      atmOption: (right: 'CE' | 'PE') =>
        right === 'CE'
          ? {
              instrumentId: CE_ID,
              row: ce.atmOption('CE')!.row!,
              features: {
                premiumVelocityPaisePerSec: 10,
                bidAskImbalance: -0.5,
                spreadPaise: 10,
                spreadPct: 0.0007,
                spreadStable: true,
                iv: undefined,
                delta: undefined,
                gamma: undefined,
                theta: undefined,
                vega: undefined,
                atmDriftPaise: 0,
              },
            }
          : undefined,
    };
    expect(s.decide(view)).toMatchObject({ kind: 'NONE', reason: 'NO_CONFIRM' });
  });
});
