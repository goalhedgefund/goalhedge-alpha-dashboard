import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { black76Greeks, black76Price, impliedVolBlack76 } from '../src/marketdata/black76.js';

describe('Black-76 analytics (M4 acceptance)', () => {
  it('prices an ATM one-year call against known value', () => {
    const price = black76Price({
      right: 'CE',
      forward: 100,
      strike: 100,
      timeToExpiryYears: 1,
      volatility: 0.2,
      riskFreeRate: 0,
    });
    expect(price).toBeCloseTo(7.965567, 4);
  });

  it('implied vol recovers the input volatility to tight tolerance', () => {
    const price = black76Price({
      right: 'PE',
      forward: 102,
      strike: 100,
      timeToExpiryYears: 0.25,
      volatility: 0.31,
      riskFreeRate: 0.05,
    });
    const iv = impliedVolBlack76('PE', price, 102, 100, 0.25, { riskFreeRate: 0.05 });
    expect(iv).toBeCloseTo(0.31, 6);
  });

  it('call and put greeks have expected signs', () => {
    const call = black76Greeks({ right: 'CE', forward: 100, strike: 100, timeToExpiryYears: 0.5, volatility: 0.25 });
    const put = black76Greeks({ right: 'PE', forward: 100, strike: 100, timeToExpiryYears: 0.5, volatility: 0.25 });
    expect(call.delta).toBeGreaterThan(0);
    expect(put.delta).toBeLessThan(0);
    expect(call.gamma).toBeGreaterThan(0);
    expect(put.gamma).toBeGreaterThan(0);
    expect(call.vega).toBeGreaterThan(0);
    expect(put.vega).toBeGreaterThan(0);
    expect(call.theta).toBeLessThan(0);
    expect(put.theta).toBeLessThan(0);
  });

  it('property: option price is non-decreasing in volatility', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('CE' as const, 'PE' as const),
        fc.double({ min: 50, max: 200, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 50, max: 200, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.01, max: 2, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.01, max: 2, noNaN: true, noDefaultInfinity: true }),
        (right, forward, strike, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const pLo = black76Price({ right, forward, strike, timeToExpiryYears: 0.25, volatility: lo });
          const pHi = black76Price({ right, forward, strike, timeToExpiryYears: 0.25, volatility: hi });
          expect(pHi).toBeGreaterThanOrEqual(pLo - 1e-9);
        },
      ),
    );
  });
});
