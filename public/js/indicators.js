// ── CLAUDE Scalping — Indicators ──────────────────────────────────────
'use strict';

const Indicators = (() => {
  function ema(arr, p) {
    if (arr.length < p) return null;
    const k = 2 / (p + 1);
    let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  }

  function sma(arr, p) {
    if (arr.length < p) return null;
    return arr.slice(-p).reduce((a, b) => a + b, 0) / p;
  }

  function calcRSI(arr, p = 14) {
    if (arr.length < p + 1) return 50;
    let g = 0, l = 0;
    for (let i = arr.length - p; i < arr.length; i++) {
      const d = arr[i] - arr[i - 1];
      d > 0 ? g += d : l += Math.abs(d);
    }
    const rs = g / (l || 1e-9);
    return 100 - 100 / (1 + rs);
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
    if (arr.length < 26) return { line: 0, signal: 0, hist: 0 };
    const line = (ema(arr, 12) || 0) - (ema(arr, 26) || 0);
    // Signal: 9-period EMA of MACD line (approximate with last value)
    return { line, signal: line * 0.85, hist: line * 0.15 };
  }

  function calcBB(arr, p = 20) {
    if (arr.length < p) {
      const v = arr[arr.length - 1];
      return { pct: 0.5, upper: v * 1.01, lower: v * 0.99, mid: v };
    }
    const sl = arr.slice(-p), m = sl.reduce((a, b) => a + b, 0) / p;
    const std = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / p);
    const upper = m + 2 * std, lower = m - 2 * std;
    const cur = arr[arr.length - 1];
    return { pct: upper === lower ? 0.5 : (cur - lower) / (upper - lower), upper, lower, mid: m, std };
  }

  function calcADX(arr, p = 14) {
    // Simplified ADX from ATR magnitude
    const atr = calcATR(arr, p);
    const range = arr.length > 1 ? Math.abs(arr[arr.length - 1] - arr[arr.length - p - 1]) : 0;
    return Math.min(60, Math.max(10, range / (atr * p) * 30));
  }

  function calcMFI(prices, period = 14) {
    // Simplified: uses price momentum as proxy for money flow
    if (prices.length < period + 1) return 50;
    const slice = prices.slice(-period - 1);
    let posFlow = 0, negFlow = 0;
    for (let i = 1; i < slice.length; i++) {
      const d = slice[i] - slice[i - 1];
      const flow = slice[i] * 1000;
      d >= 0 ? posFlow += flow : negFlow += Math.abs(flow);
    }
    const mfr = posFlow / (negFlow || 1e-9);
    return 100 - 100 / (1 + mfr);
  }

  function calcWilliamsR(arr, p = 14) {
    const stoch = calcStoch(arr, p);
    return stoch - 100;
  }

  function calcMomentum(arr, p = 10) {
    if (arr.length < p + 1) return 0;
    return arr[arr.length - 1] - arr[arr.length - 1 - p];
  }

  function calcVWAP(prices, vwapState) {
    const price = prices[prices.length - 1];
    vwapState.sum   += price * 1000;
    vwapState.vol   += 1000;
    vwapState.price  = vwapState.sum / vwapState.vol;
    return price - vwapState.price;
  }

  // ── Signal scoring (8 primary indicators → 0-8 score) ─────────────
  function scoreBull(rsi, macd, stoch, cci, willr, e9, e21, bbPct, adx) {
    let s = 0;
    if (rsi > 52 && rsi < 70) s++;
    if (macd > 0) s++;
    if (stoch > 55 && stoch < 85) s++;
    if (cci > 50) s++;
    if (willr > -45) s++;
    if (e9 && e21 && e9 > e21) s++;
    if (bbPct > 0.5 && bbPct < 0.9) s++;
    if (adx > 22) s++;
    return s;
  }

  function scoreBear(rsi, macd, stoch, cci, willr, e9, e21, bbPct, adx) {
    let s = 0;
    if (rsi < 48 && rsi > 30) s++;
    if (macd < 0) s++;
    if (stoch < 45 && stoch > 15) s++;
    if (cci < -50) s++;
    if (willr < -55) s++;
    if (e9 && e21 && e9 < e21) s++;
    if (bbPct < 0.5 && bbPct > 0.1) s++;
    if (adx > 22) s++;
    return s;
  }

  // ── Full indicator snapshot ────────────────────────────────────────
  function snapshot(prices) {
    if (prices.length < 2) return null;
    const rsi   = calcRSI(prices);
    const atr   = calcATR(prices);
    const stoch = calcStoch(prices);
    const cci   = calcCCI(prices);
    const macdO = calcMACD(prices);
    const bb    = calcBB(prices);
    const e9    = ema(prices, 9)  || prices[prices.length - 1];
    const e21   = ema(prices, 21) || prices[prices.length - 1];
    const willr = calcWilliamsR(prices);
    const adx   = calcADX(prices);
    const mfi   = calcMFI(prices);
    const mom   = calcMomentum(prices);
    const bull  = scoreBull(rsi, macdO.line, stoch, cci, willr, e9, e21, bb.pct, adx);
    const bear  = scoreBear(rsi, macdO.line, stoch, cci, willr, e9, e21, bb.pct, adx);
    return { rsi, atr, stoch, cci, macd: macdO.line, bb, e9, e21, willr, adx, mfi, mom, bull, bear };
  }

  return { ema, sma, calcRSI, calcATR, calcStoch, calcCCI, calcMACD, calcBB,
           calcADX, calcMFI, calcWilliamsR, calcMomentum, calcVWAP,
           scoreBull, scoreBear, snapshot };
})();
