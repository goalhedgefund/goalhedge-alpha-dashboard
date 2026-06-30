function normalizeChartResponse(response = {}) {
  const data = response.data || response.result || response;
  const open = data.open || [];
  const high = data.high || [];
  const low = data.low || [];
  const close = data.close || [];
  const volume = data.volume || [];
  const timestamp = data.timestamp || [];
  const openInterest = data.open_interest || data.openInterest || [];

  const size = Math.min(open.length, high.length, low.length, close.length, timestamp.length || close.length);
  const candles = [];
  for (let i = 0; i < size; i += 1) {
    candles.push({
      open: Number(open[i] ?? 0),
      high: Number(high[i] ?? 0),
      low: Number(low[i] ?? 0),
      close: Number(close[i] ?? 0),
      volume: Number(volume[i] ?? 0),
      timestamp: Number(timestamp[i] ?? 0),
      openInterest: Number(openInterest[i] ?? 0)
    });
  }
  return candles;
}

function mergeLivePrice(candles = [], livePrice, stamp = Date.now()) {
  if (!Number.isFinite(livePrice) || livePrice <= 0) return candles;
  const next = candles.slice();
  const last = next[next.length - 1];
  if (!last) {
    next.push({ open: livePrice, high: livePrice, low: livePrice, close: livePrice, volume: 0, timestamp: stamp });
    return next;
  }
  next[next.length - 1] = {
    ...last,
    high: Math.max(last.high, livePrice),
    low: Math.min(last.low, livePrice),
    close: livePrice,
    timestamp: stamp
  };
  return next;
}

function computeAtr(candles = [], period = 14) {
  if (candles.length < 2) return 0;
  const slice = candles.slice(-period);
  const ranges = slice.map((candle, index) => {
    const prevClose = index > 0 ? slice[index - 1].close : candle.open;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    );
  });
  const sum = ranges.reduce((acc, value) => acc + value, 0);
  return sum / ranges.length;
}

module.exports = {
  normalizeChartResponse,
  mergeLivePrice,
  computeAtr
};
