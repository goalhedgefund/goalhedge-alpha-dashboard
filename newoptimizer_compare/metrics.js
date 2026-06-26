'use strict';
/**
 * metrics.js — small, dependency-free statistical primitives used by the optimizer.
 *
 * These are deliberately textbook implementations of the techniques the quant
 * literature uses to fight backtest overfitting:
 *   - Wilson score interval        (small-sample win-rate shrinkage)
 *   - Stationary/IID bootstrap LB   (probabilistic floor on the edge)
 *   - Deflated Sharpe Ratio (DSR)   (Bailey & Lopez de Prado, 2014)
 *   - Probability of Backtest       (CSCV / Bailey, Borwein, Lopez de Prado, 2017)
 *     Overfitting (PBO)
 *
 * Everything here is pure and deterministic (the only randomness is a seeded
 * PRNG), so results are reproducible run-to-run.
 */

// ────────────────────────────── basic moments ──────────────────────────────
function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (n - 1); // sample variance
}

function std(xs) { return Math.sqrt(variance(xs)); }

function median(xs) {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function quantile(xs, q) {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, n) => p - n);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function skewness(xs) {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs), s = std(xs);
  if (s === 0) return 0;
  let acc = 0;
  for (const x of xs) acc += ((x - m) / s) ** 3;
  return acc / n;
}

// Returns regular (non-excess) kurtosis — DSR formula expects this convention.
function kurtosis(xs) {
  const n = xs.length;
  if (n < 4) return 3;
  const m = mean(xs), s = std(xs);
  if (s === 0) return 3;
  let acc = 0;
  for (const x of xs) acc += ((x - m) / s) ** 4;
  return acc / n;
}

// ───────────────────────── performance statistics ──────────────────────────
/** Per-observation Sharpe (mean / std of a return series). Not annualised —
 *  for ranking, a unit-free per-trade Sharpe is what we want. */
function sharpe(returns) {
  const s = std(returns);
  return s === 0 ? 0 : mean(returns) / s;
}

/** t-statistic of the mean return against zero — measures whether the edge is
 *  distinguishable from noise given the sample size. */
function tStat(returns) {
  const n = returns.length;
  if (n < 2) return 0;
  const s = std(returns);
  return s === 0 ? 0 : mean(returns) / (s / Math.sqrt(n));
}

/** Maximum drawdown of an equity curve built by cumulating per-trade returns.
 *  Returned as a positive magnitude in the same units as the returns. */
function maxDrawdown(returns) {
  let equity = 0, peak = 0, maxDD = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function profitFactor(returns) {
  let gain = 0, loss = 0;
  for (const r of returns) {
    if (r > 0) gain += r;
    else loss -= r;
  }
  if (loss === 0) return gain > 0 ? Infinity : 0;
  return gain / loss;
}

// ───────────────────── small-sample win-rate shrinkage ─────────────────────
/** Wilson score lower bound for a binomial proportion. With few trades this
 *  pulls an optimistic win rate down toward a defensible floor, which is
 *  exactly the "low sample-size edge case" penalty the brief asks for. */
function wilsonLowerBound(wins, n, z = 1.96) {
  if (n === 0) return 0;
  const phat = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

// ──────────────────────────── normal CDF / inverse ─────────────────────────
function erf(x) {
  // Abramowitz & Stegun 7.1.26 — max error ~1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
    0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function normalCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

function normalInv(p) {
  // Acklam's rational approximation for the inverse normal CDF.
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ─────────────────────────── seeded PRNG + bootstrap ───────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lower confidence bound on the MEAN of a return series via IID bootstrap.
 *  A robust edge keeps a positive lower bound after resampling; a fragile one
 *  (driven by a couple of lucky trades) does not. */
function bootstrapMeanLB(returns, { iters = 1000, alpha = 0.05, seed = 1337 } = {}) {
  const n = returns.length;
  if (n < 2) return mean(returns);
  const rnd = mulberry32(seed);
  const means = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += returns[(rnd() * n) | 0];
    means[it] = s / n;
  }
  return quantile(means, alpha);
}

// ─────────────────────────── Deflated Sharpe Ratio ─────────────────────────
const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Expected maximum Sharpe ratio under the null of nTrials independent strategies
 * with zero true Sharpe and trial-Sharpe dispersion sdOfTrialSharpes.
 * (Bailey & Lopez de Prado, "The Deflated Sharpe Ratio", 2014, eq. for SR*.)
 */
function expectedMaxSharpe(nTrials, sdOfTrialSharpes) {
  const N = Math.max(2, nTrials);
  const a = normalInv(1 - 1 / N);
  const b = normalInv(1 - 1 / (N * Math.E));
  return sdOfTrialSharpes * ((1 - EULER_MASCHERONI) * a + EULER_MASCHERONI * b);
}

/**
 * Deflated Sharpe Ratio: the probability that the observed Sharpe is "real"
 * once you account for (a) how many configs you tried, (b) the dispersion of
 * their Sharpes, and (c) non-normal (skewed/fat-tailed) returns.
 * Returns a probability in [0,1]; values near 1 mean the edge survives the
 * multiple-testing haircut.
 */
function deflatedSharpe({ sharpe: sr, nObs, nTrials, sdOfTrialSharpes, skew, kurt }) {
  const n = nObs;
  if (n < 4 || !isFinite(sr)) return 0;
  const sr0 = expectedMaxSharpe(nTrials, sdOfTrialSharpes || 0);
  const denom = Math.sqrt(Math.max(1e-9, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  const z = ((sr - sr0) * Math.sqrt(n - 1)) / denom;
  return normalCdf(z);
}

// ───────────────────── Probability of Backtest Overfitting ──────────────────
/**
 * PBO via Combinatorially-Symmetric Cross-Validation (CSCV).
 *
 * Input: scoreMatrix[c][b] = performance of config c on time-block b.
 * The method splits the S blocks into all C(S, S/2) in-sample / out-of-sample
 * partitions, picks the IS-best config in each, and measures how often that
 * config lands in the bottom half OOS. The fraction that does is the
 * probability of backtest overfitting.
 *
 * Returns { pbo, logits, evaluated }.
 */
function probabilityOfBacktestOverfitting(scoreMatrix) {
  const C = scoreMatrix.length;
  if (!C) return { pbo: 0, logits: [], evaluated: 0 };
  const S = scoreMatrix[0].length;
  if (S < 4 || S % 2 !== 0) {
    // CSCV needs an even number of blocks (>=4); skip gracefully otherwise.
    return { pbo: null, logits: [], evaluated: 0, note: 'need even S>=4' };
  }
  const blocks = [...Array(S).keys()];
  const combos = chooseHalf(blocks);
  const logits = [];
  for (const isSet of combos) {
    const isMask = new Set(isSet);
    const oosSet = blocks.filter((b) => !isMask.has(b));
    // In-sample mean score per config.
    let bestC = 0, bestIS = -Infinity;
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (const b of isSet) s += scoreMatrix[c][b];
      s /= isSet.length;
      if (s > bestIS) { bestIS = s; bestC = c; }
    }
    // OOS rank (relative) of the IS-best config.
    const oosScores = [];
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (const b of oosSet) s += scoreMatrix[c][b];
      oosScores.push(s / oosSet.length);
    }
    const sorted = [...oosScores].map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    let rank = 0;
    for (let i = 0; i < sorted.length; i++) if (sorted[i][1] === bestC) { rank = i; break; }
    const relRank = (rank + 1) / (C + 1);          // in (0,1)
    const w = Math.min(1 - 1e-9, Math.max(1e-9, relRank));
    logits.push(Math.log(w / (1 - w)));            // logit of relative OOS rank
  }
  const pbo = logits.filter((l) => l <= 0).length / logits.length;
  return { pbo, logits, evaluated: logits.length };
}

// All ways to choose S/2 of the S blocks (returns index arrays).
function chooseHalf(items) {
  const n = items.length, k = n / 2, out = [];
  const combo = (start, picked) => {
    if (picked.length === k) { out.push(picked.slice()); return; }
    for (let i = start; i < n; i++) { picked.push(items[i]); combo(i + 1, picked); picked.pop(); }
  };
  combo(0, []);
  return out;
}

module.exports = {
  mean, variance, std, median, quantile, skewness, kurtosis,
  sharpe, tStat, maxDrawdown, profitFactor, wilsonLowerBound,
  normalCdf, normalInv, mulberry32, bootstrapMeanLB,
  expectedMaxSharpe, deflatedSharpe, probabilityOfBacktestOverfitting,
};
