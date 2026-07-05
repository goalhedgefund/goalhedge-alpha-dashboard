import type { Clock } from '../domain/time.js';
import { systemClock } from '../domain/time.js';
import type { MarketViewProvider, RegimeProvider } from './runner.js';
import type { RegimeTrend } from './eligibility.js';

export interface FeatureRegimeProviderOptions {
  view: MarketViewProvider;
  clock?: Clock;
  /**
   * Minimum absolute 30s return before a directional regime is trusted.
   * Decimal fraction: 0.0015 = 0.15%.
   */
  trendRet30Pct?: number;
  /**
   * Minimum spot-vs-VWAP stretch in the same direction as ret30s.
   * Decimal fraction: 0.0005 = 0.05%.
   */
  trendVwapPct?: number;
  /** High-volatility block from extreme 30s return. */
  highVolRet30Pct?: number;
  /** High-volatility block from 1m ATR as a fraction of spot. */
  highVolAtrPct?: number;
}

/**
 * Live feature-based regime filter. It intentionally does not use codexScore:
 * trend comes from short-horizon return agreeing with spot-vs-session-VWAP,
 * and the high-vol block comes from recent absolute movement/ATR.
 */
export class FeatureRegimeProvider implements RegimeProvider {
  private readonly clock: Clock;
  private readonly trendRet30Pct: number;
  private readonly trendVwapPct: number;
  private readonly highVolRet30Pct: number;
  private readonly highVolAtrPct: number;

  constructor(private readonly opts: FeatureRegimeProviderOptions) {
    this.clock = opts.clock ?? systemClock;
    this.trendRet30Pct = opts.trendRet30Pct ?? 0.0015;
    this.trendVwapPct = opts.trendVwapPct ?? 0.0005;
    this.highVolRet30Pct = opts.highVolRet30Pct ?? 0.006;
    this.highVolAtrPct = opts.highVolAtrPct ?? 0.006;
  }

  trend(): RegimeTrend {
    const view = this.opts.view.strategyView(this.clock.now());
    const f = view.underlyingFeatures;
    const spot = view.spotPaise;
    const vwap = f?.vwapPaise;
    const ret30 = f?.ret30s;
    if (spot === undefined || vwap === undefined || vwap <= 0 || ret30 === undefined) return 0;

    const stretch = (spot - vwap) / vwap;
    if (ret30 >= this.trendRet30Pct && stretch >= this.trendVwapPct) return 1;
    if (ret30 <= -this.trendRet30Pct && stretch <= -this.trendVwapPct) return -1;
    return 0;
  }

  highVolDay(): boolean {
    const view = this.opts.view.strategyView(this.clock.now());
    const f = view.underlyingFeatures;
    const spot = view.spotPaise;
    const ret30 = Math.abs(f?.ret30s ?? 0);
    const atrPct = spot !== undefined && spot > 0 && f?.atr1mPaise !== undefined
      ? f.atr1mPaise / spot
      : 0;
    return ret30 >= this.highVolRet30Pct || atrPct >= this.highVolAtrPct;
  }
}
