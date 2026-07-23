import type { Bar, OptionChainRow, Tick } from '../../domain/marketdata.js';
import { scoreCodexSeries, type CodexScore, type CodexScoreConfig } from './codex-score.js';

export interface UnderlyingFeatures {
  ret1s: number | undefined;
  ret5s: number | undefined;
  ret30s: number | undefined;
  vwapPaise: number | undefined;
  atr1mPaise: number | undefined;
  /** Wilder ADX-14 on 1m bars; undefined until ~2×period+1 bars have built. */
  adx1m?: number;
  tickVelocityPerSec: number;
  volumeBurstRatio: number | undefined;
  codexScore: CodexScore;
}

export interface OptionFeatures {
  premiumVelocityPaisePerSec: number | undefined;
  bidAskImbalance: number | undefined;
  spreadPaise: number;
  spreadPct: number;
  spreadStable: boolean;
  iv: number | undefined;
  delta: number | undefined;
  gamma: number | undefined;
  theta: number | undefined;
  vega: number | undefined;
  atmDriftPaise: number | undefined;
}

function priceAtOrBefore(ticks: Tick[], targetTs: number): Tick | undefined {
  for (let i = ticks.length - 1; i >= 0; i--) {
    const tick = ticks[i];
    if (tick !== undefined && tick.ts <= targetTs) return tick;
  }
  return undefined;
}

function retFrom(ticks: Tick[], seconds: number): number | undefined {
  const last = ticks[ticks.length - 1];
  if (last === undefined) return undefined;
  const prev = priceAtOrBefore(ticks, last.ts - seconds * 1000);
  if (prev === undefined || prev.ltpPaise <= 0) return undefined;
  return (last.ltpPaise - prev.ltpPaise) / prev.ltpPaise;
}

function atrFromBars(bars: Bar[], period = 14): number | undefined {
  if (bars.length < period + 1) return undefined;
  const sample = bars.slice(-period);
  return sample.reduce((s, b) => s + (b.h - b.l), 0) / period;
}

/**
 * Wilder ADX. Needs 2×period+1 bars for the first smoothed value; returns
 * undefined until then. Used by the OP(-) range gate (trend strength must be
 * LOW to sell premium), so a warm-up undefined must read as "not range-bound
 * yet", never as zero trend.
 */
function adxFromBars(bars: Bar[], period = 14): number | undefined {
  if (bars.length < 2 * period + 1) return undefined;
  const trs: number[] = [];
  const plusDms: number[] = [];
  const minusDms: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
    const up = cur.h - prev.h;
    const down = prev.l - cur.l;
    plusDms.push(up > down && up > 0 ? up : 0);
    minusDms.push(down > up && down > 0 ? down : 0);
  }
  const sum = (xs: number[], from: number, len: number): number => {
    let s = 0;
    for (let i = from; i < from + len; i++) s += xs[i]!;
    return s;
  };
  let smTr = sum(trs, 0, period);
  let smPlus = sum(plusDms, 0, period);
  let smMinus = sum(minusDms, 0, period);
  const dxs: number[] = [];
  for (let i = period; i < trs.length; i++) {
    smTr = smTr - smTr / period + trs[i]!;
    smPlus = smPlus - smPlus / period + plusDms[i]!;
    smMinus = smMinus - smMinus / period + minusDms[i]!;
    if (smTr <= 0) {
      dxs.push(0);
      continue;
    }
    const plusDi = (100 * smPlus) / smTr;
    const minusDi = (100 * smMinus) / smTr;
    const diSum = plusDi + minusDi;
    dxs.push(diSum > 0 ? (100 * Math.abs(plusDi - minusDi)) / diSum : 0);
  }
  if (dxs.length < period) return undefined;
  let adx = sum(dxs, 0, period) / period;
  for (let i = period; i < dxs.length; i++) adx = (adx * (period - 1) + dxs[i]!) / period;
  return adx;
}

export function computeUnderlyingFeatures(
  ticks: Tick[],
  bars1m: Bar[],
  codexConfig?: CodexScoreConfig,
): UnderlyingFeatures {
  const last = ticks[ticks.length - 1];
  const first = ticks[0];
  const durationSec = first !== undefined && last !== undefined ? Math.max(1, (last.ts - first.ts) / 1000) : 1;
  const turnover = ticks.reduce((s, t) => s + t.ltpPaise * t.qty, 0);
  const qty = ticks.reduce((s, t) => s + t.qty, 0);
  const recentQty = ticks.slice(-20).reduce((s, t) => s + t.qty, 0);
  const priorQty = ticks.slice(-40, -20).reduce((s, t) => s + t.qty, 0);

  const adx1m = adxFromBars(bars1m);
  return {
    ret1s: retFrom(ticks, 1),
    ret5s: retFrom(ticks, 5),
    ret30s: retFrom(ticks, 30),
    vwapPaise: qty > 0 ? turnover / qty : undefined,
    atr1mPaise: atrFromBars(bars1m),
    ...(adx1m !== undefined ? { adx1m } : {}),
    tickVelocityPerSec: ticks.length / durationSec,
    volumeBurstRatio: priorQty > 0 ? recentQty / priorQty : undefined,
    codexScore: scoreCodexSeries(bars1m, last?.ltpPaise, codexConfig),
  };
}

export function computeOptionFeatures(
  row: OptionChainRow,
  recentTicks: Tick[] = [],
  atmStrikePaise?: number,
  spreadStabilityWindow = 5,
): OptionFeatures {
  const spreadPaise = row.askPaise > 0 && row.bidPaise > 0 ? row.askPaise - row.bidPaise : 0;
  const mid = row.askPaise > 0 && row.bidPaise > 0 ? (row.askPaise + row.bidPaise) / 2 : row.ltpPaise;
  const last = recentTicks[recentTicks.length - 1];
  const first = recentTicks[0];
  const premiumVelocityPaisePerSec =
    first !== undefined && last !== undefined && last.ts > first.ts
      ? (last.ltpPaise - first.ltpPaise) / ((last.ts - first.ts) / 1000)
      : undefined;

  const recentSpreads = recentTicks.slice(-spreadStabilityWindow)
    .filter((t) => t.askPaise > 0 && t.bidPaise > 0)
    .map((t) => t.askPaise - t.bidPaise);
  const maxSpread = recentSpreads.length > 0 ? Math.max(...recentSpreads) : spreadPaise;
  const minSpread = recentSpreads.length > 0 ? Math.min(...recentSpreads) : spreadPaise;

  return {
    premiumVelocityPaisePerSec,
    bidAskImbalance: row.bidQty + row.askQty > 0 ? (row.bidQty - row.askQty) / (row.bidQty + row.askQty) : undefined,
    spreadPaise,
    spreadPct: mid > 0 ? spreadPaise / mid : 0,
    spreadStable: maxSpread - minSpread <= Math.max(5, spreadPaise),
    iv: row.iv,
    delta: row.delta,
    gamma: row.gamma,
    theta: row.theta,
    vega: row.vega,
    atmDriftPaise: atmStrikePaise !== undefined ? row.strikePaise - atmStrikePaise : undefined,
  };
}
