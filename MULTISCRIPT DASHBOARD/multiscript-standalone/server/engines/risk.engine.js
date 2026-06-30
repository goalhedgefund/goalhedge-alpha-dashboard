const riskConfig = require('../config/risk.config');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeKellyFraction(winRate, rr = riskConfig.rr) {
  const p = clamp(winRate, 0, 1);
  const q = 1 - p;
  const raw = ((rr * p) - q) / rr;
  return clamp(raw, 0, riskConfig.kellyCap);
}

function computePositionSize({ capital = riskConfig.capital, entryPrice, stopPrice, winRate = 0.55, riskPerTrade = riskConfig.riskPerTrade }) {
  const riskAmount = capital * riskPerTrade;
  const unitRisk = Math.max(Math.abs(entryPrice - stopPrice), 1e-9);
  const riskBasedQty = Math.floor(riskAmount / unitRisk);
  const kellyFraction = Math.max(computeKellyFraction(winRate), riskConfig.minKellyFraction);
  const kellyQty = Math.floor((capital * kellyFraction) / Math.max(entryPrice, 1e-9));
  return {
    kellyFraction,
    quantity: Math.max(1, Math.min(riskBasedQty, kellyQty)),
    riskAmount
  };
}

function computeTradePlan({ signal, entry, atr = 1, rr = riskConfig.rr, multiplier = 1.2 }) {
  if (signal === 'LONG') {
    const stop = entry - (atr * multiplier);
    const target = entry + ((entry - stop) * rr);
    return { entry, stop, target, rr };
  }
  if (signal === 'SHORT') {
    const stop = entry + (atr * multiplier);
    const target = entry - ((stop - entry) * rr);
    return { entry, stop, target, rr };
  }
  return { entry, stop: entry, target: entry, rr };
}

module.exports = {
  clamp,
  computeKellyFraction,
  computePositionSize,
  computeTradePlan
};
