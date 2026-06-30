#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { summarize, precomputeIndicators } = require('../server/lib/simulate');
const { DEFAULT_THRESHOLDS } = require('../server/lib/indicators');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CANDLE_DIR = path.join(DATA_DIR, 'futures-eligible-cash-candles');
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const INTRADAY_TIMEFRAMES = new Set(['1', '5', '15']);
const LAST_INTRADAY_ENTRY_MINUTE = (15 * 60) + 15;
const INTRADAY_SQUARE_OFF_MINUTE = (15 * 60) + 25;
const EXCHANGE_CHARGE_RATES = {
  intraday: 0.0003521,
  delivery: 0.002222
};

function parseArgs(argv) {
  const args = {
    files: [],
    write: false,
    backup: true,
    months: 0
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--file') args.files.push(path.resolve(next() || ''));
    else if (a === '--all') args.all = true;
    else if (a === '--write') args.write = true;
    else if (a === '--no-backup') args.backup = false;
    else if (a === '--months') args.months = Number(next()) || 0;
    else if (a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  return `
Usage:
  node scripts/apply-trading-cost-to-configs.js --all --write
  node scripts/apply-trading-cost-to-configs.js --file D:\\CODEX\\data\\symbol-configs.json --write

Rules:
  1m, 5m, 15m: intraday cost 0.03521% of turnover.
  60m, D: daily/delivery cost 0.2222% of turnover.

Without --write, this runs a dry summary only.
`.trim();
}

function findConfigFiles() {
  return fs.readdirSync(DATA_DIR)
    .filter(name => /^symbol-configs.*\.json$/i.test(name))
    .map(name => path.join(DATA_DIR, name))
    .sort();
}

function safeName(symbol) {
  return String(symbol || '').replace(/[^\w.-]+/g, '_');
}

function candleFileFor(symbol) {
  return path.join(CANDLE_DIR, symbol, `${safeName(symbol)}_1m.json`);
}

function loadCandles(symbol) {
  const file = candleFileFor(symbol);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(payload.candles) ? payload.candles : [];
}

function inferMonthsFromFile(file, args) {
  if (args.months > 0) return args.months;
  return /3mo/i.test(path.basename(file)) ? 3 : 0;
}

function filterCandles(candles, months) {
  if (!months) return candles;
  const maxTs = candles.reduce((m, c) => Math.max(m, c.ts > 1e12 ? c.ts : c.ts * 1000), 0);
  if (!maxTs) return candles;
  const from = new Date(maxTs);
  from.setMonth(from.getMonth() - months);
  const fromMs = from.getTime();
  return candles.filter(c => {
    const ms = c.ts > 1e12 ? c.ts : c.ts * 1000;
    return ms >= fromMs && ms <= maxTs;
  });
}

function aggregateCandles(candles, timeframe) {
  if (timeframe === '1') return candles;
  const buckets = new Map();
  for (const c of candles) {
    const key = bucketKey(c.ts, timeframe);
    const b = buckets.get(key);
    if (!b) buckets.set(key, { ts: key, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
    else {
      b.h = Math.max(b.h, c.h);
      b.l = Math.min(b.l, c.l);
      b.c = c.c;
      b.v += c.v || 0;
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

function bucketKey(ts, timeframe) {
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  if (timeframe === 'D') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const bucketMs = Number(timeframe) * 60 * 1000;
  return Math.floor(ms / bucketMs) * bucketMs / 1000;
}

function buildExecutionMeta(candles, timeframe) {
  return {
    timeframe,
    intraday: INTRADAY_TIMEFRAMES.has(timeframe),
    minuteOfDay: candles.map(c => istMinuteOfDay(c.ts)),
    dayKey: candles.map(c => istDayKey(c.ts))
  };
}

function istMinuteOfDay(ts) {
  const ms = (ts > 1e12 ? ts : ts * 1000) + IST_OFFSET_MS;
  const d = new Date(ms);
  return (d.getUTCHours() * 60) + d.getUTCMinutes();
}

function istDayKey(ts) {
  const ms = (ts > 1e12 ? ts : ts * 1000) + IST_OFFSET_MS;
  return Math.floor(ms / 86400000);
}

function simulateOhlcNextOpen(candles, config = {}) {
  const closes = candles.map(c => c.c);
  const n = closes.length;
  if (n < 30) return { trades: [], summary: emptySummary() };

  const timeframe = String(config.timeframe || '1');
  const execMeta = buildExecutionMeta(candles, timeframe);
  const thr = config.thresholds ? { ...DEFAULT_THRESHOLDS, ...config.thresholds } : DEFAULT_THRESHOLDS;
  const slMul = config.slMultiplier ?? 1.2;
  const tpMul = config.tpMultiplier ?? 2.4;
  const cooldownTicks = config.cooldown ?? 8;
  const p = config.params || {};
  const rsiPeriod = p.rsiPeriod || 14;
  const stochPeriod = p.stochPeriod || 14;
  const cciPeriod = p.cciPeriod || 20;
  const bbPeriod = p.bbPeriod || 20;
  const atrPeriod = p.atrPeriod || 14;
  const pre = precomputeIndicators(closes, { rsiPeriod, stochPeriod, cciPeriod, bbPeriod, atrPeriod });
  const { rsiArr, atrArr, stochArr, cciArr, macdArr, bbPctArr, ema9Arr, ema21Arr, adxArr } = pre;
  const trades = [];
  let activeTrade = null;
  let signalCooldown = 0;
  let lastDir = null;
  const startBar = Math.max(30, bbPeriod, rsiPeriod + 1, atrPeriod + 1, 27);

  for (let i = startBar; i < n; i++) {
    if (activeTrade) {
      const exit = evaluateExit(candles[i], i, activeTrade, execMeta);
      if (exit) {
        closeTrade(trades, activeTrade, exit.price, exit.result, i, exit.reason);
        activeTrade = null;
        signalCooldown = cooldownTicks;
      }
      continue;
    }

    if (signalCooldown > 0) {
      signalCooldown--;
      continue;
    }
    if (i + 1 >= n) continue;

    const signal = signalAtBar(i, thr, { rsiArr, atrArr, stochArr, cciArr, macdArr, bbPctArr, ema9Arr, ema21Arr, adxArr });
    if (!signal.dir) {
      lastDir = null;
      continue;
    }
    if (signal.dir === lastDir) continue;

    const entryBar = i + 1;
    if (!canEnterAtBar(entryBar, execMeta)) {
      lastDir = signal.dir;
      continue;
    }

    const entry = candles[entryBar].o;
    const atr = atrArr[i];
    const risk = Math.max(atr * slMul, closes[i] * 0.0015);
    const reward = Math.max(atr * tpMul, closes[i] * 0.0015 * (tpMul / slMul));
    lastDir = signal.dir;
    activeTrade = {
      dir: signal.dir,
      entry,
      sl: signal.dir === 'LONG' ? entry - risk : entry + risk,
      tp: signal.dir === 'LONG' ? entry + reward : entry - reward,
      score: signal.score,
      signalBar: i,
      entryBar,
      atr,
      riskAmt: risk
    };

    const sameBarExit = evaluateExit(candles[entryBar], entryBar, activeTrade, execMeta, true);
    if (sameBarExit) {
      closeTrade(trades, activeTrade, sameBarExit.price, sameBarExit.result, entryBar, sameBarExit.reason);
      activeTrade = null;
      signalCooldown = cooldownTicks;
    }
  }
  return { trades, summary: summarize(trades) };
}

function signalAtBar(i, thr, pre) {
  const rsi = pre.rsiArr[i], stoch = pre.stochArr[i], cci = pre.cciArr[i];
  const macd = pre.macdArr[i], bbPct = pre.bbPctArr[i], e9 = pre.ema9Arr[i], e21 = pre.ema21Arr[i];
  const willr = stoch - 100, adx = pre.adxArr[i];
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
  if (bullScore >= thr.minScore && bullScore > bearScore) return { dir: 'LONG', score: bullScore };
  if (bearScore >= thr.minScore && bearScore > bullScore) return { dir: 'SHORT', score: bearScore };
  return { dir: null, score: 0 };
}

function canEnterAtBar(i, execMeta) {
  if (!execMeta.intraday) return true;
  return execMeta.minuteOfDay[i] <= LAST_INTRADAY_ENTRY_MINUTE;
}

function evaluateExit(candle, barIndex, trade, execMeta, allowEntryBarExit = false) {
  if (!allowEntryBarExit && barIndex <= trade.entryBar) return null;
  if (execMeta.intraday && execMeta.minuteOfDay[barIndex] >= INTRADAY_SQUARE_OFF_MINUTE) {
    return { price: candle.o, result: squareOffResult(trade, candle.o), reason: 'EOD_SQUARE_OFF' };
  }
  if (execMeta.intraday && execMeta.dayKey[barIndex] !== execMeta.dayKey[trade.entryBar]) {
    return { price: candle.o, result: squareOffResult(trade, candle.o), reason: 'NO_CARRY_SQUARE_OFF' };
  }
  const hitTp = trade.dir === 'LONG' ? candle.h >= trade.tp : candle.l <= trade.tp;
  const hitSl = trade.dir === 'LONG' ? candle.l <= trade.sl : candle.h >= trade.sl;
  if (!hitTp && !hitSl) return null;
  if (hitTp && hitSl) return { price: trade.sl, result: 'LOSS', reason: 'SL_AND_TP_SAME_CANDLE_ASSUME_SL' };
  if (hitTp) return { price: trade.tp, result: 'WIN', reason: 'TARGET' };
  return { price: trade.sl, result: 'LOSS', reason: 'STOPLOSS' };
}

function squareOffResult(trade, exitPrice) {
  if (trade.dir === 'LONG') return exitPrice >= trade.entry ? 'WIN' : 'LOSS';
  return exitPrice <= trade.entry ? 'WIN' : 'LOSS';
}

function closeTrade(trades, trade, exitPrice, result, exitBar, exitReason) {
  const riskAmt = Math.abs(trade.entry - trade.sl) || 1e-9;
  const signedPnl = trade.dir === 'LONG' ? exitPrice - trade.entry : trade.entry - exitPrice;
  const plannedRewardAmt = Math.abs(trade.tp - trade.entry);
  const rMultiple = result === 'WIN' && exitReason === 'TARGET'
    ? (plannedRewardAmt / riskAmt)
    : signedPnl / riskAmt;
  trades.push({
    dir: trade.dir,
    entry: trade.entry,
    exit: exitPrice,
    result,
    rMultiple,
    score: trade.score,
    signalBar: trade.signalBar,
    entryBar: trade.entryBar,
    exitBar,
    atr: trade.atr,
    riskAmt,
    sl: trade.sl,
    tp: trade.tp,
    exitReason
  });
}

function applyTradingCost(trades, timeframe) {
  const costRate = INTRADAY_TIMEFRAMES.has(timeframe) ? EXCHANGE_CHARGE_RATES.intraday : EXCHANGE_CHARGE_RATES.delivery;
  return trades.map(t => {
    const grossR = Number(t.rMultiple) || 0;
    const riskAmt = Math.abs(Number(t.riskAmt)) || Math.abs(Number(t.entry) - Number(t.sl)) || 1e-9;
    const turnoverPerShare = Math.abs(Number(t.entry)) + Math.abs(Number(t.exit));
    const costPerShare = turnoverPerShare * costRate;
    const costR = costPerShare / riskAmt;
    const netR = grossR - costR;
    return {
      ...t,
      grossRMultiple: grossR,
      rMultiple: netR,
      tradingCostR: costR,
      turnoverPerShare,
      costRate,
      result: netR > 0 ? 'WIN' : 'LOSS'
    };
  });
}

function applyCostSummary(summary, trades, timeframe) {
  const costTrades = applyTradingCost(trades, timeframe);
  const netSummary = summarize(costTrades);
  const totalTradingCostR = costTrades.reduce((sum, t) => sum + (Number(t.tradingCostR) || 0), 0);
  const avgTradingCostR = costTrades.length ? totalTradingCostR / costTrades.length : 0;
  const costRate = INTRADAY_TIMEFRAMES.has(timeframe) ? EXCHANGE_CHARGE_RATES.intraday : EXCHANGE_CHARGE_RATES.delivery;
  return {
    grossSummary: summary,
    netSummary: {
      ...netSummary,
      totalTradingCostR: +totalTradingCostR.toFixed(4),
      avgTradingCostR: +avgTradingCostR.toFixed(6),
      costRate,
      costType: INTRADAY_TIMEFRAMES.has(timeframe) ? 'intraday' : 'delivery'
    }
  };
}

function emptySummary() {
  return { total: 0, wins: 0, losses: 0, winRate: 0, pnlR: 0, expectancy: 0, avgWinR: 0, avgLossR: 0, maxDD: 0, profitFactor: 0 };
}

function processFile(file, args) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const months = inferMonthsFromFile(file, args);
  const stats = { file, entries: 0, updated: 0, missingCandles: 0 };
  const bySymbol = new Map();

  for (const [key, value] of Object.entries(cfg)) {
    const symbol = value.symbol || value.underlying;
    if (!symbol) continue;
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
    bySymbol.get(symbol).push([key, value]);
  }

  for (const [symbol, entries] of bySymbol.entries()) {
    const baseCandles = loadCandles(symbol);
    if (!baseCandles) {
      stats.missingCandles += entries.length;
      continue;
    }
    const sourceCandles = filterCandles(baseCandles, months);
    const aggregatedByTf = new Map();
    for (const [key, value] of entries) {
      const tf = String(value.timeframe || key.split(':').pop());
      if (!aggregatedByTf.has(tf)) aggregatedByTf.set(tf, aggregateCandles(sourceCandles, tf));
      const candles = aggregatedByTf.get(tf);
      const sim = simulateOhlcNextOpen(candles, {
        timeframe: tf,
        slMultiplier: value.slMultiplier,
        tpMultiplier: value.tpMultiplier,
        thresholds: value.thresholds || {},
        params: value.params || {}
      });
      const { grossSummary, netSummary } = applyCostSummary(sim.summary, sim.trades, tf);
      value.grossSummary = grossSummary;
      value.summary = netSummary;
      value.tradingCost = {
        applied: true,
        mode: netSummary.costType,
        costRate: netSummary.costRate,
        totalTradingCostR: netSummary.totalTradingCostR,
        avgTradingCostR: netSummary.avgTradingCostR,
        note: 'summary is net of exchange cost; grossSummary preserves pre-cost metrics'
      };
      value.costAdjustedAt = Date.now();
      stats.entries++;
      stats.updated++;
    }
  }

  if (args.write) {
    if (args.backup) {
      const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(file, backup);
      stats.backup = backup;
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  }
  return stats;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.all && !args.files.length)) {
    console.log(usage());
    return;
  }
  const files = args.all ? findConfigFiles() : args.files;
  const results = files.map(file => processFile(file, args));
  console.log(JSON.stringify({ write: args.write, results }, null, 2));
}

main();
