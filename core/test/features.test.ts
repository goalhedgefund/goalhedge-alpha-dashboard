import { describe, expect, it } from 'vitest';
import { makeInstrumentId } from '../src/domain/ids.js';
import type { Bar, OptionChainRow, Tick } from '../src/domain/marketdata.js';
import { BarBuilder } from '../src/feed/bar-builder.js';
import { scoreCodexSeries } from '../src/marketdata/features/codex-score.js';
import { computeOptionFeatures, computeUnderlyingFeatures } from '../src/marketdata/features/library.js';

const INSTR = makeInstrumentId('NSE', 'NIFTY');

function bars(prices: number[]): Bar[] {
  return prices.map((p, i) => ({
    instrumentId: INSTR,
    tf: '1m',
    startTs: i * 60_000,
    o: p,
    h: p + 10,
    l: p - 10,
    c: p,
    volume: 1000,
    tickCount: 10,
  }));
}

function tick(price: number, ts: number, qty = 10): Tick {
  return {
    instrumentId: INSTR,
    ts,
    recvTs: ts,
    ltpPaise: price,
    qty,
    volume: qty,
    bidPaise: price - 5,
    askPaise: price + 5,
    bidQty: 100,
    askQty: 80,
  };
}

describe('ADX trend-strength feature', () => {
  it('stays undefined until 2×period+1 bars have built', () => {
    const flat = bars(Array.from({ length: 20 }, () => 10_000));
    const features = computeUnderlyingFeatures([tick(10_000, 60_000)], flat);
    expect(features.adx1m).toBeUndefined();
  });

  it('reads near zero on a flat range and high on a persistent trend', () => {
    const flat = bars(Array.from({ length: 40 }, () => 10_000));
    const flatAdx = computeUnderlyingFeatures([tick(10_000, 60_000)], flat).adx1m;
    expect(flatAdx).toBeDefined();
    expect(flatAdx!).toBeLessThan(18);

    const trending = bars(Array.from({ length: 40 }, (_, i) => 10_000 + i * 40));
    const trendAdx = computeUnderlyingFeatures([tick(11_600, 60_000)], trending).adx1m;
    expect(trendAdx).toBeDefined();
    expect(trendAdx!).toBeGreaterThan(18);
  });
});

describe('CODEX 8-indicator score feature', () => {
  it('returns WAIT with short history', () => {
    const score = scoreCodexSeries(bars([1, 2, 3]));
    expect(score.signal).toBe('WAIT');
    expect(score.bull).toBe(0);
    expect(score.bear).toBe(0);
  });

  it('scores a smooth uptrend as bullish when threshold is permissive', () => {
    const series = bars(Array.from({ length: 60 }, (_, i) => 10_000 + i * 20));
    const score = scoreCodexSeries(series, undefined, { minScore: 3 });
    expect(score.bull).toBeGreaterThan(score.bear);
    expect(score.signal).toBe('LONG');
    expect(score.trend).toBe('up');
  });

  it('scores a smooth downtrend as bearish when threshold is permissive', () => {
    const series = bars(Array.from({ length: 60 }, (_, i) => 12_000 - i * 20));
    const score = scoreCodexSeries(series, undefined, { minScore: 3 });
    expect(score.bear).toBeGreaterThan(score.bull);
    expect(score.signal).toBe('SHORT');
    expect(score.trend).toBe('down');
  });
});

describe('feature library', () => {
  it('computes underlying returns, vwap, tick velocity and codex score', () => {
    const ticks = [
      tick(10_000, 0, 10),
      tick(10_100, 1_000, 20),
      tick(10_500, 5_000, 30),
      tick(11_000, 30_000, 40),
    ];
    const f = computeUnderlyingFeatures(ticks, bars(Array.from({ length: 40 }, (_, i) => 10_000 + i)));
    expect(f.ret1s).toBeCloseTo((11_000 - 10_500) / 10_500, 6);
    expect(f.ret5s).toBeCloseTo((11_000 - 10_500) / 10_500, 6);
    expect(f.ret30s).toBeCloseTo(0.1, 6);
    expect(f.vwapPaise).toBeCloseTo((10_000 * 10 + 10_100 * 20 + 10_500 * 30 + 11_000 * 40) / 100, 6);
    expect(f.tickVelocityPerSec).toBeGreaterThan(0);
    expect(f.codexScore.indicators.last).toBeGreaterThan(0);
  });

  it('computes option spread, imbalance, velocity and ATM drift', () => {
    const row: OptionChainRow = {
      instrumentId: INSTR,
      strikePaise: 29_300_00,
      right: 'CE',
      expiry: '2026-07-07',
      ltpPaise: 12_500,
      bidPaise: 12_490,
      askPaise: 12_510,
      bidQty: 150,
      askQty: 50,
      volume: 1000,
      oi: 50_000,
      iv: 0.2,
      delta: 0.5,
      gamma: 0.001,
      theta: -10,
      vega: 20,
      updatedTs: 2_000,
    };
    const f = computeOptionFeatures(row, [tick(12_000, 0), tick(12_500, 2_000)], 29_250_00);
    expect(f.spreadPaise).toBe(20);
    expect(f.spreadPct).toBeCloseTo(20 / 12_500, 6);
    expect(f.bidAskImbalance).toBe(0.5);
    expect(f.premiumVelocityPaisePerSec).toBe(250);
    expect(f.atmDriftPaise).toBe(5_000);
    expect(f.iv).toBe(0.2);
  });
});

describe('BarBuilder late tick policy', () => {
  it('late ticks update high/low/volume but do not move close backwards', () => {
    const emitted: Bar[] = [];
    const builder = new BarBuilder(INSTR, (bar) => emitted.push(bar));
    builder.onTick(tick(100, 1_000, 10));
    builder.onTick(tick(120, 1_500, 10));
    builder.onTick(tick(90, 1_200, 10));
    builder.flush();

    const oneSec = emitted.find((b) => b.tf === '1s');
    expect(oneSec?.h).toBe(120);
    expect(oneSec?.l).toBe(90);
    expect(oneSec?.c).toBe(120);
    expect(oneSec?.volume).toBe(30);
  });
});
