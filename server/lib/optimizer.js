// ── CLAUDE Scalping — Grid Search Optimizer ───────────────────────────────────
'use strict';

const { simulate } = require('./simulate');
const { DEFAULT_THRESHOLDS } = require('./indicators');

/**
 * Full grid search across:
 *   1. SL/TP multipliers (targeting a specific R:R ratio, e.g. 3.0)
 *   2. Indicator score threshold (minScore: 5,6,7,8 out of 8)
 *   3. Individual indicator parameter tweaks (RSI bands, ADX cutoff, CCI, Williams %R)
 *
 * Scoring function ranks candidates by a blended objective:
 *   - Win rate (must stay above a floor, since at fixed R:R, higher WR = pure upside)
 *   - Expectancy (R per trade) — primary driver of long-run profitability
 *   - Trade count (penalize configs that barely fire — overfit risk)
 *   - Max drawdown (penalize deep equity dips)
 *
 * @param {number[]} closes      - historical close prices for one symbol
 * @param {number}   targetRR    - desired reward:risk ratio, e.g. 3.0
 * @param {object}   opts        - { maxCombos, minTrades }
 * @returns {object} { best, leaderboard, searched }
 */
function optimize(closes, targetRR = 3.0, opts = {}) {
  const maxCombos  = opts.maxCombos  || 4000;
  const minTrades  = opts.minTrades  || 15;   // ignore configs that fire too rarely (overfit risk)
  const sim = typeof opts.simulate === 'function' ? opts.simulate : simulate;

  // ── 1. SL/TP multiplier grid (both achieving targetRR, searched jointly) ────
  const slCandidates = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4];
  const slTpPairs = slCandidates.map(sl => ({ sl, tp: +(sl * targetRR).toFixed(3) }));

  // ── 2. Score threshold grid ──────────────────────────────────────────────────
  const minScoreCandidates = [5, 6, 7];

  // ── 3. Indicator parameter / threshold grid (small, curated deltas) ─────────
  const thresholdVariants = [
    {},  // baseline (DEFAULT_THRESHOLDS)
    { rsiBullLo: 50, rsiBearHi: 50 },                         // looser RSI bands
    { rsiBullLo: 55, rsiBearHi: 45 },                         // tighter RSI bands
    { adxMin: 18 },                                            // allow weaker trends
    { adxMin: 26 },                                            // require stronger trends
    { cciBullMin: 40, cciBearMax: -40 },                       // looser CCI
    { cciBullMin: 65, cciBearMax: -65 },                       // tighter CCI
    { willrBullMin: -35, willrBearMax: -65 },                  // tighter Williams %R
    { stochBullLo: 50, stochBullHi: 90, stochBearLo: 10, stochBearHi: 50 }, // wider stoch
    { bbBullLo: 0.55, bbBullHi: 0.95, bbBearLo: 0.05, bbBearHi: 0.45 }       // wider BB
  ];

  const paramVariants = [
    {},                                  // default periods
    { rsiPeriod: 10 },                   // faster RSI
    { rsiPeriod: 21 },                   // slower RSI
    { atrPeriod: 10 },                   // faster ATR (tighter stops)
    { atrPeriod: 21 }                    // slower ATR (wider stops)
  ];

  // ── Build combination list (capped at maxCombos, randomly sampled if over) ──
  const allCombos = [];
  for (const { sl, tp } of slTpPairs) {
    for (const minScore of minScoreCandidates) {
      for (const thrVariant of thresholdVariants) {
        for (const paramVariant of paramVariants) {
          allCombos.push({
            slMultiplier: sl,
            tpMultiplier: tp,
            thresholds: { ...thrVariant, minScore },
            params: paramVariant
          });
        }
      }
    }
  }

  let combos = allCombos;
  if (combos.length > maxCombos) {
    // Random sample without replacement
    combos = shuffle(allCombos).slice(0, maxCombos);
  }

  // ── Run grid search ──────────────────────────────────────────────────────────
  const results = [];
  for (const combo of combos) {
    const { summary } = sim(closes, combo);
    if (summary.total < minTrades) continue;  // skip low-sample configs

    const objective = scoreObjective(summary, targetRR);
    results.push({ config: combo, summary, objective });
  }

  results.sort((a, b) => b.objective - a.objective);

  let best = results[0] || null;
  if (best && !best.trades) {
    const rerun = sim(closes, best.config);
    best = {
      ...best,
      trades: rerun.trades,
      summary: rerun.summary
    };
  }

  return {
    best,
    leaderboard: results.slice(0, 10),
    searched:    combos.length,
    qualified:   results.length,
    targetRR
  };
}

/**
 * Blended objective function. Higher is better.
 * Prioritizes expectancy (the real profitability driver), with bonuses for
 * higher win rate and penalties for excessive drawdown or thin sample size.
 */
function scoreObjective(summary, targetRR) {
  const { winRate, expectancy, total, maxDD, profitFactor } = summary;

  // Expectancy is the core driver — scale it up since it's a small number
  let score = expectancy * 100;

  // Win rate bonus (every % above 40 adds a little confidence)
  score += Math.max(0, winRate - 40) * 0.5;

  // Profit factor bonus (capped to avoid runaway scores from thin samples)
  score += Math.min(profitFactor, 5) * 3;

  // Sample size confidence — more trades = more reliable, diminishing returns
  score += Math.min(total, 100) * 0.05;

  // Drawdown penalty — each R of drawdown costs objective points
  score -= maxDD * 1.5;

  return score;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function scoreObjective(summary, targetRR) {
  const {
    winRate,
    expectancy,
    cashExpectancy,
    total,
    maxDD,
    cashMaxDD,
    profitFactor,
    cashProfitFactor
  } = summary;

  const effectiveExpectancy = Number.isFinite(cashExpectancy) ? cashExpectancy : expectancy;
  const effectiveMaxDD = Number.isFinite(cashMaxDD) ? cashMaxDD : maxDD;
  const effectivePF = Number.isFinite(cashProfitFactor) ? cashProfitFactor : profitFactor;

  let score = effectiveExpectancy * 100;
  score += Math.max(0, winRate - 40) * 0.5;
  score += Math.min(effectivePF, 5) * 3;
  score += Math.min(total, 100) * 0.05;
  score -= effectiveMaxDD * 1.5;
  return score;
}

module.exports = { optimize, scoreObjective };
