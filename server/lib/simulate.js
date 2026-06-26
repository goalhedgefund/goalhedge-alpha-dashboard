// ── CLAUDE Scalping — Backtest Simulation Engine (Optimized) ─────────────────
'use strict';

const { DEFAULT_THRESHOLDS } = require('./indicators');

const _precomputeCache = new WeakMap();

/**
 * Fast backtest simulation. Precomputes all rolling indicator arrays ONCE
 * per (closes, period-combination) pair and caches them, so a grid search
 * that repeats the same periods across many threshold variants doesn't
 * recompute RSI/ATR/etc from scratch every time.
 */
function simulate(closes, config = {}) {
  const thr   = config.thresholds ? { ...DEFAULT_THRESHOLDS, ...config.thresholds } : DEFAULT_THRESHOLDS;
  const slMul = config.slMultiplier ?? 1.2;
  const tpMul = config.tpMultiplier ?? 2.4;
  const cooldownTicks = config.cooldown ?? 8;
  const n = closes.length;

  if (n < 30) return { trades: [], summary: emptySummary() };

  const p = config.params || {};
  const rsiPeriod   = p.rsiPeriod   || 14;
  const stochPeriod = p.stochPeriod || 14;
  const cciPeriod   = p.cciPeriod   || 20;
  const bbPeriod    = p.bbPeriod    || 20;
  const atrPeriod   = p.atrPeriod   || 14;

  const cacheKey = `${rsiPeriod}|${stochPeriod}|${cciPeriod}|${bbPeriod}|${atrPeriod}`;
  let cached = _precomputeCache.get(closes);
  if (!cached) { cached = new Map(); _precomputeCache.set(closes, cached); }
  let pre = cached.get(cacheKey);
  if (!pre) {
    pre = precomputeIndicators(closes, { rsiPeriod, stochPeriod, cciPeriod, bbPeriod, atrPeriod });
    cached.set(cacheKey, pre);
  }

  const { rsiArr, atrArr, stochArr, cciArr, macdArr, bbPctArr, ema9Arr, ema21Arr, adxArr } = pre;

  const trades = [];
  let activeTrade = null;
  let signalCooldown = 0;
  let lastDir = null;
  const startBar = Math.max(30, bbPeriod, rsiPeriod + 1, atrPeriod + 1, 27);

  for (let i = startBar; i < n; i++) {
    const price = closes[i];

    if (activeTrade) {
      const { dir, entry, sl, tp } = activeTrade;
      const hit_tp = dir === 'LONG' ? price >= tp : price <= tp;
      const hit_sl = dir === 'LONG' ? price <= sl : price >= sl;
      if (hit_tp || hit_sl) {
        const won = hit_tp;
        const riskAmt   = Math.abs(entry - sl);
        const rewardAmt = Math.abs(tp - entry);
        trades.push({
          dir, entry, exit: price, result: won ? 'WIN' : 'LOSS',
          rMultiple: won ? (rewardAmt / riskAmt) : -1,
          score: activeTrade.score,
          entryBar: activeTrade.entryBar,
          exitBar: i,
          atr: activeTrade.atr,
          riskAmt
        });
        activeTrade = null;
        signalCooldown = cooldownTicks;
      }
      continue;
    }

    if (signalCooldown > 0) { signalCooldown--; continue; }

    const rsi = rsiArr[i], atr = atrArr[i], stoch = stochArr[i], cci = cciArr[i];
    const macd = macdArr[i], bbPct = bbPctArr[i], e9 = ema9Arr[i], e21 = ema21Arr[i];
    const willr = stoch - 100, adx = adxArr[i];

    let bullScore = 0, bearScore = 0;
    if (rsi > thr.rsiBullLo && rsi < thr.rsiBullHi) bullScore++;
    if (macd > 0) bullScore++;
    if (stoch > thr.stochBullLo && stoch < thr.stochBullHi) bullScore++;
    if (cci > thr.cciBullMin) bullScore++;
    if (willr > thr.willrBullMin) bullScore++;
    if (e9 > e21) bullScore++;
    if (bbPct > thr.bbBullLo && bbPct < thr.bbBullHi) bullScore++;
    if (adx > thr.adxMin) bullScore++;

    if (rsi < thr.rsiBearHi && rsi > thr.rsiBearLo) bearScore++;
    if (macd < 0) bearScore++;
    if (stoch < thr.stochBearHi && stoch > thr.stochBearLo) bearScore++;
    if (cci < thr.cciBearMax) bearScore++;
    if (willr < thr.willrBearMax) bearScore++;
    if (e9 < e21) bearScore++;
    if (bbPct < thr.bbBearHi && bbPct > thr.bbBearLo) bearScore++;
    if (adx > thr.adxMin) bearScore++;

    let dir = null, score = 0;
    if (bullScore >= thr.minScore && bullScore > bearScore) { dir = 'LONG'; score = bullScore; }
    else if (bearScore >= thr.minScore && bearScore > bullScore) { dir = 'SHORT'; score = bearScore; }

    if (dir && dir !== lastDir) {
      const risk   = Math.max(atr * slMul, price * 0.0015);
      const reward = Math.max(atr * tpMul, price * 0.0015 * (tpMul / slMul));
      const entry  = price;
      lastDir = dir;
      activeTrade = {
        dir, entry,
        sl: dir === 'LONG' ? entry - risk   : entry + risk,
        tp: dir === 'LONG' ? entry + reward : entry - reward,
        score,
        entryBar: i,
        atr
      };
    } else if (!dir) {
      lastDir = null;
    }
  }

  return { trades, summary: summarize(trades) };
}

function precomputeIndicators(closes, periods) {
  const n = closes.length;
  const { rsiPeriod, stochPeriod, cciPeriod, bbPeriod, atrPeriod } = periods;

  const rsiArr   = new Float64Array(n);
  const atrArr   = new Float64Array(n);
  const stochArr = new Float64Array(n);
  const cciArr   = new Float64Array(n);
  const macdArr  = new Float64Array(n);
  const bbPctArr = new Float64Array(n);
  const ema9Arr  = new Float64Array(n);
  const ema21Arr = new Float64Array(n);
  const adxArr   = new Float64Array(n);

  let ema9 = closes[0], ema21 = closes[0], ema12 = closes[0], ema26 = closes[0];
  const k9 = 2/10, k21 = 2/22, k12 = 2/13, k26 = 2/27;

  // Rolling sum trackers (avoid re-summing the whole window every bar)
  let atrRollSum = 0, rsiGainSum = 0, rsiLossSum = 0;

  for (let i = 0; i < n; i++) {
    const price = closes[i];

    if (i === 0) { ema9 = price; ema21 = price; ema12 = price; ema26 = price; }
    else {
      ema9  = price * k9  + ema9  * (1 - k9);
      ema21 = price * k21 + ema21 * (1 - k21);
      ema12 = price * k12 + ema12 * (1 - k12);
      ema26 = price * k26 + ema26 * (1 - k26);
    }
    ema9Arr[i] = ema9; ema21Arr[i] = ema21; macdArr[i] = ema12 - ema26;

    // RSI — rolling window sum (O(1) update, not O(period) rescan)
    if (i > 0) {
      const d = closes[i] - closes[i - 1];
      const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
      rsiGainSum += gain; rsiLossSum += loss;
      if (i > rsiPeriod) {
        const dOld = closes[i - rsiPeriod] - closes[i - rsiPeriod - 1];
        rsiGainSum -= dOld > 0 ? dOld : 0;
        rsiLossSum -= dOld < 0 ? -dOld : 0;
      }
    }
    rsiArr[i] = i >= rsiPeriod ? (100 - 100 / (1 + rsiGainSum / (rsiLossSum || 1e-9))) : 50;

    // ATR — rolling sum
    if (i > 0) {
      atrRollSum += Math.abs(closes[i] - closes[i - 1]);
      if (i > atrPeriod) atrRollSum -= Math.abs(closes[i - atrPeriod] - closes[i - atrPeriod - 1]);
    }
    atrArr[i] = i >= atrPeriod ? (atrRollSum / atrPeriod) : price * 0.005;

    // Stochastic — needs min/max in window; use small inner loop (period is small, ~14)
    if (i >= stochPeriod - 1) {
      let lo = Infinity, hi = -Infinity;
      for (let j = i - stochPeriod + 1; j <= i; j++) { const c = closes[j]; if (c < lo) lo = c; if (c > hi) hi = c; }
      stochArr[i] = hi === lo ? 50 : ((price - lo) / (hi - lo)) * 100;
    } else stochArr[i] = 50;

    // CCI
    if (i >= cciPeriod - 1) {
      let sum = 0;
      for (let j = i - cciPeriod + 1; j <= i; j++) sum += closes[j];
      const mean = sum / cciPeriod;
      let mdSum = 0;
      for (let j = i - cciPeriod + 1; j <= i; j++) mdSum += Math.abs(closes[j] - mean);
      const md = mdSum / cciPeriod;
      cciArr[i] = md === 0 ? 0 : (price - mean) / (0.015 * md);
    } else cciArr[i] = 0;

    // Bollinger %B
    if (i >= bbPeriod - 1) {
      let sum = 0;
      for (let j = i - bbPeriod + 1; j <= i; j++) sum += closes[j];
      const mean = sum / bbPeriod;
      let varSum = 0;
      for (let j = i - bbPeriod + 1; j <= i; j++) varSum += (closes[j] - mean) ** 2;
      const std = Math.sqrt(varSum / bbPeriod);
      const upper = mean + 2 * std, lower = mean - 2 * std;
      bbPctArr[i] = upper === lower ? 0.5 : (price - lower) / (upper - lower);
    } else bbPctArr[i] = 0.5;

    // ADX approximation
    if (i >= atrPeriod) {
      const range = Math.abs(closes[i] - closes[i - atrPeriod]);
      const atrVal = atrArr[i] || 1e-9;
      adxArr[i] = Math.min(60, Math.max(10, (range / (atrVal * atrPeriod)) * 30));
    } else adxArr[i] = 20;
  }

  return { rsiArr, atrArr, stochArr, cciArr, macdArr, bbPctArr, ema9Arr, ema21Arr, adxArr };
}

function summarize(trades) {
  const total = trades.length;
  if (total === 0) return emptySummary();
  const winTrades  = trades.filter(t => t.result === 'WIN');
  const lossTrades = trades.filter(t => t.result === 'LOSS');
  const wins = winTrades.length, losses = lossTrades.length;
  const pnlR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const avgWin  = wins   ? winTrades.reduce((s,t)=>s+t.rMultiple,0) / wins   : 0;
  const avgLoss = losses ? Math.abs(lossTrades.reduce((s,t)=>s+t.rMultiple,0) / losses) : 0;

  let peak = 0, cum = 0, maxDD = 0;
  for (const t of trades) { cum += t.rMultiple; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; }

  const grossWin  = winTrades.reduce((s,t)=>s+t.rMultiple, 0);
  const grossLoss = Math.abs(lossTrades.reduce((s,t)=>s+t.rMultiple, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);

  return {
    total, wins, losses,
    winRate:    +((wins/total) * 100).toFixed(2),
    pnlR:       +pnlR.toFixed(2),
    expectancy: +(pnlR/total).toFixed(4),
    avgWinR:    +avgWin.toFixed(2),
    avgLossR:   +avgLoss.toFixed(2),
    maxDD:      +maxDD.toFixed(2),
    profitFactor: +Math.min(profitFactor, 999).toFixed(2)
  };
}

function emptySummary() {
  return { total: 0, wins: 0, losses: 0, winRate: 0, pnlR: 0, expectancy: 0, avgWinR: 0, avgLossR: 0, maxDD: 0, profitFactor: 0 };
}

module.exports = { simulate, summarize, precomputeIndicators };
