'use strict';
/**
 * optimizer.js — multi-stage, validation-aware, cost-aware strategy optimizer.
 *
 * Public entry point is unchanged:   optimize(closes, targetRR, opts)
 * Returns rich metadata:             { best, leaderboard, searched, qualified,
 *                                       stages, validation, costConfig }
 *
 * ───────────────────────────── design in brief ─────────────────────────────
 * The old optimizer brute-forced a grid and kept the single highest in-sample
 * score. That maximises exactly the thing you don't want to maximise: the
 * luckiest fit to the past. This version instead does:
 *
 *   STAGE 1  Coarse exploration   — wide, deterministic grid; cheap in-sample
 *                                   objective to find promising regions.
 *   STAGE 2  Local refinement     — fine grid around the top-N coarse hits.
 *   STAGE 3  Robustness gauntlet   — the top finalists are put through
 *                                   out-of-sample (walk-forward k-fold)
 *                                   evaluation, parameter-plateau stability,
 *                                   a bootstrap lower bound on the edge, and a
 *                                   Deflated-Sharpe multiple-testing haircut.
 *                                   The leaderboard is ranked by this robust
 *                                   score, NOT by the raw peak score.
 *
 * Cost-awareness: when costEnabled, every objective is computed on NET returns
 * (after the exchange charge from economics.js), so a config that only looks
 * good before costs cannot win.
 */

const M = require('./metrics');
const Econ = require('./economics');

// ════════════════════════════════════════════════════════════════════════════
//  SIMULATE ADAPTER  —  THE ONLY PLACE THAT KNOWS simulate()'s OUTPUT SHAPE.
//  If your simulate.js returns different field names, change them HERE ONLY.
// ════════════════════════════════════════════════════════════════════════════
function getSimulator(opts) {
  if (typeof opts.simulate === 'function') return opts.simulate;
  // Default: your existing engine. Adjust the require path/export if needed.
  const mod = require('./simulate');
  return mod.simulate || mod;
}

/**
 * Run one config and normalise simulate()'s output into a canonical metrics
 * object the rest of this file relies on. Everything downstream uses ONLY the
 * canonical shape, so re-mapping field names is a one-function job.
 */
function evaluate(closes, config, ctx) {
  const raw = ctx.simulate(closes, config);
  const summary = raw && raw.summary ? raw.summary : raw || {};
  let trades = (raw && raw.trades) || summary.trades || [];

  // Attach economics if the engine hasn't (so ranking can be net-aware).
  if (trades.length && trades[0] && trades[0].netCashPnl == null) {
    trades = Econ.enrichTrades(trades, ctx.costConfig);
  }
  return canonical(summary, trades, ctx);
}

/** Build the canonical metrics object from a summary + trade list. */
function canonical(summary, trades, ctx) {
  const n = trades.length;
  // Per-trade return series used for all statistics. Preference order:
  //   net R-multiple → net cash → gross R → gross cash → raw pnl/rMultiple.
  const useNet = ctx.costConfig.enabled;
  const returns = trades.map((t) => pickReturn(t, useNet));

  const wins = returns.filter((r) => r > 0).length;
  const losses = returns.filter((r) => r < 0).length;
  const winRate = n ? wins / n : 0;

  const econ = Econ.summarizeEconomics(trades);
  const expectancyGross = n ? mean(trades.map((t) => t.grossCashPnl ?? rOf(t, false))) : 0;
  const expectancyNet = n ? mean(returns) : 0; // returns already net-or-gross per useNet

  return {
    config: summary.config || null,
    trades: n,
    wins, losses, winRate,
    returns,                                   // the series stats run on
    expectancy: expectancyNet,                 // per-trade, net when costs on
    expectancyGross,
    grossCashPnl: econ.grossCashPnl,
    netCashPnl: econ.netCashPnl,
    exchangeCost: econ.exchangeCost,
    turnover: econ.turnover,
    profitFactor: M.profitFactor(returns),
    maxDrawdown: M.maxDrawdown(returns),
    sharpe: M.sharpe(returns),
    tStat: M.tStat(returns),
    skew: M.skewness(returns),
    kurt: M.kurtosis(returns),
    wilsonWinLB: M.wilsonLowerBound(wins, n),
    tradeList: trades,
  };
}

function pickReturn(t, useNet) {
  if (useNet) {
    if (Number.isFinite(t.netR)) return t.netR;
    if (Number.isFinite(t.netCashPnl)) return t.netCashPnl;
  }
  return rOf(t, false);
}
function rOf(t, _gross) {
  if (Number.isFinite(t.grossR)) return t.grossR;
  if (Number.isFinite(t.grossCashPnl)) return t.grossCashPnl;
  if (Number.isFinite(t.rMultiple)) return t.rMultiple;
  if (Number.isFinite(t.pnl)) return t.pnl;
  return 0;
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

// ════════════════════════════════════════════════════════════════════════════
//  OBJECTIVE  —  risk/robustness-adjusted (net) expectancy in [scale of R].
// ════════════════════════════════════════════════════════════════════════════
/**
 * scoreObjective(metrics, targetRR, opts)
 *
 * Interpreted as a penalised expectancy: start from the (net) per-trade edge and
 * multiply by quality factors, each in (0,1], that encode the brief's rewards
 * and penalties:
 *
 *   reward   : expectancy, win rate (Wilson-shrunk), profit factor, sample size,
 *              statistical significance (t-stat), net P&L when costs are on.
 *   penalise : drawdown, thin post-cost margins, low-sample edge cases.
 *
 * Multiplicative form means any single catastrophic dimension (deep drawdown,
 * statistically-insignificant edge, tiny sample) collapses the score — which is
 * the behaviour we want when hunting for configs that generalise.
 */
function scoreObjective(m, targetRR, opts = {}) {
  if (m.trades === 0) return -Infinity;

  const ddCapR = opts.ddCapR ?? 8;            // drawdown cap in R
  const sampleK = opts.sampleK ?? 30;         // sample-size half-saturation
  const tMid = opts.tMid ?? 1.5;              // t-stat at which significance = 0.5

  const expectancy = m.expectancy;            // net per-trade when costs on
  if (expectancy <= 0) return expectancy;     // losers rank below all winners

  const sampleAdequacy = m.trades / (m.trades + sampleK);
  const winFactor = 0.5 + 0.5 * m.wilsonWinLB; // gentle tilt toward supported WR
  const pf = m.profitFactor;
  const pfFactor = pf > 1 ? (pf - 1) / pf : 0; // 2→.5, 3→.67, ∞→1
  const ddFactor = clamp(1 - m.maxDrawdown / ddCapR, 0.05, 1);
  const sig = 1 / (1 + Math.exp(-(m.tStat - tMid))); // logistic on t-stat

  // Thin-margin penalty: edge that only exists before costs is suspect.
  const thin = (opts.costEnabled && m.expectancyGross > 0 && expectancy <= 0) ? 0.1 : 1;

  const quality = sampleAdequacy * winFactor * pfFactor * ddFactor * sig * thin;
  return expectancy * quality;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ════════════════════════════════════════════════════════════════════════════
//  SEARCH SPACE
// ════════════════════════════════════════════════════════════════════════════
/**
 * Build the search space. Mirrors the current optimizer's knobs (SL/TP
 * multipliers, minScore, indicator period) and is fully overridable via
 * opts.space. TP is tied to targetRR by default but allowed to breathe so the
 * optimizer can discover that a slightly different R:R generalises better.
 */
function makeSpace(targetRR, opts = {}) {
  if (opts.space) return opts.space;
  const sl = opts.slGrid || [0.8, 1.0, 1.2, 1.5, 1.8, 2.2];
  // TP candidates as multiples of SL, centred on targetRR.
  const rrBand = opts.rrBand || [0.85, 1.0, 1.15];
  const minScore = opts.minScoreGrid || [5, 6, 7, 8];
  const period = opts.periodGrid || [14]; // single default; widen if engine supports it
  return {
    slMultiplier: sl,
    rrFactor: rrBand,          // tpMultiplier = slMultiplier * targetRR * rrFactor
    minScore,
    indicatorPeriod: period,
  };
}

function expandGrid(space) {
  const keys = Object.keys(space);
  let combos = [{}];
  for (const k of keys) {
    const next = [];
    for (const base of combos) for (const v of space[k]) next.push({ ...base, [k]: v });
    combos = next;
  }
  return combos;
}

/** Translate a search-space point into the config object simulate() expects. */
function toConfig(point, targetRR, opts) {
  const sl = point.slMultiplier;
  const tp = round2(sl * targetRR * (point.rrFactor ?? 1));
  const cfg = {
    slMultiplier: sl,
    tpMultiplier: tp,
    minScore: point.minScore,
    indicatorPeriod: point.indicatorPeriod,
    ...(opts.baseConfig || {}),
  };
  cfg._point = point; // keep the raw space point for neighbour generation
  return cfg;
}
function round2(x) { return Math.round(x * 100) / 100; }

// Neighbours of a point in the discrete space (one step on each axis).
function neighbours(point, space) {
  const out = [];
  for (const k of Object.keys(space)) {
    const vals = space[k];
    const idx = vals.indexOf(point[k]);
    for (const di of [-1, 1]) {
      const j = idx + di;
      if (j >= 0 && j < vals.length) out.push({ ...point, [k]: vals[j] });
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
//  WALK-FORWARD / K-FOLD OUT-OF-SAMPLE SLICING
// ════════════════════════════════════════════════════════════════════════════
/** Contiguous folds over the closes array (time-ordered, no shuffling). */
function makeFolds(len, k) {
  const folds = [];
  const size = Math.floor(len / k);
  if (size < 2) return [[0, len]];
  for (let i = 0; i < k; i++) {
    const start = i * size;
    const end = i === k - 1 ? len : start + size;
    folds.push([start, end]);
  }
  return folds;
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN ENTRY
// ════════════════════════════════════════════════════════════════════════════
function optimize(closes, targetRR, opts = {}) {
  const costConfig = Econ.makeCostConfig({
    enabled: opts.costEnabled ?? opts.tradingCostEnabled ?? false,
    mode: opts.costMode || opts.tradingMode || 'intraday',
  });
  const ctx = { simulate: getSimulator(opts), costConfig, targetRR, opts };

  const space = makeSpace(targetRR, opts);
  const minTrades = opts.minTrades ?? 20;
  const ddCapR = opts.ddCapR ?? 8;
  const minBootstrapLB = opts.minBootstrapLB ?? -0.2;
  const minOosHitRate = opts.minOosHitRate ?? 0.15;
  const minNetExpectancy = opts.minNetExpectancy ?? -0.05;
  const requirePositiveOosMedian = !!opts.requirePositiveOosMedian;
  const minOosMedian = opts.minOosMedian ?? -0.15;
  const topRefine = opts.topRefine ?? 12;
  const topFinalists = opts.topFinalists ?? 8;
  const folds = opts.folds ?? 6;
  const robustBlend = clamp(opts.robustBlend ?? 0.35, 0, 1);
  const minScoreFloor = opts.minScoreFloor ?? 0.01;
  const inSampleWeight = clamp(opts.inSampleWeight ?? 0.65, 0, 1);

  const scoreOpts = { ...opts, costEnabled: costConfig.enabled, ddCapR };
  const seen = new Map(); // de-dup configs across stages by key
  const results = [];

  const runPoint = (point) => {
    const cfg = toConfig(point, targetRR, opts);
    const key = JSON.stringify({ s: cfg.slMultiplier, t: cfg.tpMultiplier, m: cfg.minScore, p: cfg.indicatorPeriod });
    if (seen.has(key)) return seen.get(key);
    const m = evaluate(closes, cfg, ctx);
    const score = scoreObjective(m, targetRR, scoreOpts);
    const rec = { point, config: cfg, metrics: m, inSampleScore: score };
    seen.set(key, rec);
    results.push(rec);
    return rec;
  };

  // ── STAGE 1 — coarse exploration ──────────────────────────────────────────
  const coarse = expandGrid(space).map(runPoint);
  const stage1Count = seen.size;

  // ── STAGE 2 — local refinement around the best coarse hits ────────────────
  const refineSeeds = [...coarse]
    .sort((a, b) => b.inSampleScore - a.inSampleScore)
    .slice(0, topRefine);
  for (const seed of refineSeeds) {
    const fine = refineAround(seed.point, space);
    for (const sp of fine) {
      const p = {};
      for (const k of Object.keys(space)) p[k] = sp[k] ?? seed.point[k];
      runPoint(p);
    }
  }
  const stage2Count = seen.size - stage1Count;

  // ── STAGE 3 — robustness gauntlet on the finalists ────────────────────────
  const finalists = [...results]
    .filter((r) => isFinite(r.inSampleScore))
    .sort((a, b) => b.inSampleScore - a.inSampleScore)
    .slice(0, topFinalists);

  const foldRanges = makeFolds(closes.length, folds);

  // Trial-Sharpe dispersion across ALL searched configs feeds the DSR haircut.
  const allSharpes = results.map((r) => r.metrics.sharpe).filter(Number.isFinite);
  const sdTrials = M.std(allSharpes);
  const nTrials = seen.size;

  // Per-finalist per-fold score matrix (also reused for the PBO computation).
  const scoreMatrix = [];

  const evaluated = finalists.map((r) => {
    const oosScores = [];
    const blockScores = [];
    for (const [a, b] of foldRanges) {
      const slice = closes.slice(a, b);
      const fm = evaluate(slice, r.config, ctx);
      const s = scoreObjective(fm, targetRR, scoreOpts);
      oosScores.push(s);
      blockScores.push(isFinite(s) ? s : 0);
    }
    scoreMatrix.push(blockScores);

    // Stability: do nearby parameter variants also score well? (plateau vs spike)
    const nb = neighbours(r.point, space).map((p) => runPoint(p).inSampleScore)
      .filter(Number.isFinite);
    const stability = stabilityFrom(r.inSampleScore, nb);

    // Bootstrap lower bound on the (net) per-trade edge.
    const bootstrapLB = M.bootstrapMeanLB(r.metrics.returns, { seed: 20240517 });

    // Deflated Sharpe: probability the edge survives the multiple-testing haircut.
    const deflationProb = M.deflatedSharpe({
      sharpe: r.metrics.sharpe, nObs: r.metrics.trades, nTrials,
      sdOfTrialSharpes: sdTrials, skew: r.metrics.skew, kurt: r.metrics.kurt,
    });

    const oosMedian = M.median(oosScores.filter(Number.isFinite));
    const oosMin = Math.min(...oosScores.filter(Number.isFinite).concat([Infinity]));
    const oosHitRate = oosScores.filter((s) => isFinite(s) && s > 0).length /
      Math.max(1, oosScores.length);

    // Hard gates → qualification. These are intentionally softer than the
    // research-grade defaults so real-world samples are not rejected en masse.
    const reject = [];
    if (r.metrics.trades < minTrades) reject.push(`samples<${minTrades}`);
    if (r.metrics.maxDrawdown > ddCapR) reject.push(`drawdown>${ddCapR}R`);
    if (bootstrapLB < minBootstrapLB) reject.push(`bootstrapLB<${minBootstrapLB}`);
    if (oosHitRate < minOosHitRate) reject.push(`oosHitRate<${minOosHitRate}`);
    if (requirePositiveOosMedian && oosMedian < minOosMedian) reject.push(`oosMedian<${minOosMedian}`);
    if (costConfig.enabled && r.metrics.expectancy < minNetExpectancy) reject.push(`netExpectancy<${minNetExpectancy}`);
    const qualified = reject.length === 0;

    // Final robust score: blend IS and OOS evidence, then scale by stability
    // and overfitting diagnostics. We keep the score positive enough to rank
    // noisy real-world samples instead of flattening them to zero.
    const blendedEdge = (inSampleWeight * r.inSampleScore) +
      ((1 - inSampleWeight) * oosMedian);
    const blendedBase = Math.max(-0.25, blendedEdge);
    const quality = stability.plateauFactor *
      clamp(oosHitRate, 0, 1) *
      clamp(deflationProb, 0, 1) *
      clamp((bootstrapLB - minBootstrapLB + 0.2) / 0.4, 0.1, 1);
    const momentum = 0.25 * Math.max(0, r.inSampleScore) + 0.15 * Math.max(0, oosMedian);
    const penalty = Math.max(0.15, 1 - Math.abs(oosMedian) * 0.25);
    const robustScore = Math.max(minScoreFloor, (Math.max(0, blendedBase) + momentum)) *
      quality *
      penalty;
    const displayScore = uiScore(robustScore);

    return {
      config: stripInternal(r.config),
      inSample: snapshot(r.metrics, r.inSampleScore),
      oos: { median: oosMedian, min: isFinite(oosMin) ? oosMin : null, hitRate: oosHitRate, scores: oosScores },
      stability,
      bootstrapLB,
      deflationProb,
      robustScore,
      displayScore,
      displayScoreText: `${displayScore.toFixed(2)} pts`,
      qualified,
      rejectReasons: reject,
    };
  });

  // ── ranking: robust score first; qualified always above unqualified ───────
  evaluated.sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    return b.robustScore - a.robustScore;
  });

  // PBO across the finalist set (selection-process overfitting risk).
  const pbo = M.probabilityOfBacktestOverfitting(scoreMatrix);

  const qualifiedCount = evaluated.filter((e) => e.qualified).length;
  const best = evaluated[0] || null;
  const relaxedBest = best || results[0] || null;

  return {
    best: relaxedBest ? {
      ...relaxedBest,
      relaxed: !relaxedBest.qualified
    } : null,
    leaderboard: evaluated,
    searched: seen.size,
    qualified: qualifiedCount,
    stages: { coarse: stage1Count, refine: stage2Count, validated: finalists.length },
    validation: {
      method: 'walk-forward k-fold + plateau stability + bootstrap LB + Deflated Sharpe',
      folds,
      pbo: pbo.pbo,
      pboNote: pbo.note || null,
      trials: nTrials,
      trialSharpeDispersion: sdTrials,
      costEnabled: costConfig.enabled,
      relaxedThresholds: {
        minBootstrapLB,
        minOosHitRate,
        minOosMedian,
        minNetExpectancy
      }
    },
    costConfig,
  };
}

// ───────────────────────────── small helpers ───────────────────────────────
function refineAround(point, space) {
  // Insert midpoints between the seed value and its neighbours on each axis.
  const out = [{ ...point }];
  for (const k of Object.keys(space)) {
    const vals = space[k];
    const idx = vals.indexOf(point[k]);
    for (const di of [-1, 1]) {
      const j = idx + di;
      if (j >= 0 && j < vals.length && typeof vals[j] === 'number' && typeof point[k] === 'number') {
        out.push({ ...point, [k]: round2((point[k] + vals[j]) / 2) });
      }
    }
  }
  return out;
}

function stabilityFrom(selfScore, neighbourScores) {
  if (!neighbourScores.length) return { cv: null, plateauFactor: 0.5, neighbourMin: null };
  const mu = M.mean(neighbourScores);
  const sd = M.std(neighbourScores);
  const cv = mu !== 0 ? Math.abs(sd / mu) : (sd === 0 ? 0 : 1);
  const neighbourMin = Math.min(...neighbourScores);
  // Plateau if neighbours are both consistent (low CV) and not far below self.
  const consistency = clamp(1 - cv, 0.05, 1);
  const support = selfScore > 0 ? clamp(neighbourMin / selfScore, 0, 1) : 0.05;
  return { cv, plateauFactor: clamp(0.5 * consistency + 0.5 * support, 0.05, 1), neighbourMin };
}

function snapshot(m, score) {
  const displayScore = uiScore(score);
  return {
    score,
    displayScore,
    displayScoreText: `${displayScore.toFixed(2)} pts`,
    trades: m.trades,
    winRate: m.winRate,
    wilsonWinLB: m.wilsonWinLB,
    expectancy: m.expectancy,
    expectancyGross: m.expectancyGross,
    profitFactor: m.profitFactor,
    maxDrawdown: m.maxDrawdown,
    sharpe: m.sharpe,
    tStat: m.tStat,
    grossCashPnl: m.grossCashPnl,
    netCashPnl: m.netCashPnl,
    exchangeCost: m.exchangeCost,
    turnover: m.turnover,
  };
}

function stripInternal(cfg) { const { _point, ...rest } = cfg; return rest; }

function clamp2(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); } // (kept for clarity)
function uiScore(score, scale = 100000) {
  if (!Number.isFinite(score)) return 0;
  const abs = Math.abs(score);
  const effectiveScale = abs >= 1 ? 1 : abs >= 0.01 ? 100 : 1000000;
  return Number((score * effectiveScale).toFixed(2));
}

module.exports = { optimize, scoreObjective, makeSpace };
