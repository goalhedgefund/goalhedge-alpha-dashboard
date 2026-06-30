const timeframeConfig = require('../config/timeframe.config');
const { normalizeChartResponse } = require('../engines/candle.engine');

function candleSliceToSeries(candles = []) {
  return candles.map((candle) => ({
    open: Number(candle.o ?? candle.open ?? 0),
    high: Number(candle.h ?? candle.high ?? 0),
    low: Number(candle.l ?? candle.low ?? 0),
    close: Number(candle.c ?? candle.close ?? 0),
    volume: Number(candle.v ?? candle.volume ?? 0),
    timestamp: Number(candle.ts ?? candle.timestamp ?? 0)
  }));
}

// Dhan REST API expects IST (UTC+5:30) datetime strings
function toIST(date) {
  return new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
}

function createCandleService({ restClient, replayRepository, cacheStore, getMode, getReplayRange, getReplayNow }) {
  function getFrameMeta(frame) {
    return timeframeConfig.find((item) => item.key === frame);
  }

  async function fetchFrameCandles({ symbol, exchange, secId, frame }) {
    const meta = getFrameMeta(frame);
    if (!meta) return [];

    const mode = String(getMode?.() || 'LIVE').toUpperCase();
    if (mode === 'REPLAY') {
      // Causal: only candles that have "happened" by the simulated replay
      // clock are visible, and the most recent bucket is excluded unless it's
      // fully closed. This makes REPLAY a true walk-forward (matches the
      // standalone backtest's no-look-ahead model) instead of revealing the
      // whole configured range immediately.
      const replayRange = typeof getReplayRange === 'function' ? getReplayRange() : null;
      const asOfMs = typeof getReplayNow === 'function' ? getReplayNow() : null;
      const series = replayRepository.getClosedSeries(symbol, frame, replayRange, asOfMs);
      const normalized = candleSliceToSeries(series);
      cacheStore.setCandles(`${symbol}:${frame}`, normalized);
      return normalized;
    }

    const nowIST = toIST(new Date());
    const end = frame === 'D'
      ? nowIST.toISOString().slice(0, 10)
      : nowIST.toISOString().replace('T', ' ').slice(0, 19);

    const startIST = toIST(new Date());
    if (frame === 'D') startIST.setDate(startIST.getDate() - 365);
    else if (frame === '60') startIST.setDate(startIST.getDate() - 15);
    else if (frame === '15') startIST.setDate(startIST.getDate() - 10);
    else if (frame === '5') startIST.setDate(startIST.getDate() - 7);
    else startIST.setDate(startIST.getDate() - 5);
    const startValue = frame === 'D'
      ? startIST.toISOString().slice(0, 10)
      : startIST.toISOString().replace('T', ' ').slice(0, 19);

    const response = frame === 'D'
      ? await restClient.getDailyCandles({
          securityId: secId,
          exchangeSegment: exchange,
          instrument: 'EQUITY',
          fromDate: startValue,
          toDate: end,
          oi: false
        })
      : await restClient.getIntradayCandles({
          securityId: secId,
          exchangeSegment: exchange,
          instrument: 'EQUITY',
          interval: frame,
          fromDate: startValue,
          toDate: end,
          oi: false
        });
    const candles = normalizeChartResponse(response);
    cacheStore.setCandles(`${symbol}:${frame}`, candles);
    return candles;
  }

  async function refreshDueLeg(leg) {
    const candles = await fetchFrameCandles({
      symbol: leg.symbol,
      exchange: leg.exchangeSegment,
      secId: leg.securityId,
      frame: leg.frame
    });
    return candles;
  }

  return {
    fetchFrameCandles,
    refreshDueLeg
  };
}

module.exports = { createCandleService };
