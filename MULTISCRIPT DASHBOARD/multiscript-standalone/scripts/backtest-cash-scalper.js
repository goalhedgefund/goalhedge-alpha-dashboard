const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { env } = require('../server/config/env');
const { aggregateCandles } = require('../server/services/replay.repository');
const { DEFAULT_COMBO, DEFAULT_GRID, aggregateBy, dayKey, weekKey, evaluateCashScalper } = require('../server/engines/cash-scalper.strategy');

dotenv.config({ path: path.join(env.rootDir, '.env'), quiet: true });

const DHAN_BASE = process.env.DHAN_REST_URL || 'https://api.dhan.co';
const DEFAULT_HISTORY_DIR = path.join(env.dataDir, 'cash-scalper-history');
const DEFAULT_OUTPUT_FILE = path.join(env.dataDir, 'cash-scalper-backtest-results.json');
const DEFAULT_COMBOS_FILE = path.join(env.dataDir, 'cash-scalper-combos.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const SHORT_WINDOW_GRID = [
  { intradayFrame: '15', weeklyFastEma: 2, weeklySlowEma: 5, dailyFastEma: 5, dailySlowEma: 13, entryFastEma: 5, entrySlowEma: 13, bbPeriod: 5, minScore: 2, pullbackPct: 3, targetPct: 0.8, stopPct: 0.7, rsiEntryMin: 40, rsiEntryMax: 80 },
  { intradayFrame: '15', weeklyFastEma: 2, weeklySlowEma: 4, dailyFastEma: 3, dailySlowEma: 8, entryFastEma: 5, entrySlowEma: 13, bbPeriod: 5, minScore: 2, pullbackPct: 4, targetPct: 0.6, stopPct: 0.6, rsiEntryMin: 35, rsiEntryMax: 85 },
  { intradayFrame: '15', weeklyFastEma: 3, weeklySlowEma: 6, dailyFastEma: 5, dailySlowEma: 10, entryFastEma: 9, entrySlowEma: 21, bbPeriod: 5, minScore: 2, pullbackPct: 3, targetPct: 1, stopPct: 0.8, rsiEntryMin: 42, rsiEntryMax: 78 },
  { intradayFrame: '15', allowShort: false, weeklyFastEma: 2, weeklySlowEma: 5, dailyFastEma: 5, dailySlowEma: 13, entryFastEma: 5, entrySlowEma: 13, bbPeriod: 5, minScore: 2, pullbackPct: 3, targetPct: 0.8, stopPct: 0.7, rsiEntryMin: 40, rsiEntryMax: 80 },
  { intradayFrame: '15', allowShort: false, weeklyFastEma: 2, weeklySlowEma: 4, dailyFastEma: 3, dailySlowEma: 8, entryFastEma: 5, entrySlowEma: 13, bbPeriod: 5, minScore: 2, pullbackPct: 4, targetPct: 0.6, stopPct: 0.6, rsiEntryMin: 35, rsiEntryMax: 85 },
  { intradayFrame: '15', allowShort: false, weeklyFastEma: 3, weeklySlowEma: 6, dailyFastEma: 5, dailySlowEma: 10, entryFastEma: 9, entrySlowEma: 21, bbPeriod: 5, minScore: 2, pullbackPct: 3, targetPct: 1, stopPct: 0.8, rsiEntryMin: 42, rsiEntryMax: 78 }
];

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function istDate(date) {
  const d = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function financialYearRanges(count = 3, anchor = new Date()) {
  const ist = new Date(anchor.getTime() + 5.5 * 60 * 60 * 1000);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const currentFyStart = month >= 4 ? year : year - 1;
  const ranges = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    const start = currentFyStart - offset;
    ranges.push({
      key: `FY${start}-${String(start + 1).slice(-2)}`,
      from: `${start}-04-01`,
      to: `${start + 1}-03-31`
    });
  }
  return ranges;
}

function parseArgs(argv) {
  const out = {
    force: false,
    noFetch: false,
    months: 0,
    from: '',
    to: ''
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--force') out.force = true;
    else if (arg === '--no-fetch') out.noFetch = true;
    else if (arg === '--months') out.months = Number(next() || 0);
    else if (arg.startsWith('--months=')) out.months = Number(arg.split('=')[1] || 0);
    else if (arg === '--from') out.from = next();
    else if (arg.startsWith('--from=')) out.from = arg.split('=')[1] || '';
    else if (arg === '--to') out.to = next();
    else if (arg.startsWith('--to=')) out.to = arg.split('=')[1] || '';
  }
  return out;
}

function monthRange(months, anchor = new Date()) {
  const to = istDate(anchor);
  const fromDate = new Date(anchor.getTime());
  fromDate.setMonth(fromDate.getMonth() - months);
  return [{ key: `LAST_${months}M`, from: istDate(fromDate), to }];
}

function splitDateRange(from, to, chunkDays = 60) {
  const chunks = [];
  let cursor = new Date(`${from}T00:00:00+05:30`).getTime();
  const end = new Date(`${to}T23:59:59+05:30`).getTime();
  while (cursor <= end) {
    const chunkEnd = Math.min(end, cursor + (chunkDays - 1) * DAY_MS);
    chunks.push({
      from: istDate(new Date(cursor)),
      to: istDate(new Date(chunkEnd))
    });
    cursor = chunkEnd + DAY_MS;
  }
  return chunks;
}

function dateSpanDays(from, to) {
  const start = new Date(`${from}T00:00:00+05:30`).getTime();
  const end = new Date(`${to}T23:59:59+05:30`).getTime();
  return Math.max(1, Math.ceil((end - start + 1) / DAY_MS));
}

function candleFile(historyDir, symbol) {
  return path.join(historyDir, `${symbol}_1m.json`);
}

function normalizeDhanCandles(raw = {}) {
  const open = raw.open || raw.data?.open || [];
  const high = raw.high || raw.data?.high || [];
  const low = raw.low || raw.data?.low || [];
  const close = raw.close || raw.data?.close || [];
  const volume = raw.volume || raw.data?.volume || [];
  const timestamp = raw.timestamp || raw.data?.timestamp || [];
  const size = Math.min(open.length, high.length, low.length, close.length, timestamp.length);
  const out = [];
  for (let i = 0; i < size; i += 1) {
    const ts = Number(timestamp[i]);
    const tsMs = ts < 1e12 ? ts * 1000 : ts;
    out.push({
      ts: tsMs,
      o: Number(open[i]),
      h: Number(high[i]),
      l: Number(low[i]),
      c: Number(close[i]),
      v: Number(volume[i] || 0)
    });
  }
  return out.filter((c) => c.ts > 0 && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0);
}

function mergeCandles(existing = [], fresh = []) {
  const map = new Map();
  for (const candle of [...existing, ...fresh]) map.set(Number(candle.ts), candle);
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

function emaRange(values = [], start = 0, end = values.length, period = 20) {
  const len = Math.max(0, end - start);
  if (len < period) return null;
  const k = 2 / (period + 1);
  let current = 0;
  for (let i = start; i < start + period; i += 1) current += Number(values[i] || 0);
  current /= period;
  for (let i = start + period; i < end; i += 1) {
    current = Number(values[i] || 0) * k + current * (1 - k);
  }
  return current;
}

function rsiRange(values = [], start = 0, end = values.length, period = 14) {
  const len = Math.max(0, end - start);
  if (len <= period) return 50;
  let gains = 0;
  let losses = 0;
  const begin = Math.max(start + 1, end - period);
  for (let i = begin; i < end; i += 1) {
    const diff = Number(values[i] || 0) - Number(values[i - 1] || 0);
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function bollingerRange(values = [], start = 0, end = values.length, period = 20, stdDev = 2) {
  const len = Math.max(0, end - start);
  if (len < period) return null;
  const sliceStart = end - period;
  let sum = 0;
  for (let i = sliceStart; i < end; i += 1) sum += Number(values[i] || 0);
  const mid = sum / period;
  let variance = 0;
  for (let i = sliceStart; i < end; i += 1) {
    const diff = Number(values[i] || 0) - mid;
    variance += diff * diff;
  }
  const width = Math.sqrt(variance / period) * stdDev;
  const last = Number(values[end - 1] || 0);
  return {
    lower: mid - width,
    mid,
    upper: mid + width,
    pctB: width ? (last - (mid - width)) / (2 * width) : 0.5
  };
}

function evaluateWindow({
  intradayCloses = [],
  intradayEnd = 0,
  dailyCloses = [],
  dailyEnd = 0,
  weeklyCloses = [],
  weeklyEnd = 0,
  ltp = 0,
  combo = {}
}) {
  const cfg = { ...DEFAULT_COMBO, ...combo };
  const weeklyTrend = scoreTrendFromCloses(weeklyCloses, weeklyEnd, cfg, 'weekly');
  const dailyTrend = scoreTrendFromCloses(dailyCloses, dailyEnd, cfg, 'daily');
  const fast = emaRange(intradayCloses, Math.max(0, intradayEnd - 180), intradayEnd, cfg.entryFastEma);
  const slow = emaRange(intradayCloses, Math.max(0, intradayEnd - 180), intradayEnd, cfg.entrySlowEma);
  const currentRsi = rsiRange(intradayCloses, Math.max(0, intradayEnd - 180), intradayEnd, cfg.rsiPeriod);
  const bb = bollingerRange(intradayCloses, Math.max(0, intradayEnd - 180), intradayEnd, cfg.bbPeriod, cfg.bbStdDev);
  const last = Number(ltp || intradayCloses[intradayEnd - 1] || 0);

  let action = 'WAIT';
  let direction = 'NONE';
  let score = 0;
  const reasons = [];
  const longTrend = weeklyTrend.state === 'UP' && dailyTrend.state === 'UP';
  const shortTrend = weeklyTrend.state === 'DOWN' && dailyTrend.state === 'DOWN';

  if (longTrend) { score += 2; reasons.push('weekly+daily uptrend'); }
  if (shortTrend) { score -= 2; reasons.push('weekly+daily downtrend'); }
  if (fast && slow && fast > slow) { score += 1; reasons.push('intraday EMA bull'); }
  if (fast && slow && fast < slow) { score -= 1; reasons.push('intraday EMA bear'); }
  if (bb && last >= bb.mid && last <= bb.upper) { score += 1; reasons.push('price above BB mid'); }
  if (bb && last <= bb.mid && last >= bb.lower) { score -= 1; reasons.push('price below BB mid'); }
  if (currentRsi >= cfg.rsiEntryMin && currentRsi <= cfg.rsiEntryMax) { score += longTrend ? 1 : 0; reasons.push('RSI in long scalp zone'); }
  if (currentRsi <= (100 - cfg.rsiEntryMin) && currentRsi >= (100 - cfg.rsiEntryMax)) { score -= shortTrend ? 1 : 0; reasons.push('RSI in short scalp zone'); }

  const pullbackLevel = fast ? fast * (1 + cfg.pullbackPct / 100) : 0;
  if (longTrend && score >= cfg.minScore && last > 0 && (!pullbackLevel || last <= pullbackLevel)) {
    action = 'BUY';
    direction = 'LONG';
  } else if (shortTrend && Math.abs(score) >= cfg.minScore && last > 0) {
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
      intradayBb: bb
    },
    combo: cfg
  };
}

function scoreTrendFromCloses(closes = [], end = closes.length, combo = DEFAULT_COMBO, mode = 'daily') {
  const fastPeriod = mode === 'weekly' ? combo.weeklyFastEma : combo.dailyFastEma;
  const slowPeriod = mode === 'weekly' ? combo.weeklySlowEma : combo.dailySlowEma;
  const fast = emaRange(closes, Math.max(0, end - 120), end, fastPeriod);
  const slow = emaRange(closes, Math.max(0, end - 120), end, slowPeriod);
  const currentRsi = rsiRange(closes, Math.max(0, end - 120), end, combo.rsiPeriod);
  const bb = bollingerRange(closes, Math.max(0, end - 120), end, combo.bbPeriod, combo.bbStdDev);
  const last = Number(closes[end - 1] || 0);
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

async function postDhanIntraday(symbolRow, fromDate, toDate, interval = '1') {
  const clientId = process.env.DHAN_CLIENT_ID || '';
  const token = process.env.DHAN_ACCESS_TOKEN || '';
  if (!clientId || !token) throw new Error('Missing DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN in .env');
  const body = {
    securityId: String(symbolRow.securityId),
    exchangeSegment: symbolRow.exchangeSegment || 'NSE_EQ',
    instrument: 'EQUITY',
    interval: String(interval),
    oi: false,
    fromDate,
    toDate
  };
  const res = await fetch(`${DHAN_BASE}/v2/charts/intraday`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'client-id': clientId,
      'access-token': token
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Dhan ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return normalizeDhanCandles(data);
}

async function fetchSymbolHistory(symbolRow, ranges, { force = false, delayMs = 650, historyDir = DEFAULT_HISTORY_DIR } = {}) {
  fs.mkdirSync(historyDir, { recursive: true });
  const file = candleFile(historyDir, symbolRow.symbol);
  const cached = force ? { candles: [] } : readJson(file, { candles: [] });
  let candles = Array.isArray(cached.candles) ? cached.candles : [];
  const requestedFrom = ranges[0].from;
  const requestedTo = ranges[ranges.length - 1].to;
  const chunks = splitDateRange(requestedFrom, requestedTo, 60);
  const existingKeys = new Set(candles.map((c) => istDate(new Date(c.ts))));
  const fetched = [];
  const errors = [];

  for (const chunk of chunks) {
    const chunkDays = splitDateRange(chunk.from, chunk.to, 1).map((d) => d.from);
    const covered = chunkDays.every((d) => existingKeys.has(d));
    if (covered && !force) continue;
    try {
      console.log(`[${symbolRow.symbol}] fetching ${chunk.from}..${chunk.to}`);
      const fresh = await postDhanIntraday(symbolRow, chunk.from, chunk.to, '1');
      console.log(`[${symbolRow.symbol}] received ${fresh.length} candles`);
      fetched.push(...fresh);
      candles = mergeCandles(candles, fresh);
      writeJson(file, {
        symbol: symbolRow,
        source: 'Dhan intraday 1m',
        updatedAt: new Date().toISOString(),
        requestedFrom,
        requestedTo,
        candles
      });
      await sleep(delayMs);
    } catch (err) {
      errors.push({ from: chunk.from, to: chunk.to, message: err.message, status: err.status || null });
      if (err.status === 401 || err.status === 403) break;
      await sleep(Math.max(delayMs, 1500));
    }
  }

  return {
    file,
    candles,
    fetchedCount: fetched.length,
    errors
  };
}

function istMinute(ts) {
  const date = new Date(ts + 5.5 * 60 * 60 * 1000);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function istMonth(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date(ts));
}

function simulate({ symbol, candles1m, combo, scriptLimit, tradeSizePct }) {
  const frame = combo.intradayFrame || '15';
  const intraday = aggregateCandles(candles1m, frame).map((c) => ({ timestamp: c.ts, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }));
  const daily = aggregateBy(candles1m.map((c) => ({ timestamp: c.ts, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v })), dayKey);
  const weekly = aggregateBy(daily, weekKey);
  const intradayCloses = intraday.map((bar) => bar.close);
  const dailyCloses = daily.map((bar) => bar.close);
  const weeklyCloses = weekly.map((bar) => bar.close);
  const maxTradeValue = Number(scriptLimit) * (Number(tradeSizePct) / 100);
  const squareOffMinute = 15 * 60 + 20;
  const costsPct = 0.0012;
  const monthlyTrades = {};
  let longQty = 0;
  let longAvg = 0;
  let shortTrade = null;
  let realized = 0;
  let trades = 0;
  let wins = 0;
  let positionalPnl = 0;
  let intradayPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let dailyCursor = 0;
  let weeklyCursor = 0;
  let lastBuyDay = '';
  let currentMonth = '';
  let monthStartEquity = 0;
  const monthRows = [];

  function book(ts, pnl) {
    const month = istMonth(ts);
    monthlyTrades[month] = monthlyTrades[month] || { realized: 0, trades: 0, wins: 0 };
    monthlyTrades[month].realized += pnl;
    monthlyTrades[month].trades += 1;
    if (pnl > 0) monthlyTrades[month].wins += 1;
    realized += pnl;
    trades += 1;
    if (pnl > 0) wins += 1;
  }

  function equity(price) {
    const longMtm = longQty > 0 ? (price - longAvg) * longQty : 0;
    const shortMtm = shortTrade ? (shortTrade.entry - price) * shortTrade.qty : 0;
    return realized + longMtm + shortMtm;
  }

  function updateDrawdown(price) {
    const eq = equity(price);
    peak = Math.max(peak, eq);
    maxDrawdown = Math.min(maxDrawdown, eq - peak);
  }

  function closeMonthIfNeeded(ts, price) {
    const month = istMonth(ts);
    if (!currentMonth) {
      currentMonth = month;
      monthStartEquity = equity(price);
      return;
    }
    if (month === currentMonth) return;
    const endEquity = equity(price);
    const row = monthlyTrades[currentMonth] || { realized: 0, trades: 0, wins: 0 };
    monthRows.push({
      month: currentMonth,
      pnl: round2(endEquity - monthStartEquity),
      realized: round2(row.realized),
      alphaPct: round2(((endEquity - monthStartEquity) / Math.max(1, scriptLimit)) * 100),
      trades: row.trades,
      winRate: row.trades ? round2((row.wins / row.trades) * 100) : 0
    });
    currentMonth = month;
    monthStartEquity = endEquity;
  }

  function finaliseMonth(price) {
    if (!currentMonth) return;
    const endEquity = equity(price);
    const row = monthlyTrades[currentMonth] || { realized: 0, trades: 0, wins: 0 };
    monthRows.push({
      month: currentMonth,
      pnl: round2(endEquity - monthStartEquity),
      realized: round2(row.realized),
      alphaPct: round2(((endEquity - monthStartEquity) / Math.max(1, scriptLimit)) * 100),
      trades: row.trades,
      winRate: row.trades ? round2((row.wins / row.trades) * 100) : 0
    });
  }

  function dayOf(ts) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
  }

  function maxQtyAt(price) {
    return Math.max(1, Math.floor(maxTradeValue / price));
  }

  function addLong(price, qty) {
    const nextCost = longAvg * longQty + price * qty * (1 + costsPct);
    longQty += qty;
    longAvg = longQty > 0 ? nextCost / longQty : 0;
  }

  function sellLong(ts, price, qty) {
    const exitValue = price * qty * (1 - costsPct);
    const costBasis = longAvg * qty;
    const pnl = round2(exitValue - costBasis);
    if (pnl <= 0) return false;
    longQty -= qty;
    if (longQty <= 0) {
      longQty = 0;
      longAvg = 0;
    }
    book(ts, pnl);
    positionalPnl += pnl;
    return true;
  }

  for (let i = 80; i < intraday.length; i += 1) {
    const bar = intraday[i];
    const price = bar.close;
    if (!price) continue;
    closeMonthIfNeeded(bar.timestamp, price);
    while (dailyCursor < daily.length && daily[dailyCursor].timestamp < bar.timestamp) dailyCursor += 1;
    while (weeklyCursor < weekly.length && weekly[weeklyCursor].timestamp < bar.timestamp) weeklyCursor += 1;

    if (longQty > 0) {
      const sellTrigger = longAvg * (1 + combo.targetPct / 100 + costsPct);
      if (bar.high >= sellTrigger) {
        sellLong(bar.timestamp, sellTrigger, Math.min(longQty, maxQtyAt(sellTrigger)));
      }
    }

    if (shortTrade) {
      let exit = null;
      if (bar.high >= shortTrade.stop) exit = shortTrade.stop;
      else if (bar.low <= shortTrade.target) exit = shortTrade.target;
      else if (istMinute(bar.timestamp) >= squareOffMinute) exit = price;
      if (exit) {
        const pnl = round2((shortTrade.entry - exit) * shortTrade.qty - exit * shortTrade.qty * costsPct);
        book(bar.timestamp, pnl);
        intradayPnl += pnl;
        shortTrade = null;
      }
    }

    if (shortTrade) {
      updateDrawdown(price);
      continue;
    }

    const signal = evaluateWindow({
      intradayCloses,
      intradayEnd: i + 1,
      dailyCloses,
      dailyEnd: dailyCursor,
      weeklyCloses,
      weeklyEnd: weeklyCursor,
      ltp: price,
      combo
    });
    const today = dayOf(bar.timestamp);
    const longCapacity = Math.max(0, scriptLimit - longQty * price);
    if (signal.action === 'BUY' && today !== lastBuyDay && longCapacity >= price) {
      const qty = Math.min(maxQtyAt(price), Math.floor(longCapacity / price));
      if (qty > 0) {
        addLong(price, qty);
        lastBuyDay = today;
      }
    } else if (combo.allowShort !== false && signal.action === 'SHORT' && longQty === 0 && istMinute(bar.timestamp) < squareOffMinute) {
      const qty = maxQtyAt(price);
      shortTrade = {
        entry: price * (1 - costsPct),
        qty,
        target: price * (1 - combo.targetPct / 100),
        stop: price * (1 + combo.stopPct / 100)
      };
    }
    updateDrawdown(price);
  }

  const lastPrice = intraday[intraday.length - 1]?.close || 0;
  finaliseMonth(lastPrice);
  const totalEquity = round2(equity(lastPrice));
  const positiveMonths = monthRows.filter((row) => row.pnl > 0).length;
  return {
    pnl: totalEquity,
    realized: round2(realized),
    unrealized: round2(totalEquity - realized),
    positionalPnl: round2(positionalPnl),
    intradayPnl: round2(intradayPnl),
    alphaPct: round2((totalEquity / Math.max(1, scriptLimit)) * 100),
    trades,
    winRate: trades ? round2((wins / trades) * 100) : 0,
    maxDrawdown: round2(maxDrawdown),
    positiveMonths,
    months: monthRows.length,
    endingLongQty: longQty,
    endingLongAvg: round2(longAvg),
    monthly: monthRows,
    score: round2(totalEquity + maxDrawdown * 0.25 + positiveMonths * 150 - Math.max(0, 3 - trades) * 50)
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const force = args.force;
  const noFetch = args.noFetch;
  const historyDir = args.months ? path.join(env.dataDir, `cash-scalper-history-${args.months}m`) : DEFAULT_HISTORY_DIR;
  const rangeTag = args.from && args.to ? `${args.from}-to-${args.to}` : '';
  const outputFile = args.months
    ? path.join(env.dataDir, `cash-scalper-backtest-${args.months}m-results.json`)
    : rangeTag
      ? path.join(env.dataDir, `cash-scalper-backtest-${rangeTag}.json`)
      : DEFAULT_OUTPUT_FILE;
  const combosFile = args.months
    ? path.join(env.dataDir, `cash-scalper-combos-${args.months}m.json`)
    : rangeTag
      ? path.join(env.dataDir, `cash-scalper-combos-${rangeTag}.json`)
      : DEFAULT_COMBOS_FILE;
  const cash = readJson(path.join(env.dataDir, 'cash-scalper.json'), { settings: {}, symbols: [] });
  const symbols = (cash.symbols || []).filter((row) => row.enabled !== false);
  if (!symbols.length) throw new Error('No cash scalper symbols configured.');
  const ranges = args.from && args.to
    ? [{ key: 'CUSTOM', from: args.from, to: args.to }]
    : args.months
      ? monthRange(args.months)
      : financialYearRanges(3);
  const output = {
    generatedAt: new Date().toISOString(),
    financialYears: ranges,
    mode: noFetch ? 'cache-only' : 'dhan-fetch-and-cache',
    settings: cash.settings,
    symbols: {},
    reports: {}
  };

  for (const symbolRow of symbols) {
    console.log(`[${symbolRow.symbol}] preparing 1m history...`);
    let history;
    if (noFetch) {
      history = readJson(candleFile(historyDir, symbolRow.symbol), { candles: [], errors: [] });
      history = { candles: history.candles || [], fetchedCount: 0, errors: [] };
    } else {
      history = await fetchSymbolHistory(symbolRow, ranges, { force, historyDir });
    }
    const candles = (history.candles || []).filter((c) => c.ts >= new Date(`${ranges[0].from}T00:00:00+05:30`).getTime() && c.ts <= new Date(`${ranges[ranges.length - 1].to}T23:59:59+05:30`).getTime());
    if (candles.length < 1000) {
      output.reports[symbolRow.symbol] = {
        skipped: true,
        reason: `Insufficient 1m candles (${candles.length})`,
        fetchedCount: history.fetchedCount || 0,
        errors: history.errors || []
      };
      console.log(`[${symbolRow.symbol}] skipped: only ${candles.length} candles`);
      continue;
    }

    const useShortGrid = args.months || dateSpanDays(ranges[0].from, ranges[ranges.length - 1].to) <= 120;
    const gridSource = useShortGrid ? SHORT_WINDOW_GRID : DEFAULT_GRID;
    const grid = gridSource.map((combo) => ({ ...DEFAULT_COMBO, ...combo, intradayFrame: '15' }));
    let best = null;
    const tested = [];
    for (const combo of grid) {
      const result = simulate({
        symbol: symbolRow.symbol,
        candles1m: candles,
        combo,
        scriptLimit: Number(symbolRow.scriptLimit || cash.settings.inventoryLimit || 100000),
        tradeSizePct: Number(cash.settings.tradeSizePct || 10)
      });
      tested.push({ combo, result });
      if (!best || result.score > best.result.score) best = { combo, result };
    }
    output.symbols[symbolRow.symbol] = {
      ...best.combo,
      enabled: best.result.pnl > 0 && best.result.trades > 0,
      optimizedFrom: args.months ? `${args.months}m` : 'financial-years'
    };
    output.reports[symbolRow.symbol] = {
      securityId: symbolRow.securityId,
      scriptLimit: symbolRow.scriptLimit,
      candleCount: candles.length,
      fetchedCount: history.fetchedCount || 0,
      errors: history.errors || [],
      best: best.result,
      tested
    };
    console.log(`[${symbolRow.symbol}] best pnl=${best.result.pnl} alpha=${best.result.alphaPct}% trades=${best.result.trades} win=${best.result.winRate}% months=${best.result.positiveMonths}/${best.result.months}`);
  }

  writeJson(outputFile, output);
  writeJson(combosFile, {
    generatedAt: output.generatedAt,
    source: outputFile,
    symbols: output.symbols
  });
  if (args.months) {
    writeJson(DEFAULT_COMBOS_FILE, {
      generatedAt: output.generatedAt,
      source: outputFile,
      symbols: output.symbols
    });
  }
  console.log(`Saved results: ${outputFile}`);
  console.log(`Saved combos: ${combosFile}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
