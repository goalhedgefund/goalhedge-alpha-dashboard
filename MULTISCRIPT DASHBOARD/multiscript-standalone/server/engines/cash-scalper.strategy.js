'use strict';

const DEFAULT_COMBO = {
  intradayFrame: '5',
  weeklyFastEma: 10,
  weeklySlowEma: 30,
  dailyFastEma: 20,
  dailySlowEma: 50,
  entryFastEma: 9,
  entrySlowEma: 21,
  rsiPeriod: 14,
  rsiTrendMin: 52,
  rsiEntryMin: 48,
  rsiEntryMax: 68,
  bbPeriod: 20,
  bbStdDev: 2,
  pullbackPct: 0.35,
  stopPct: 0.65,
  targetPct: 1,
  minScore: 4,
  allowShort: false,
  maxEntryExtensionPct: 1.25,
  rsiHardMax: 76
};

const DEFAULT_GRID = [
  { entryFastEma: 9, entrySlowEma: 21, rsiEntryMin: 48, rsiEntryMax: 68, pullbackPct: 0.35, stopPct: 0.6, targetPct: 0.8 },
  { entryFastEma: 9, entrySlowEma: 21, rsiEntryMin: 50, rsiEntryMax: 70, pullbackPct: 0.45, stopPct: 0.7, targetPct: 1 },
  { entryFastEma: 13, entrySlowEma: 34, rsiEntryMin: 50, rsiEntryMax: 72, pullbackPct: 0.5, stopPct: 0.8, targetPct: 1.2 },
  { entryFastEma: 5, entrySlowEma: 20, rsiEntryMin: 46, rsiEntryMax: 66, pullbackPct: 0.3, stopPct: 0.55, targetPct: 0.7 }
];

function n(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function closeOf(candle) {
  return n(candle?.close ?? candle?.c);
}

function highOf(candle) {
  return n(candle?.high ?? candle?.h ?? closeOf(candle));
}

function lowOf(candle) {
  return n(candle?.low ?? candle?.l ?? closeOf(candle));
}

function tsOf(candle) {
  const ts = n(candle?.timestamp ?? candle?.ts ?? candle?.time);
  return ts < 1e12 ? ts * 1000 : ts;
}

function ema(values = [], period = 20) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    current = values[i] * k + current * (1 - k);
  }
  return current;
}

function rsi(values = [], period = 14) {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function bollinger(values = [], period = 20, stdDev = 2) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mid = slice.reduce((sum, value) => sum + value, 0) / period;
  const variance = slice.reduce((sum, value) => sum + ((value - mid) ** 2), 0) / period;
  const width = Math.sqrt(variance) * stdDev;
  return {
    lower: mid - width,
    mid,
    upper: mid + width,
    pctB: width ? (values[values.length - 1] - (mid - width)) / (2 * width) : 0.5
  };
}

function dayKey(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

function weekKey(ts) {
  const date = new Date(ts + 5.5 * 60 * 60 * 1000);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function aggregateBy(candles = [], keyFn) {
  const map = new Map();
  for (const candle of candles) {
    const ts = tsOf(candle);
    const key = keyFn(ts);
    const existing = map.get(key);
    const open = n(candle.open ?? candle.o ?? closeOf(candle));
    const high = highOf(candle);
    const low = lowOf(candle);
    const close = closeOf(candle);
    const volume = n(candle.volume ?? candle.v);
    if (!existing) {
      map.set(key, { timestamp: ts, open, high, low, close, volume });
    } else {
      existing.high = Math.max(existing.high, high);
      existing.low = Math.min(existing.low, low);
      existing.close = close;
      existing.volume += volume;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function scoreTrend(candles = [], combo = DEFAULT_COMBO, mode = 'daily') {
  const closes = candles.map(closeOf).filter((value) => value > 0);
  const fastPeriod = mode === 'weekly' ? combo.weeklyFastEma : combo.dailyFastEma;
  const slowPeriod = mode === 'weekly' ? combo.weeklySlowEma : combo.dailySlowEma;
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const currentRsi = rsi(closes, combo.rsiPeriod);
  const bb = bollinger(closes, combo.bbPeriod, combo.bbStdDev);
  const last = closes[closes.length - 1] || 0;
  if (!fast || !slow || !bb || !last) return { state: 'UNKNOWN', score: 0, fast, slow, rsi: currentRsi, bb, last };

  let bull = 0;
  let bear = 0;
  if (fast > slow) bull += 1; else bear += 1;
  if (last > fast) bull += 1; else bear += 1;
  if (last > bb.mid) bull += 1; else bear += 1;
  if (currentRsi >= combo.rsiTrendMin) bull += 1;
  if (currentRsi <= 100 - combo.rsiTrendMin) bear += 1;

  return {
    state: bull >= 3 && bull > bear ? 'UP' : bear >= 3 && bear > bull ? 'DOWN' : 'SIDEWAYS',
    score: bull - bear,
    fast,
    slow,
    rsi: currentRsi,
    bb,
    last
  };
}

function evaluateCashScalper({ intraday = [], daily = [], weekly = [], ltp = null, combo = {} }) {
  const cfg = { ...DEFAULT_COMBO, ...combo };
  const dailyCandles = daily.length ? daily : aggregateBy(intraday, dayKey);
  const weeklyCandles = weekly.length ? weekly : aggregateBy(dailyCandles, weekKey);
  const weeklyTrend = scoreTrend(weeklyCandles, cfg, 'weekly');
  const dailyTrend = scoreTrend(dailyCandles, cfg, 'daily');
  const closes = intraday.map(closeOf).filter((value) => value > 0);
  const last = n(ltp, closes[closes.length - 1] || 0);
  const fast = ema(closes, cfg.entryFastEma);
  const slow = ema(closes, cfg.entrySlowEma);
  const currentRsi = rsi(closes, cfg.rsiPeriod);
  const bb = bollinger(closes, cfg.bbPeriod, cfg.bbStdDev);

  let action = 'WAIT';
  let direction = 'NONE';
  let score = 0;
  const reasons = [];
  const longTrend = weeklyTrend.state === 'UP' && dailyTrend.state === 'UP';
  const shortTrend = weeklyTrend.state === 'DOWN' && dailyTrend.state === 'DOWN';
  const shortingAllowed = cfg.allowShort === true;
  const entryExtensionPct = fast && last > 0 ? ((last - fast) / fast) * 100 : 0;
  const longEntryHealthy = currentRsi <= cfg.rsiHardMax && entryExtensionPct <= cfg.maxEntryExtensionPct;

  if (longTrend) { score += 2; reasons.push('weekly+daily uptrend'); }
  if (shortTrend) { score -= 2; reasons.push('weekly+daily downtrend'); }
  if (fast && slow && fast > slow) { score += 1; reasons.push('intraday EMA bull'); }
  if (fast && slow && fast < slow) { score -= 1; reasons.push('intraday EMA bear'); }
  if (bb && last >= bb.mid && last <= bb.upper) { score += 1; reasons.push('price above BB mid'); }
  if (bb && last <= bb.mid && last >= bb.lower) { score -= 1; reasons.push('price below BB mid'); }
  if (currentRsi >= cfg.rsiEntryMin && currentRsi <= cfg.rsiEntryMax) { score += longTrend ? 1 : 0; reasons.push('RSI in long scalp zone'); }
  if (currentRsi <= (100 - cfg.rsiEntryMin) && currentRsi >= (100 - cfg.rsiEntryMax)) { score -= shortTrend ? 1 : 0; reasons.push('RSI in short scalp zone'); }

  const pullbackLevel = fast ? fast * (1 + cfg.pullbackPct / 100) : 0;
  if (!longEntryHealthy && longTrend) reasons.push('entry too extended for fresh inventory');

  if (longTrend && longEntryHealthy && score >= cfg.minScore && last > 0 && (!pullbackLevel || last <= pullbackLevel)) {
    action = 'BUY';
    direction = 'LONG';
  } else if (shortingAllowed && shortTrend && Math.abs(score) >= cfg.minScore && last > 0) {
    action = 'SHORT';
    direction = 'SHORT';
  }

  return {
    action,
    direction,
    score,
    reason: reasons.join(', ') || 'insufficient trend alignment',
    levels: {
      entry: last,
      bid: last > 0 ? last * (1 - cfg.pullbackPct / 100) : 0,
      target: last > 0 ? last * (1 + cfg.targetPct / 100) : 0,
      stop: last > 0 ? last * (1 - cfg.stopPct / 100) : 0,
      shortTarget: last > 0 ? last * (1 - cfg.targetPct / 100) : 0,
      shortStop: last > 0 ? last * (1 + cfg.stopPct / 100) : 0
    },
    indicators: {
      weeklyTrend,
      dailyTrend,
      intradayEmaFast: fast,
      intradayEmaSlow: slow,
      intradayRsi: currentRsi,
      intradayBb: bb,
      entryExtensionPct
    },
    combo: cfg
  };
}

module.exports = {
  DEFAULT_COMBO,
  DEFAULT_GRID,
  aggregateBy,
  dayKey,
  weekKey,
  ema,
  rsi,
  bollinger,
  evaluateCashScalper
};
