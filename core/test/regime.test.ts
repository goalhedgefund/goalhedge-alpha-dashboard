import { describe, expect, it } from 'vitest';
import type { InstrumentId } from '../src/domain/ids.js';
import { makeInstrumentId } from '../src/domain/ids.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import type { Clock } from '../src/domain/time.js';
import type { MarketViewProvider } from '../src/strategy/runner.js';
import { FeatureRegimeProvider } from '../src/strategy/regime.js';
import type { StrategyView } from '../src/strategy/types.js';
import { mkFeatures } from './helpers/strategy-fixtures.js';

const INSTR: InstrumentId = makeInstrumentId('NSE', 'CE1');

class StaticView implements MarketViewProvider {
  constructor(private readonly view: Omit<StrategyView, 'params'>) {}

  strategyView(): Omit<StrategyView, 'params'> {
    return this.view;
  }

  allowedInstruments(): ReadonlySet<InstrumentId> {
    return new Set([INSTR]);
  }

  optionRows(): ReadonlyMap<InstrumentId, OptionChainRow> {
    return new Map();
  }

  atmStrikePaise(): number | undefined {
    return 2_450_000;
  }

  spotPaise(): number | undefined {
    return this.view.spotPaise;
  }
}

const clock: Clock = { now: () => 1_000 };

function provider(view: Omit<StrategyView, 'params'>): FeatureRegimeProvider {
  return new FeatureRegimeProvider({ view: new StaticView(view), clock });
}

describe('FeatureRegimeProvider', () => {
  it('detects directional regimes only when return agrees with VWAP stretch', () => {
    expect(provider({
      nowMs: 1_000,
      spotPaise: 2_455_000,
      underlyingFeatures: mkFeatures({ ret30s: 0.002, vwapPaise: 2_450_000 }),
      atmOption: () => undefined,
    }).trend()).toBe(1);

    expect(provider({
      nowMs: 1_000,
      spotPaise: 2_445_000,
      underlyingFeatures: mkFeatures({ ret30s: -0.002, vwapPaise: 2_450_000 }),
      atmOption: () => undefined,
    }).trend()).toBe(-1);

    expect(provider({
      nowMs: 1_000,
      spotPaise: 2_455_000,
      underlyingFeatures: mkFeatures({ ret30s: -0.002, vwapPaise: 2_450_000 }),
      atmOption: () => undefined,
    }).trend()).toBe(0);
  });

  it('flags high-volatility conditions from recent return or ATR', () => {
    expect(provider({
      nowMs: 1_000,
      spotPaise: 2_450_000,
      underlyingFeatures: mkFeatures({ ret30s: 0.007 }),
      atmOption: () => undefined,
    }).highVolDay()).toBe(true);

    expect(provider({
      nowMs: 1_000,
      spotPaise: 2_450_000,
      underlyingFeatures: mkFeatures({ ret30s: 0, atr1mPaise: 20_000 }),
      atmOption: () => undefined,
    }).highVolDay()).toBe(true);
  });
});
