import type { Bar } from '../../domain/marketdata.js';

export interface CodexThresholds {
  rsiBullLo: number;
  rsiBullHi: number;
  rsiBearLo: number;
  rsiBearHi: number;
  stochBullLo: number;
  stochBullHi: number;
  stochBearLo: number;
  stochBearHi: number;
  cciBullMin: number;
  cciBearMax: number;
  willrBullMin: number;
  willrBearMax: number;
  bbBullLo: number;
  bbBullHi: number;
  bbBearLo: number;
  bbBearHi: number;
  adxMin: number;
  minScore: number;
}

export interface CodexScoreConfig {
  thresholds?: Partial<CodexThresholds>;
  minScore?: number;
  rsiPeriod?: number;
  stochPeriod?: number;
  cciPeriod?: number;
  bbPeriod?: number;
  atrPeriod?: number;
}

export interface CodexScore {
  bull: number;
  bear: number;
  signal: 'LONG' | 'SHORT' | 'WAIT';
  trend: 'up' | 'down' | 'flat';
  indicators: {
    rsi?: number;
    stoch?: number;
    cci?: number;
    macd?: number;
    bbPct?: number;
    ema9?: number;
    ema21?: number;
    adx?: number;
    last: number;
  };
}

export const DEFAULT_CODEX_THRESHOLDS: CodexThresholds = {
  rsiBullLo: 52,
  rsiBullHi: 70,
  rsiBearLo: 30,
  rsiBearHi: 48,
  stochBullLo: 55,
  stochBullHi: 85,
  stochBearLo: 15,
  stochBearHi: 45,
  cciBullMin: 50,
  cciBearMax: -50,
  willrBullMin: -45,
  willrBearMax: -55,
  bbBullLo: 0.5,
  bbBullHi: 0.9,
  bbBearLo: 0.1,
  bbBearHi: 0.5,
  adxMin: 22,
  minScore: 6,
};

function ema(arr: number[], p: number): number | null {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let e = arr[0] as number;
  for (let i = 1; i < arr.length; i++) e = (arr[i] as number) * k + e * (1 - k);
  return e;
}

function calcRSI(a: number[], p = 14): number {
  if (a.length < p + 1) return 50;
  let g = 0;
  let l = 0;
  for (let i = a.length - p; i < a.length; i++) {
    const d = (a[i] as number) - (a[i - 1] as number);
    if (d > 0) g += d;
    else l += Math.abs(d);
  }
  return 100 - 100 / (1 + g / (l || 1e-9));
}

function calcStoch(a: number[], p = 14): number {
  if (a.length < p) return 50;
  const s = a.slice(-p);
  const lo = Math.min(...s);
  const hi = Math.max(...s);
  return hi === lo ? 50 : (((a[a.length - 1] as number) - lo) / (hi - lo)) * 100;
}

function calcCCI(a: number[], p = 20): number {
  if (a.length < p) return 0;
  const s = a.slice(-p);
  const m = s.reduce((x, y) => x + y, 0) / p;
  const md = s.reduce((x, y) => x + Math.abs(y - m), 0) / p;
  return md === 0 ? 0 : ((a[a.length - 1] as number) - m) / (0.015 * md);
}

function calcMACD(a: number[]): number {
  if (a.length < 26) return 0;
  return (ema(a, 12) || 0) - (ema(a, 26) || 0);
}

function calcBB(a: number[], p = 20): { pct: number } {
  if (a.length < p) return { pct: 0.5 };
  const s = a.slice(-p);
  const m = s.reduce((x, y) => x + y, 0) / p;
  const sd = Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / p);
  const u = m + 2 * sd;
  const l = m - 2 * sd;
  return { pct: u === l ? 0.5 : ((a[a.length - 1] as number) - l) / (u - l) };
}

function calcATR(a: number[], p = 14): number {
  if (a.length < p + 1) return (a[a.length - 1] as number) * 0.005;
  let s = 0;
  for (let i = a.length - p; i < a.length; i++) s += Math.abs((a[i] as number) - (a[i - 1] as number));
  return s / p;
}

function calcADX(a: number[], p = 14): number {
  const atr = calcATR(a, p);
  const range = a.length > p ? Math.abs((a[a.length - 1] as number) - (a[a.length - 1 - p] as number)) : 0;
  return Math.min(60, Math.max(10, (range / (atr * p || 1e-9)) * 30));
}

export function scoreCodexSeries(candles: Array<Bar | { close?: number; c?: number; ltp?: number }> = [], livePrice?: number, config: CodexScoreConfig = {}): CodexScore {
  const closes = candles
    .map((c) => Number(('close' in c ? c.close : undefined) ?? ('c' in c ? c.c : undefined) ?? ('ltp' in c ? c.ltp : undefined) ?? 0))
    .filter(Number.isFinite);
  if (closes.length < 30) {
    return {
      bull: 0,
      bear: 0,
      signal: 'WAIT',
      trend: 'flat',
      indicators: { last: closes[closes.length - 1] ?? livePrice ?? 0 },
    };
  }

  const thr: CodexThresholds = {
    ...DEFAULT_CODEX_THRESHOLDS,
    ...(config.thresholds ?? {}),
    minScore: config.minScore ?? DEFAULT_CODEX_THRESHOLDS.minScore,
  };
  const rsi = calcRSI(closes, config.rsiPeriod || 14);
  const stoch = calcStoch(closes, config.stochPeriod || 14);
  const cci = calcCCI(closes, config.cciPeriod || 20);
  const macd = calcMACD(closes);
  const bb = calcBB(closes, config.bbPeriod || 20).pct;
  const e9 = ema(closes, 9) ?? (closes[closes.length - 1] as number);
  const e21 = ema(closes, 21) ?? (closes[closes.length - 1] as number);
  const willr = stoch - 100;
  const adx = calcADX(closes, config.atrPeriod || 14);

  let bull = 0;
  let bear = 0;
  if (rsi > thr.rsiBullLo && rsi < thr.rsiBullHi) bull++;
  if (macd > 0) bull++;
  if (stoch > thr.stochBullLo && stoch < thr.stochBullHi) bull++;
  if (cci > thr.cciBullMin) bull++;
  if (willr > thr.willrBullMin) bull++;
  if (e9 > e21) bull++;
  if (bb > thr.bbBullLo && bb < thr.bbBullHi) bull++;
  if (adx > thr.adxMin) bull++;
  if (rsi < thr.rsiBearHi && rsi > thr.rsiBearLo) bear++;
  if (macd < 0) bear++;
  if (stoch < thr.stochBearHi && stoch > thr.stochBearLo) bear++;
  if (cci < thr.cciBearMax) bear++;
  if (willr < thr.willrBearMax) bear++;
  if (e9 < e21) bear++;
  if (bb < thr.bbBearHi && bb > thr.bbBearLo) bear++;
  if (adx > thr.adxMin) bear++;

  const signal = bull >= thr.minScore && bull > bear ? 'LONG' : bear >= thr.minScore && bear > bull ? 'SHORT' : 'WAIT';
  return {
    bull,
    bear,
    signal,
    trend: signal === 'LONG' ? 'up' : signal === 'SHORT' ? 'down' : 'flat',
    indicators: { rsi, stoch, cci, macd, bbPct: bb, ema9: e9, ema21: e21, adx, last: closes[closes.length - 1] as number },
  };
}
