import { describe, expect, it } from 'vitest';
import { S2VwapFade } from '../src/strategy/strategies/s2-vwap-fade.js';
import { CE_ID, PE_ID, mkFeatures, mkView } from './helpers/strategy-fixtures.js';

const PARAMS = {
  stretchPct: 0.0015,
  decelRatio: 0.2,
  bigTrendPct: 0.004,
  confirmTicks: 1,
  lots: 1,
  ttlMs: 1500,
  tickSizePaise: 5,
  timeStopSec: 60,
  hardStopPremiumPct: 20,
  breakevenAtPct: 10,
  trailStepPct: 6,
  trailLockPct: 50,
  invalidatePct: 0.1,
};

const VWAP = 2_450_000;

describe('S2 vwap fade', () => {
  it('WARMUP without vwap', () => {
    const s = new S2VwapFade();
    const d = s.decide(mkView({ params: PARAMS, features: mkFeatures({ vwapPaise: undefined }) }));
    expect(d).toMatchObject({ kind: 'NONE', reason: 'WARMUP' });
  });

  it('stretched above vwap with opposing ret1s → buys PE', () => {
    const s = new S2VwapFade();
    const spot = Math.round(VWAP * 1.002); // +0.2% stretch
    const d = s.decide(
      mkView({
        params: PARAMS,
        spotPaise: spot,
        features: mkFeatures({ vwapPaise: VWAP, ret1s: -0.0003, ret5s: 0.001, ret30s: 0.002 }),
      }),
    );
    expect(d.kind).toBe('ENTRY');
    if (d.kind === 'ENTRY') {
      expect(d.right).toBe('PE');
      expect(d.instrumentId).toBe(PE_ID);
      // Fade thesis invalidation: spot continuing ABOVE (for a PE) kills it.
      expect(d.stopPlan.hardStopUnderlyingDir).toBe('ABOVE');
      expect(d.stopPlan.hardStopUnderlyingPaise).toBe(Math.round(spot + spot * 0.001));
      expect(d.stopPlan.timeStopSec).toBe(60);
    }
  });

  it('stretched below vwap with deceleration → buys CE', () => {
    const s = new S2VwapFade();
    const spot = Math.round(VWAP * 0.998); // −0.2% stretch
    const d = s.decide(
      mkView({
        params: PARAMS,
        spotPaise: spot,
        // ret1s tiny relative to ret5s → decelerating.
        features: mkFeatures({ vwapPaise: VWAP, ret1s: -0.00001, ret5s: -0.001, ret30s: -0.002 }),
      }),
    );
    expect(d.kind).toBe('ENTRY');
    if (d.kind === 'ENTRY') {
      expect(d.right).toBe('CE');
      expect(d.instrumentId).toBe(CE_ID);
      expect(d.stopPlan.hardStopUnderlyingDir).toBe('BELOW');
    }
  });

  it('refuses to fade a strong trend', () => {
    const s = new S2VwapFade();
    const d = s.decide(
      mkView({
        params: PARAMS,
        spotPaise: Math.round(VWAP * 1.002),
        features: mkFeatures({ vwapPaise: VWAP, ret1s: -0.0003, ret5s: 0.001, ret30s: 0.006 }),
      }),
    );
    expect(d).toMatchObject({ kind: 'NONE', reason: 'TRENDING' });
  });

  it('no fade signal while momentum is still accelerating with the stretch', () => {
    const s = new S2VwapFade();
    const d = s.decide(
      mkView({
        params: PARAMS,
        spotPaise: Math.round(VWAP * 1.002),
        features: mkFeatures({ vwapPaise: VWAP, ret1s: 0.001, ret5s: 0.001, ret30s: 0.002 }),
      }),
    );
    expect(d).toMatchObject({ kind: 'NONE', reason: 'NO_FADE' });
  });

  it('inside the band → NO_STRETCH', () => {
    const s = new S2VwapFade();
    const d = s.decide(
      mkView({
        params: PARAMS,
        spotPaise: VWAP + 1_000, // +0.04%, inside band
        features: mkFeatures({ vwapPaise: VWAP, ret1s: 0, ret5s: 0 }),
      }),
    );
    expect(d).toMatchObject({ kind: 'NONE', reason: 'NO_STRETCH' });
  });

  it('ADX slow-trend gate refuses to fade a persistent grind (ret30s below fast-trend cutoff)', () => {
    const spot = Math.round(VWAP * 1.002); // +0.2% stretch, valid fade setup
    // ret30s = 0.002 < bigTrendPct(0.004) → passes the fast-trend guard.
    const feats = { vwapPaise: VWAP, ret1s: -0.0003, ret5s: 0.001, ret30s: 0.002 };

    // ADX above the cutoff → trending regime → blocked with detail 'adx'.
    const blocked = new S2VwapFade().decide(
      mkView({ params: { ...PARAMS, adxTrendMax: 25 }, spotPaise: spot, features: mkFeatures({ ...feats, adx1m: 32 }) }),
    );
    expect(blocked).toMatchObject({ kind: 'NONE', reason: 'TRENDING', detail: 'adx' });

    // ADX below cutoff → range-bound → fade allowed.
    const allowed = new S2VwapFade().decide(
      mkView({ params: { ...PARAMS, adxTrendMax: 25 }, spotPaise: spot, features: mkFeatures({ ...feats, adx1m: 18 }) }),
    );
    expect(allowed.kind).toBe('ENTRY');

    // ADX warming up (undefined) must not gate.
    const warmup = new S2VwapFade().decide(
      mkView({ params: { ...PARAMS, adxTrendMax: 25 }, spotPaise: spot, features: mkFeatures(feats) }),
    );
    expect(warmup.kind).toBe('ENTRY');
  });

  it('volatility-scaled band widens the entry threshold with realized vol', () => {
    const spot = Math.round(VWAP * 1.002); // +0.2% stretch
    const feats = { vwapPaise: VWAP, ret1s: -0.0003, ret5s: 0.001, ret30s: 0.002, atr1mPaise: 1_500 };

    // Fixed band (bandAtrMult 0): 0.2% clears the 0.15% floor → fires.
    expect(new S2VwapFade().decide(mkView({ params: PARAMS, spotPaise: spot, features: mkFeatures(feats) })).kind).toBe('ENTRY');

    // Vol-scaled: threshold = 5 × 1500 / 2,450,000 = 0.306% > 0.2% → below band.
    const d = new S2VwapFade().decide(
      mkView({ params: { ...PARAMS, bandAtrMult: 5 }, spotPaise: spot, features: mkFeatures(feats) }),
    );
    expect(d).toMatchObject({ kind: 'NONE', reason: 'NO_STRETCH' });
  });
});
