// ── CLAUDE Scalping — Shared Indicator Math (server-side) ────────────────────
'use strict';

function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

// Simple moving average — used for DMA (10/20/50/200-period) overlays.
function sma(arr, p) {
  if (arr.length < p) return null;
  let sum = 0;
  for (let i = arr.length - p; i < arr.length; i++) sum += arr[i];
  return sum / p;
}

// Precomputes SMA arrays for a set of periods across an entire close-price
// series in O(n) per period (rolling sum), for overlaying 10/20/50/200 DMA
// lines on a chart without recomputing the full window sum on every bar.
function computeDmaSeries(closes, periods = [10, 20, 50, 200]) {
  const n = closes.length;
  const out = {};
  for (const p of periods) {
    const arr = new Array(n).fill(null);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += closes[i];
      if (i >= p) sum -= closes[i - p];
      if (i >= p - 1) arr[i] = sum / p;
    }
    out['dma' + p] = arr;
  }
  return out;
}

function calcRSI(arr, p = 14) {
  if (arr.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = arr.length - p; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    d > 0 ? g += d : l += Math.abs(d);
  }
  return 100 - 100 / (1 + g / (l || 1e-9));
}

function calcATR(arr, p = 14) {
  if (arr.length < p + 1) return arr[arr.length - 1] * 0.005;
  let s = 0;
  for (let i = arr.length - p; i < arr.length; i++) s += Math.abs(arr[i] - arr[i - 1]);
  return s / p;
}

function calcStoch(arr, p = 14) {
  if (arr.length < p) return 50;
  const sl = arr.slice(-p), lo = Math.min(...sl), hi = Math.max(...sl);
  return hi === lo ? 50 : ((arr[arr.length - 1] - lo) / (hi - lo)) * 100;
}

function calcCCI(arr, p = 20) {
  if (arr.length < p) return 0;
  const sl = arr.slice(-p), m = sl.reduce((a, b) => a + b, 0) / p;
  const md = sl.reduce((a, b) => a + Math.abs(b - m), 0) / p;
  return md === 0 ? 0 : (arr[arr.length - 1] - m) / (0.015 * md);
}

function calcMACD(arr) {
  if (arr.length < 26) return 0;
  return (ema(arr, 12) || 0) - (ema(arr, 26) || 0);
}

function calcBB(arr, p = 20) {
  if (arr.length < p) return { pct: 0.5 };
  const sl = arr.slice(-p), m = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  const u = m + 2 * std, l = m - 2 * std;
  return { pct: u === l ? 0.5 : (arr[arr.length - 1] - l) / (u - l), u, l };
}

function calcADX(arr, p = 14) {
  const atr = calcATR(arr, p);
  const range = arr.length > p ? Math.abs(arr[arr.length - 1] - arr[arr.length - 1 - p]) : 0;
  return Math.min(60, Math.max(10, (range / (atr * p || 1e-9)) * 30));
}

// ── Parameterized indicator snapshot ──────────────────────────────────────────
// `params` lets the optimizer override default periods/thresholds per indicator
function snapshot(closes, params = {}) {
  const rsiPeriod   = params.rsiPeriod   || 14;
  const stochPeriod = params.stochPeriod || 14;
  const cciPeriod   = params.cciPeriod   || 20;
  const bbPeriod    = params.bbPeriod    || 20;
  const atrPeriod   = params.atrPeriod   || 14;

  const rsi   = calcRSI(closes, rsiPeriod);
  const atr   = calcATR(closes, atrPeriod);
  const stoch = calcStoch(closes, stochPeriod);
  const cci   = calcCCI(closes, cciPeriod);
  const macd  = calcMACD(closes);
  const bb    = calcBB(closes, bbPeriod);
  const e9    = ema(closes, 9)  || closes[closes.length - 1];
  const e21   = ema(closes, 21) || closes[closes.length - 1];
  const willr = stoch - 100;
  const adx   = calcADX(closes, atrPeriod);

  return { rsi, atr, stoch, cci, macd, bb, e9, e21, willr, adx };
}

// ── Parameterized scoring ──────────────────────────────────────────────────────
// `thr` = thresholds object the optimizer can vary
const DEFAULT_THRESHOLDS = {
  rsiBullLo: 52, rsiBullHi: 70, rsiBearLo: 30, rsiBearHi: 48,
  stochBullLo: 55, stochBullHi: 85, stochBearLo: 15, stochBearHi: 45,
  cciBullMin: 50, cciBearMax: -50,
  willrBullMin: -45, willrBearMax: -55,
  bbBullLo: 0.5, bbBullHi: 0.9, bbBearLo: 0.1, bbBearHi: 0.5,
  adxMin: 22,
  minScore: 6   // out of 8
};

function scoreBull(ind, thr) {
  let s = 0;
  if (ind.rsi > thr.rsiBullLo && ind.rsi < thr.rsiBullHi) s++;
  if (ind.macd > 0) s++;
  if (ind.stoch > thr.stochBullLo && ind.stoch < thr.stochBullHi) s++;
  if (ind.cci > thr.cciBullMin) s++;
  if (ind.willr > thr.willrBullMin) s++;
  if (ind.e9 > ind.e21) s++;
  if (ind.bb.pct > thr.bbBullLo && ind.bb.pct < thr.bbBullHi) s++;
  if (ind.adx > thr.adxMin) s++;
  return s;
}

function scoreBear(ind, thr) {
  let s = 0;
  if (ind.rsi < thr.rsiBearHi && ind.rsi > thr.rsiBearLo) s++;
  if (ind.macd < 0) s++;
  if (ind.stoch < thr.stochBearHi && ind.stoch > thr.stochBearLo) s++;
  if (ind.cci < thr.cciBearMax) s++;
  if (ind.willr < thr.willrBearMax) s++;
  if (ind.e9 < ind.e21) s++;
  if (ind.bb.pct < thr.bbBearHi && ind.bb.pct > thr.bbBearLo) s++;
  if (ind.adx > thr.adxMin) s++;
  return s;
}

module.exports = {
  ema, sma, computeDmaSeries, calcRSI, calcATR, calcStoch, calcCCI, calcMACD, calcBB, calcADX,
  snapshot, scoreBull, scoreBear, DEFAULT_THRESHOLDS
};
