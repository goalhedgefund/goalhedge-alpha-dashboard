function sma(values, period) {
  if (!values.length) return 0;
  const slice = values.slice(-period);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / slice.length;
}

function slope(values, lookback = 5) {
  if (values.length < lookback + 1) return 0;
  return values[values.length - 1] - values[values.length - 1 - lookback];
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function normalizeCandles(candles = [], livePrice) {
  const closes = candles.map((candle) => Number(candle.close ?? candle.c ?? candle.ltp ?? 0)).filter(Number.isFinite);
  if (Number.isFinite(livePrice) && livePrice > 0) closes.push(livePrice);
  return closes;
}

function scoreSeries(candles = [], livePrice, config = {}) {
  const closes = normalizeCandles(candles, livePrice);
  if (closes.length < 8) {
    return {
      bull: 0,
      bear: 0,
      signal: 'WAIT',
      trend: 'flat'
    };
  }

  const fast = sma(closes, config.fastPeriod || 5);
  const slow = sma(closes, config.slowPeriod || 20);
  const prevFast = sma(closes.slice(0, -1), config.fastPeriod || 5);
  const prevSlow = sma(closes.slice(0, -1), config.slowPeriod || 20);
  const last = closes[closes.length - 1];
  const high = Math.max(...closes.slice(-Math.min(closes.length, 30)));
  const low = Math.min(...closes.slice(-Math.min(closes.length, 30)));
  const pos = (last - low) / Math.max(high - low, 1e-9);
  const slopeValue = slope(closes, config.slopeLookback || 5);
  const rsiValue = rsi(closes, config.rsiPeriod || 14);
  const vol = Math.max(1, closes.length);

  let bull = 0;
  let bear = 0;

  fast > slow ? bull += 1 : bear += 1;
  prevFast <= prevSlow && fast > slow ? bull += 1 : 0;
  slopeValue > 0 ? bull += 1 : bear += 1;
  last >= fast ? bull += 1 : bear += 1;
  pos >= 0.65 ? bull += 1 : pos <= 0.35 ? bear += 1 : 0;
  rsiValue >= 55 ? bull += 1 : rsiValue <= 45 ? bear += 1 : 0;
  closes[vol - 1] > closes[Math.max(0, vol - 6)] ? bull += 1 : bear += 1;
  closes[vol - 1] > closes[Math.max(0, vol - 12)] ? bull += 1 : bear += 1;

  const signal = bull >= (config.minScore || 6) && bull > bear
    ? 'LONG'
    : bear >= (config.minScore || 6) && bear > bull
      ? 'SHORT'
      : 'WAIT';

  return {
    bull,
    bear,
    signal,
    trend: signal === 'LONG' ? 'up' : signal === 'SHORT' ? 'down' : 'flat',
    indicators: {
      fast,
      slow,
      rsi: rsiValue,
      rangePosition: pos,
      slope: slopeValue,
      last
    }
  };
}

module.exports = { scoreSeries };
