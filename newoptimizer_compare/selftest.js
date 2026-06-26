'use strict';
/**
 * selftest.js — verifies metrics.js / economics.js / optimizer.js with a
 * synthetic simulate() whose "truth" we control:
 *   - a BROAD plateau of genuinely-edged configs around sl≈1.2, minScore 6–7
 *   - a SHARP overfit spike (sl=2.2, minScore=8) with a great but fluky,
 *     low-sample in-sample result
 * A correct optimizer should crown a plateau config, not the spike.
 */

const M = require('./metrics');
const Econ = require('./economics');
const { optimize } = require('./optimizer');

// deterministic PRNG keyed by integers
function hashSeed(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) { h ^= Math.floor(n * 1000) >>> 0; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// ── synthetic simulate(closes, config) ──────────────────────────────────────
// Win probability depends on how close the config sits to the true plateau.
// The "spike" config only wins while the local price is TRENDING — an edge that
// exists in the early up-trend regime of our series but collapses in the later
// chop. Because the optimizer slices by time for OOS folds, the spike looks
// brilliant in early folds and falls apart in late ones: a textbook overfit.
function makeSyntheticSimulate() {
  return function simulate(closes, config) {
    const sl = config.slMultiplier;
    const tp = config.tpMultiplier;
    const minScore = config.minScore;
    const spacing = Math.max(3, minScore * 2);  // stricter ⇒ fewer signals

    const onPlateau = sl >= 1.0 && sl <= 1.5 && (minScore === 6 || minScore === 7);
    const distPenalty = Math.abs(sl - 1.2) * 0.05 + (minScore <= 5 ? 0.05 : 0);
    const isSpike = sl >= 2.2 && minScore === 8;

    const riskAmt = 1000;
    const entryPrice = 100;
    const stopDist = sl;
    const qty = riskAmt / stopDist;
    const trades = [];
    for (let i = spacing; i < closes.length; i += spacing) {
      let winProb;
      if (isSpike) {
        // Secret low-volatility edge: only works while the tape is calm (the
        // early regime). In the later high-vol regime it's a genuine loser.
        const w = closes.slice(Math.max(0, i - spacing), i);
        const localVol = M.std(w);
        winProb = localVol < 1.0 ? 0.80 : 0.22;
      } else {
        winProb = (onPlateau ? 0.46 : 0.36) - distPenalty; // robust, regime-free
      }
      winProb = Math.max(0.2, Math.min(0.85, winProb));

      const rnd = M.mulberry32(hashSeed(i, sl, tp, minScore))();
      const win = rnd < winProb;
      const side = (i % 2 === 0) ? 'long' : 'short';
      const dir = side === 'long' ? 1 : -1;
      const move = win ? tp : -sl;
      const exitPrice = entryPrice + dir * move;
      trades.push({ entryPrice, exitPrice, side, qty, riskAmt, stopPrice: entryPrice - dir * sl });
    }
    return { summary: { config }, trades };
  };
}

// ════════════════════════════ run the checks ═══════════════════════════════
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', label); } };

console.log('── metrics.js sanity ──');
ok(approx(M.mean([1, 2, 3]), 2), 'mean');
ok(approx(M.median([1, 3, 2, 4]), 2.5), 'median');
ok(M.wilsonLowerBound(7, 10) < 0.7 && M.wilsonLowerBound(7, 10) > 0.3, 'wilson shrinks small sample');
ok(M.wilsonLowerBound(700, 1000) > 0.66, 'wilson tight on big sample');
ok(approx(M.normalCdf(0), 0.5, 1e-3), 'normalCdf(0)=0.5');
ok(M.normalInv(0.975) > 1.95 && M.normalInv(0.975) < 1.97, 'normalInv(.975)≈1.96');
ok(M.maxDrawdown([1, 1, -3, 1]) === 3, 'maxDrawdown');
{
  const dsrHigh = M.deflatedSharpe({ sharpe: 0.5, nObs: 300, nTrials: 50, sdOfTrialSharpes: 0.05, skew: 0, kurt: 3 });
  const dsrLow = M.deflatedSharpe({ sharpe: 0.05, nObs: 300, nTrials: 50, sdOfTrialSharpes: 0.2, skew: 0, kurt: 3 });
  ok(dsrHigh > dsrLow, 'DSR higher for stronger, less-disputed Sharpe');
  ok(dsrHigh >= 0 && dsrHigh <= 1, 'DSR is a probability');
}
{
  const lb = M.bootstrapMeanLB([1, -1, 1, -1, 1, -1, 1, 2, 1, 1], { seed: 1 });
  ok(lb < M.mean([1, -1, 1, -1, 1, -1, 1, 2, 1, 1]), 'bootstrap LB below sample mean');
}
{
  // PBO: a matrix where the IS-best is consistently OOS-best ⇒ low PBO.
  const robust = [], lucky = [];
  for (let b = 0; b < 8; b++) { robust.push(1 + 0.01 * b); lucky.push(b < 4 ? 5 : -5); }
  const mat = [robust, lucky, robust.map((x) => x - 0.5)];
  const { pbo } = M.probabilityOfBacktestOverfitting(mat);
  ok(pbo !== null && pbo >= 0 && pbo <= 1, 'PBO in [0,1]');
}

console.log('── economics.js sanity ──');
{
  const cfg = Econ.makeCostConfig({ enabled: true, mode: 'intraday' });
  ok(approx(cfg.rate, 0.0003521), 'intraday rate');
  const e = Econ.tradeEconomics({ entryPrice: 100, exitPrice: 102, side: 'long', qty: 10 }, cfg);
  ok(approx(e.grossCashPnl, 20), 'gross cash pnl');
  ok(approx(e.turnover, 100 * 10 + 102 * 10), 'round-trip turnover');
  ok(approx(e.exchangeCost, e.turnover * 0.0003521), 'exchange cost');
  ok(approx(e.netCashPnl, e.grossCashPnl - e.exchangeCost), 'net = gross - cost');
  const d = Econ.tradeEconomics({ entryPrice: 100, exitPrice: 102, side: 'long', qty: 10 }, Econ.makeCostConfig({ enabled: true, mode: 'daily' }));
  ok(d.exchangeCost > e.exchangeCost, 'daily costs more than intraday');
}

console.log('── optimizer.js end-to-end ──');
// Regime change: first 40% trends up (where the overfit spike "works"), the
// rest mean-reverts/chops (where it doesn't). The plateau edge is regime-free.
const N = 4000;
const SPLIT = 0.35;
const closes = Array.from({ length: N }, (_, i) => {
  if (i < N * SPLIT) return 100 + i * 0.02 + Math.sin(i / 7) * 0.4;    // calm uptrend (low vol)
  const base = 100 + (N * SPLIT) * 0.02;
  return base + Math.sin(i / 5) * 3 + Math.sin(i / 23) * 1.6;          // volatile chop (high vol)
});
const simulate = makeSyntheticSimulate();

function runAndReport(label, costEnabled) {
  const t0 = Date.now();
  const res = optimize(closes, 2, { simulate, costEnabled, costMode: 'intraday' });
  const ms = Date.now() - t0;
  const best = res.best;
  console.log(`\n  [${label}]  searched=${res.searched}  qualified=${res.qualified}  ${ms}ms  PBO=${res.validation.pbo}`);
  console.log('   best config:', JSON.stringify(best.config));
  console.log('   robustScore=%s  oosMedian=%s  oosHitRate=%s  bootLB=%s  deflationProb=%s',
    best.robustScore.toFixed(4), best.oos.median.toFixed(4), best.oos.hitRate.toFixed(2),
    best.bootstrapLB.toFixed(4), best.deflationProb.toFixed(3));
  console.log('   inSample: trades=%d winRate=%s PF=%s netExp=%s maxDD=%sR',
    best.inSample.trades, best.inSample.winRate.toFixed(3), best.inSample.profitFactor.toFixed(2),
    best.inSample.expectancy.toFixed(4), best.inSample.maxDrawdown.toFixed(2));
  return res;
}

const gross = runAndReport('costs OFF', false);
const net = runAndReport('costs ON', true);

// Assertions on optimizer behaviour.
ok(gross.best != null, 'returns a best');
ok(Array.isArray(gross.leaderboard) && gross.leaderboard.length > 0, 'leaderboard populated');
ok(gross.searched > 50, 'searched a meaningful number of configs');
ok(gross.best.config.slMultiplier >= 0.9 && gross.best.config.slMultiplier <= 1.6,
  'best sits on the true plateau, not the overfit spike');
ok(gross.best.config.minScore === 6 || gross.best.config.minScore === 7,
  'best minScore on plateau');
ok(gross.best.qualified === true, 'best qualifies all gates');
// Spike must NOT win.
ok(!(gross.best.config.slMultiplier >= 2.2 && gross.best.config.minScore === 8),
  'overfit spike rejected');
ok(net.best.inSample.exchangeCost > 0, 'net run records exchange cost');
ok(net.best.inSample.netCashPnl < net.best.inSample.grossCashPnl, 'net < gross when costs on');
ok(['best','leaderboard','searched','qualified','stages','validation','costConfig']
  .every((k) => k in gross), 'rich metadata keys present');

console.log(`\n──────────  ${pass} passed, ${fail} failed  ──────────`);
process.exit(fail ? 1 : 0);
