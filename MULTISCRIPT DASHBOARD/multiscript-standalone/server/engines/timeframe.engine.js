const timeframeConfig = require('../config/timeframe.config');

function getTimeframeMeta(frame) {
  return timeframeConfig.find((item) => item.key === frame) || timeframeConfig[0];
}

function createLegId(symbol, frame) {
  return `${symbol}:${frame}`;
}

function isDueForRefresh(leg, now = Date.now()) {
  return !leg.lastRefreshAt || (now - leg.lastRefreshAt) >= (leg.refreshMs || 0);
}

function createLegState({ symbol, name, exchangeSegment, securityId, frame, config = {}, candles = [], enabled = false, usingDefault = true }) {
  const meta = getTimeframeMeta(frame);
  return {
    id: createLegId(symbol, frame),
    symbol,
    name,
    exchangeSegment,
    securityId,
    frame,
    timeframe: meta.timeframe,
    workbookName: meta.workbookName,
    refreshMs: meta.refreshMs,
    enabled,
    usingDefault,
    candles,
    config,
    bull: 0,
    bear: 0,
    signal: 'WAIT',
    trend: 'flat',
    ltp: 0,
    entry: 0,
    stop: 0,
    target: 0,
    rr: config.rr || 3,
    realizedPnl: 0,
    activeTrade: null,
    status: enabled ? 'WAIT' : 'DISABLED',
    lastRefreshAt: 0,
    lastTickAt: 0,
    lastCandleTimestamp: 0,
    lastError: '',
    source: 'BOOT',
    // Re-entry discipline matching scripts/backtest/engine.js's simulate model
    // (only consulted when the validated scalper strategy is active — see
    // runner.engine.js's walk-forward loop).
    cooldownRemaining: 0,
    lastSignalDir: null
  };
}

module.exports = {
  getTimeframeMeta,
  createLegId,
  isDueForRefresh,
  createLegState
};
