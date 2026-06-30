const defaultSignal = require('./signal.engine');
const scalperSignal = require('./signal.scalper');
const regime = require('./regime.filter');
const { computeAtr, mergeLivePrice } = require('./candle.engine');
const { computeTradePlan } = require('./risk.engine');

// Recommended realistic-path system: set SCALPER_ENGINE=1 (or STRATEGY_ENGINE=scalper)
// to use the backtested 8-indicator signal + NIFTY regime gate. Default OFF =
// unchanged legacy behaviour.
const USE_SCALPER = process.env.SCALPER_ENGINE === '1' || process.env.STRATEGY_ENGINE === 'scalper';
const scoreSeries = USE_SCALPER ? scalperSignal.scoreSeries : defaultSignal.scoreSeries;

function evaluateLeg({ leg, livePrice, candles = [], config = {}, primary = false }) {
  const mergedCandles = mergeLivePrice(candles, livePrice, Date.now());
  const score = scoreSeries(mergedCandles, livePrice, config);
  if (USE_SCALPER && score.signal && score.signal !== 'WAIT') {
    const lastCandle = candles[candles.length - 1] || {};
    const ts = lastCandle.ts ?? lastCandle.time ?? lastCandle.timestamp ?? Date.now();
    if (!regime.allow(score.signal, ts)) { score.signal = 'WAIT'; score.trend = 'flat'; score.gatedByRegime = true; }
  }
  const atr = computeAtr(mergedCandles, config.atrPeriod || 14) || Math.max(livePrice * 0.005, 0.5);
  const tradePlan = computeTradePlan({
    signal: score.signal,
    entry: Number.isFinite(livePrice) && livePrice > 0 ? livePrice : score.indicators.last,
    atr,
    rr: config.rr || 3,
    multiplier: config.slMultiplier || 1.2
  });

  return {
    ...leg,
    primary,
    candles: mergedCandles,
    bull: score.bull,
    bear: score.bear,
    signal: score.signal,
    trend: score.trend,
    indicators: score.indicators,
    atr,
    entry: tradePlan.entry,
    stop: tradePlan.stop,
    target: tradePlan.target,
    rr: tradePlan.rr
  };
}

module.exports = { evaluateLeg, USE_SCALPER };
