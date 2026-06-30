#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parse } = require('csv-parse/sync');
const { summarize, precomputeIndicators } = require('../server/lib/simulate');
const { optimize } = require('../server/lib/optimizer');
const { DEFAULT_THRESHOLDS } = require('../server/lib/indicators');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MASTER_CSV = path.join(DATA_DIR, 'api-scrip-master.csv');
const DEFAULT_CONFIG_FILE = path.join(DATA_DIR, 'symbol-configs.json');
const DEFAULT_OUT_DIR = path.join(DATA_DIR, 'futures-eligible-cash-candles');
const UNIVERSE_DIR = path.join(DATA_DIR, 'universes');
const DHAN_BASE = 'https://api.dhan.co';
const DEFAULT_MAX_FUT_EXPIRY_DAYS = 120;
const DEFAULT_INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY'];
const DEFAULT_RETRIES = 4;
const DEFAULT_TIMEFRAMES = ['1', '5', '15', '60', 'D'];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const INTRADAY_TIMEFRAMES = new Set(['1', '5', '15']);
const LAST_INTRADAY_ENTRY_MINUTE = (15 * 60) + 15;
const INTRADAY_SQUARE_OFF_MINUTE = (15 * 60) + 25;
const _ohlcPrecomputeCache = new WeakMap();

function parseArgs(argv) {
  const args = {
    symbol: '',
    symbols: [],
    file: '',
    universe: '',
    all: false,
    limit: 0,
    maxFutExpiryDays: DEFAULT_MAX_FUT_EXPIRY_DAYS,
    years: 3,
    months: 0,
    days: 0,
    outDir: DEFAULT_OUT_DIR,
    downloadOnly: false,
    resumeFromCache: false,
    writeConfig: false,
    delayMs: 1200,
    retries: DEFAULT_RETRIES,
    useCache: false,
    timeframes: DEFAULT_TIMEFRAMES,
    targetRR: 3.0,
    configFile: DEFAULT_CONFIG_FILE,
    fromDate: '',
    toDate: new Date().toISOString().slice(0, 10)
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--symbol') args.symbol = String(next() || '').toUpperCase();
    else if (a === '--symbols') args.symbols = parseSymbolList(next() || '');
    else if (a === '--file') args.file = path.resolve(next() || '');
    else if (a === '--universe') args.universe = String(next() || '').toUpperCase();
    else if (a === '--all') args.all = true;
    else if (a === '--limit') args.limit = Number(next()) || 0;
    else if (a === '--max-fut-expiry-days') args.maxFutExpiryDays = Number(next()) || args.maxFutExpiryDays;
    else if (a === '--years') args.years = Number(next()) || args.years;
    else if (a === '--months') args.months = Number(next()) || args.months;
    else if (a === '--days') args.days = Number(next()) || args.days;
    else if (a === '--out') args.outDir = path.resolve(next() || args.outDir);
    else if (a === '--download-only') args.downloadOnly = true;
    else if (a === '--resume-from-cache' || a === '--incremental') args.resumeFromCache = true;
    else if (a === '--write-config') args.writeConfig = true;
    else if (a === '--delay-ms') args.delayMs = Number(next()) || args.delayMs;
    else if (a === '--retries') args.retries = Number(next()) || args.retries;
    else if (a === '--use-cache') args.useCache = true;
    else if (a === '--timeframes') args.timeframes = parseTimeframes(next() || '');
    else if (a === '--target-rr') args.targetRR = Number(next()) || args.targetRR;
    else if (a === '--config-file') args.configFile = path.resolve(next() || args.configFile);
    else if (a === '--from') args.fromDate = String(next() || '');
    else if (a === '--to') args.toDate = String(next() || args.toDate);
    else if (a === '--help') args.help = true;
  }
  if (!args.fromDate && args.days > 0) {
    const d = new Date(args.toDate);
    d.setDate(d.getDate() - Math.max(0, args.days - 1));
    args.fromDate = d.toISOString().slice(0, 10);
  }
  if (!args.fromDate && args.months > 0) {
    const d = new Date(args.toDate);
    d.setMonth(d.getMonth() - args.months);
    args.fromDate = d.toISOString().slice(0, 10);
  }
  if (!args.fromDate) {
    const d = new Date(args.toDate);
    d.setFullYear(d.getFullYear() - args.years);
    args.fromDate = d.toISOString().slice(0, 10);
  }
  return args;
}

function usage() {
  return `
Usage:
  node scripts/futures-bulk-optimize.js --symbol RELIANCE --write-config
  node scripts/futures-bulk-optimize.js --symbols RELIANCE,SBIN,TCS --write-config
  node scripts/futures-bulk-optimize.js --file D:\\CODEX\\data\\my-symbols.csv --write-config
  node scripts/futures-bulk-optimize.js --universe NIFTY500 --write-config
  node scripts/futures-bulk-optimize.js --all --write-config

Options:
  --symbol RELIANCE              Test/run one cash symbol.
  --symbols RELIANCE,SBIN        Comma-separated cash symbols.
  --file PATH                    Text/CSV/JSON file containing cash symbols.
  --universe FUTSTK              Futures-eligible cash stocks from the Dhan master.
                                  Includes NIFTY and BANKNIFTY indexes.
  --universe NIFTY500            Local universe file from data/universes.
  --universe ALL_EQ              All NSE cash EQ symbols from the Dhan master.
  --all                          Same as --universe FUTSTK.
  --limit 5                      Process only first N selected symbols.
  --max-fut-expiry-days 120      Ignore far-future/test FUTSTK contracts.
  --years 3                      Lookback years. Default: 3.
  --months 3                     Lookback months. Overrides --years if --from is not set.
  --days 5                       Lookback calendar days. Overrides --months/--years if --from is not set.
  --from YYYY-MM-DD              Override start date.
  --to YYYY-MM-DD                Override end date. Default: today.
  --out PATH                     Candle output folder. Default: data/futures-eligible-cash-candles.
  --write-config                 Save optimized configs into data/symbol-configs.json.
  --delay-ms 1200                Delay between Dhan calls.
  --retries 4                    Retry transient Dhan errors per candle chunk.
  --use-cache                    Reuse existing *_1m.json files instead of downloading.
  --timeframes 1,5,15,60,D       Timeframes to optimize. Default: 1,5,15,60,D.
  --target-rr 3                  Reward:risk target. Default: 3.
  --config-file PATH             Output config file. Default: data/symbol-configs.json.

Safety:
  Without --all or --universe, this never launches a broad universe.
  Without --write-config, it downloads/tests but does not update symbol-configs.json.
  For data-only jobs, use: node scripts/download-candles.js
`.trim();
}

function parseSymbolList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

function parseTimeframes(value) {
  const allowed = new Set(DEFAULT_TIMEFRAMES);
  const parsed = String(value || '')
    .split(/[,\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .map(s => (s === '1D' || s === 'DAY' || s === 'DAILY') ? 'D' : s);
  const valid = parsed.filter(tf => allowed.has(tf));
  return valid.length ? [...new Set(valid)] : DEFAULT_TIMEFRAMES;
}

function readEnv() {
  const envPath = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function readMasterRows() {
  if (!fs.existsSync(MASTER_CSV)) {
    throw new Error(`Missing Dhan master CSV: ${MASTER_CSV}. Start the app once so it downloads the file.`);
  }
  const raw = fs.readFileSync(MASTER_CSV, 'utf8');
  return parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true });
}

function readFuturesEligibility(rows, maxExpiryDays = DEFAULT_MAX_FUT_EXPIRY_DAYS) {
  const now = Date.now();
  const maxExpiryMs = now + (maxExpiryDays * 24 * 60 * 60 * 1000);
  const futures = rows
    .filter(r => r.SEM_EXM_EXCH_ID === 'NSE')
    .filter(r => r.SEM_SEGMENT === 'D')
    .filter(r => r.SEM_INSTRUMENT_NAME === 'FUTSTK')
    .filter(r => r.SEM_EXCH_INSTRUMENT_TYPE === 'FUT')
    .map(r => ({
      underlying: parseUnderlying(r.SEM_TRADING_SYMBOL),
      futuresTradingSymbol: r.SEM_TRADING_SYMBOL,
      futuresSecurityId: String(r.SEM_SMST_SECURITY_ID),
      expiryCode: Number(r.SEM_EXPIRY_CODE) || 0,
      expiryDate: r.SEM_EXPIRY_DATE,
      lotSize: Number(r.SEM_LOT_UNITS) || 0
    }))
    .filter(r => r.underlying && !isTestSymbol(r.underlying) && !isTestSymbol(r.futuresTradingSymbol))
    .filter(r => {
      const expiryMs = Date.parse(r.expiryDate);
      return expiryMs >= now && expiryMs <= maxExpiryMs;
    })
    .sort((a, b) => Date.parse(a.expiryDate) - Date.parse(b.expiryDate));

  const nearestFutureByUnderlying = new Map();
  for (const f of futures) {
    if (!nearestFutureByUnderlying.has(f.underlying)) nearestFutureByUnderlying.set(f.underlying, f);
  }
  return nearestFutureByUnderlying;
}

function readCashMaster(rows, eligibilityByUnderlying = new Map()) {
  const cashBySymbol = new Map();
  for (const r of rows) {
    if (r.SEM_EXM_EXCH_ID !== 'NSE') continue;
    if (r.SEM_SEGMENT !== 'E') continue;
    if (r.SEM_INSTRUMENT_NAME !== 'EQUITY') continue;
    if (r.SEM_SERIES && r.SEM_SERIES !== 'EQ') continue;
    const symbol = String(r.SEM_TRADING_SYMBOL || '').toUpperCase();
    if (!symbol) continue;
    if (isTestSymbol(symbol)) continue;
    cashBySymbol.set(symbol, {
      underlying: symbol,
      tradingSymbol: symbol,
      customSymbol: r.SEM_CUSTOM_SYMBOL,
      securityId: String(r.SEM_SMST_SECURITY_ID),
      exchange: 'NSE_EQ',
      instrument: 'EQUITY',
      series: r.SEM_SERIES || 'EQ',
      symbolName: r.SM_SYMBOL_NAME || '',
      eligibility: eligibilityByUnderlying.get(symbol) || null
    });
  }
  return cashBySymbol;
}

function readIndexMaster(rows) {
  const indexBySymbol = new Map();
  for (const r of rows) {
    if (r.SEM_EXM_EXCH_ID !== 'NSE') continue;
    if (r.SEM_INSTRUMENT_NAME !== 'INDEX') continue;
    const symbol = normalizeIndexSymbol(r.SEM_TRADING_SYMBOL);
    if (!symbol) continue;
    indexBySymbol.set(symbol, {
      underlying: symbol,
      tradingSymbol: symbol,
      customSymbol: r.SEM_CUSTOM_SYMBOL,
      securityId: String(r.SEM_SMST_SECURITY_ID),
      exchange: 'IDX_I',
      instrument: 'INDEX',
      series: r.SEM_SERIES || 'X',
      symbolName: r.SM_SYMBOL_NAME || symbol,
      eligibility: null,
      isIndex: true
    });
  }
  return indexBySymbol;
}

function normalizeIndexSymbol(symbol) {
  const value = String(symbol || '').trim().toUpperCase();
  if (value === 'NIFTY' || value === 'NIFTY 50') return 'NIFTY';
  if (value === 'BANKNIFTY' || value === 'NIFTY BANK') return 'BANKNIFTY';
  return value;
}

function readUniverseSymbols(universe) {
  const key = String(universe || '').toUpperCase();
  const candidates = [
    path.join(UNIVERSE_DIR, `${key}.txt`),
    path.join(UNIVERSE_DIR, `${key}.csv`),
    path.join(UNIVERSE_DIR, `${key}.json`),
    path.join(UNIVERSE_DIR, `${key.toLowerCase()}.txt`),
    path.join(UNIVERSE_DIR, `${key.toLowerCase()}.csv`),
    path.join(UNIVERSE_DIR, `${key.toLowerCase()}.json`),
    path.join(DATA_DIR, `${key}.txt`),
    path.join(DATA_DIR, `${key}.csv`),
    path.join(DATA_DIR, `${key}.json`)
  ];
  const file = candidates.find(p => fs.existsSync(p));
  if (!file) {
    throw new Error(`Universe ${key} needs a local symbol file. Put it at ${path.join(UNIVERSE_DIR, `${key}.csv`)} with one symbol per line or a SYMBOL column.`);
  }
  return readSymbolsFromFile(file);
}

function readSymbolsFromFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error(`Symbol file not found: ${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.json')) {
    const json = JSON.parse(raw);
    if (Array.isArray(json)) return normalizeSymbols(json);
    if (Array.isArray(json.symbols)) return normalizeSymbols(json.symbols);
    throw new Error(`JSON symbol file must be an array or contain a symbols array: ${file}`);
  }

  const records = parse(raw, { columns: false, skip_empty_lines: true, relax_column_count: true, trim: true });
  const symbols = [];
  for (const row of records) {
    const first = Array.isArray(row) ? row[0] : row;
    const symbol = String(first || '').trim().toUpperCase();
    if (!symbol || isSymbolHeader(symbol)) continue;
    symbols.push(symbol);
  }
  return normalizeSymbols(symbols);
}

function normalizeSymbols(values) {
  return [...new Set(values.map(v => String(v || '').trim().toUpperCase()).filter(Boolean))];
}

function isSymbolHeader(value) {
  return ['SYMBOL', 'TRADING_SYMBOL', 'SEM_TRADING_SYMBOL', 'TICKER', 'SCRIPT', 'SCRIP'].includes(value);
}

function isTestSymbol(symbol) {
  return /(^|\W)TEST(\W|$)|NSETEST/i.test(String(symbol || ''));
}

function parseUnderlying(tradingSymbol) {
  const symbol = String(tradingSymbol || '').toUpperCase();
  const match = symbol.match(/^(.+)-[A-Z]{3}\d{4}-FUT$/);
  return match ? match[1] : '';
}

function selectSymbols(symbols, args) {
  return symbols.filter(s => !args.symbol || s.underlying === args.symbol);
}

function resolveRequestedSymbols(args) {
  const rows = readMasterRows();
  const eligibilityByUnderlying = readFuturesEligibility(rows, args.maxFutExpiryDays);
  const cashBySymbol = readCashMaster(rows, eligibilityByUnderlying);
  const indexBySymbol = readIndexMaster(rows);
  const requested = new Set();

  if (args.all) args.universe = 'FUTSTK';
  if (args.symbol) requested.add(args.symbol);
  for (const symbol of args.symbols) requested.add(symbol);
  if (args.file) for (const symbol of readSymbolsFromFile(args.file)) requested.add(symbol);

  if (args.universe) {
    if (args.universe === 'FUTSTK') {
      for (const symbol of eligibilityByUnderlying.keys()) requested.add(symbol);
      for (const symbol of DEFAULT_INDEX_SYMBOLS) requested.add(symbol);
    } else if (args.universe === 'ALL_EQ') {
      for (const symbol of cashBySymbol.keys()) requested.add(symbol);
    } else {
      for (const symbol of readUniverseSymbols(args.universe)) requested.add(symbol);
    }
  }

  const selected = [];
  const missing = [];
  for (const symbol of [...requested].sort()) {
    const normalizedSymbol = normalizeIndexSymbol(symbol);
    const cash = cashBySymbol.get(symbol);
    const index = indexBySymbol.get(normalizedSymbol);
    if (cash) selected.push(cash);
    else if (index) selected.push(index);
    else missing.push(symbol);
  }
  return { selected: args.limit > 0 ? selected.slice(0, args.limit) : selected, missing };
}

function splitDateRange(fromDate, toDate, maxDays) {
  const chunks = [];
  let start = new Date(fromDate);
  const end = new Date(toDate);
  while (start < end) {
    let chunkEnd = new Date(start);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays);
    if (chunkEnd > end) chunkEnd = end;
    chunks.push({ from: start.toISOString().slice(0, 10), to: chunkEnd.toISOString().slice(0, 10) });
    start = new Date(chunkEnd);
    start.setDate(start.getDate() + 1);
  }
  return chunks.length ? chunks : [{ from: fromDate, to: toDate }];
}

async function fetchIntradayCandles(symbol, creds, fromDate, toDate, delayMs, retries = DEFAULT_RETRIES) {
  const chunks = splitDateRange(fromDate, toDate, 80);
  const merged = { open: [], high: [], low: [], close: [], volume: [], timestamp: [] };
  for (const [idx, chunk] of chunks.entries()) {
    const body = {
      securityId: symbol.securityId,
      exchangeSegment: symbol.exchange,
      instrument: symbol.instrument,
      interval: '1',
      oi: false,
      fromDate: chunk.from,
      toDate: chunk.to
    };
    const res = await postDhanWithRetry(body, creds, {
      label: `${symbol.tradingSymbol} ${chunk.from}..${chunk.to}`,
      retries,
      baseDelayMs: Math.max(delayMs, 1000)
    });
    const d = res.data || {};
    merged.open.push(...(d.open || []));
    merged.high.push(...(d.high || []));
    merged.low.push(...(d.low || []));
    merged.close.push(...(d.close || []));
    merged.volume.push(...(d.volume || []));
    merged.timestamp.push(...(d.timestamp || []));
    if (idx < chunks.length - 1) await sleep(delayMs);
  }
  return buildCandles(merged);
}

async function postDhanWithRetry(body, creds, opts) {
  const retries = Math.max(0, Number(opts.retries) || 0);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.post(`${DHAN_BASE}/v2/charts/intraday`, body, {
        proxy: false,
        timeout: 60000,
        headers: {
          'Content-Type': 'application/json',
          'client-id': creds.clientId,
          'access-token': creds.token
        }
      });
    } catch (err) {
      if (!isRetryableDhanError(err) || attempt >= retries) throw err;
      const waitMs = Math.min(60000, opts.baseDelayMs * (2 ** attempt));
      const status = err.response?.status || 'network';
      console.warn(`[Retry] ${opts.label} failed with ${status}; retry ${attempt + 1}/${retries} after ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw new Error('Retry loop exited unexpectedly');
}

function isRetryableDhanError(err) {
  const status = err.response?.status;
  return !status || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function buildCandles(raw) {
  const open = raw.open || [];
  const high = raw.high || [];
  const low = raw.low || [];
  const close = raw.close || [];
  const volume = raw.volume || [];
  const ts = raw.timestamp || [];
  return open.map((o, i) => ({
    ts: Number(ts[i]),
    o: Number(o),
    h: Number(high[i]),
    l: Number(low[i]),
    c: Number(close[i]),
    v: Number(volume[i] || 0)
  })).filter(c => Number.isFinite(c.o) && Number.isFinite(c.c) && c.o > 0 && c.c > 0);
}

function filterCandlesByDate(candles, fromDate, toDate) {
  const fromMs = Date.parse(`${fromDate}T00:00:00+05:30`);
  const toMs = Date.parse(`${toDate}T23:59:59+05:30`);
  return candles.filter(c => {
    const ms = c.ts > 1e12 ? c.ts : c.ts * 1000;
    return ms >= fromMs && ms <= toMs;
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

function runBacktestAndOptimize(candles, timeframe, targetRR) {
  const closes = candles.map(c => c.c);
  const execMeta = buildExecutionMeta(candles, timeframe);
  const simulateForCandles = (_closes, config = {}) => simulateOhlcNextOpen(candles, closes, config, execMeta);
  const baseline = simulateForCandles(closes, {});
  const opt = optimize(closes, targetRR, {
    maxCombos: 999999,
    minTrades: Math.min(10, Math.max(3, Math.floor(candles.length / 500))),
    simulate: simulateForCandles
  });
  return { baseline, opt };
}

function buildExecutionMeta(candles, timeframe) {
  const intraday = INTRADAY_TIMEFRAMES.has(timeframe);
  return {
    timeframe,
    intraday,
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

function simulateOhlcNextOpen(candles, closes, config = {}, execMeta) {
  const n = closes.length;
  if (n < 30) return { trades: [], summary: emptySummary() };

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
  const pre = getCachedPrecompute(candles, closes, { rsiPeriod, stochPeriod, cciPeriod, bbPeriod, atrPeriod });
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

function getCachedPrecompute(candles, closes, periods) {
  const cacheKey = `${periods.rsiPeriod}|${periods.stochPeriod}|${periods.cciPeriod}|${periods.bbPeriod}|${periods.atrPeriod}`;
  let cached = _ohlcPrecomputeCache.get(candles);
  if (!cached) {
    cached = new Map();
    _ohlcPrecomputeCache.set(candles, cached);
  }
  let pre = cached.get(cacheKey);
  if (!pre) {
    pre = precomputeIndicators(closes, periods);
    cached.set(cacheKey, pre);
  }
  return pre;
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
  if (execMeta.minuteOfDay[i] > LAST_INTRADAY_ENTRY_MINUTE) return false;
  if (i > 0 && execMeta.dayKey[i] !== execMeta.dayKey[i - 1]) return true;
  return true;
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

  if (hitTp && hitSl) {
    return { price: trade.sl, result: 'LOSS', reason: 'SL_AND_TP_SAME_CANDLE_ASSUME_SL' };
  }
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

function emptySummary() {
  return { total: 0, wins: 0, losses: 0, winRate: 0, pnlR: 0, expectancy: 0, avgWinR: 0, avgLossR: 0, maxDD: 0, profitFactor: 0 };
}

function minBarsForTimeframe(timeframe) {
  if (timeframe === '1') return 500;
  if (timeframe === '5') return 240;
  if (timeframe === 'D') return 60;
  if (timeframe === '60') return 80;
  return 120;
}

function configFromOptimization(symbol, timeframe, opt) {
  if (!opt.best) return null;
  const cfg = opt.best.config || {};
  return {
    source: 'futures-bulk-optimize',
    assetClass: symbol.isIndex ? 'NSE_INDEX' : (symbol.eligibility ? 'NSE_CASH_FUTURES_ELIGIBLE' : 'NSE_CASH'),
    underlying: symbol.underlying,
    symbol: symbol.tradingSymbol,
    secId: symbol.securityId,
    exchange: symbol.exchange,
    instrument: symbol.instrument,
    futuresEligibility: symbol.eligibility,
    timeframe,
    executionModel: {
      signal: 'candle_close',
      entry: 'next_candle_open',
      exit: 'intrabar_high_low_stop_or_target',
      sameCandleStopAndTarget: 'assume_stoploss_first',
      intradayNoNewEntryAfter: INTRADAY_TIMEFRAMES.has(timeframe) ? '15:15 IST' : null,
      intradaySquareOffAt: INTRADAY_TIMEFRAMES.has(timeframe) ? '15:25 IST' : null,
      carryForwardAllowed: !INTRADAY_TIMEFRAMES.has(timeframe)
    },
    targetRR: opt.targetRR,
    searched: opt.searched,
    qualified: opt.qualified,
    slMultiplier: cfg.slMultiplier,
    tpMultiplier: cfg.tpMultiplier,
    minScore: cfg.thresholds?.minScore || 6,
    thresholds: cfg.thresholds || {},
    params: cfg.params || {},
    summary: opt.best.summary,
    savedAt: Date.now()
  };
}

function saveCandles(outDir, symbol, candles) {
  const dir = path.join(outDir, symbol.underlying);
  fs.mkdirSync(dir, { recursive: true });
  const file = candleFilePath(outDir, symbol);
  fs.writeFileSync(file, JSON.stringify({ symbol, count: candles.length, candles }, null, 2));
  return file;
}

function mergeAndSaveCandles(outDir, symbol, freshCandles) {
  const existing = loadCachedCandles(outDir, symbol);
  const byTs = new Map();
  const existingCandles = existing?.candles || [];
  for (const candle of existingCandles) {
    if (Number.isFinite(Number(candle.ts))) byTs.set(Number(candle.ts), candle);
  }

  let added = 0;
  let updated = 0;
  for (const candle of freshCandles) {
    const ts = Number(candle.ts);
    if (!Number.isFinite(ts)) continue;
    if (byTs.has(ts)) updated++;
    else added++;
    byTs.set(ts, candle);
  }

  const merged = [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  const file = saveCandles(outDir, symbol, merged);
  return {
    file,
    previousCount: existingCandles.length,
    downloadedCount: freshCandles.length,
    added,
    updated,
    totalCount: merged.length
  };
}

function lastCachedCandleDate(candles) {
  let lastTs = 0;
  for (const candle of candles || []) {
    const ts = Number(candle.ts);
    if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
  }
  return lastTs ? istDateFromTimestamp(lastTs) : '';
}

function istDateFromTimestamp(ts) {
  const ms = (ts > 1e12 ? ts : ts * 1000) + IST_OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

function nextDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function candleFilePath(outDir, symbol) {
  const dir = path.join(outDir, symbol.underlying);
  const safeName = symbol.tradingSymbol.replace(/[^\w.-]+/g, '_');
  return path.join(dir, `${safeName}_1m.json`);
}

function loadCachedCandles(outDir, symbol) {
  const file = candleFilePath(outDir, symbol);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    file,
    candles: Array.isArray(payload.candles) ? payload.candles : []
  };
}

function readConfigFile(configFile) {
  if (!fs.existsSync(configFile)) return {};
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}

function writeConfigFile(configFile, configs) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(configs, null, 2));
}

function saveTimeframeConfigs(configs, symbol, byTimeframe) {
  for (const [tf, cfg] of Object.entries(byTimeframe)) {
    if (!cfg) continue;
    configs[`${symbol.exchange}:${symbol.securityId}:${tf}`] = cfg;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.symbol && !args.symbols.length && !args.file && !args.universe && !args.all)) {
    console.log(usage());
    return;
  }
  if (args.downloadOnly || args.resumeFromCache) {
    throw new Error('Download-only mode has moved. Use: node scripts/download-candles.js --universe FUTSTK --resume-from-cache');
  }
  if (args.downloadOnly && args.useCache) {
    throw new Error('--download-only cannot be combined with --use-cache. Remove --use-cache to fetch fresh candles.');
  }
  if (args.resumeFromCache && !args.downloadOnly) {
    throw new Error('--resume-from-cache is only supported with --download-only.');
  }

  const env = readEnv();
  const creds = { clientId: env.DHAN_CLIENT_ID, token: env.DHAN_ACCESS_TOKEN };
  if (!creds.clientId || !creds.token) throw new Error('Missing DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN in .env');

  const { selected: symbols, missing } = resolveRequestedSymbols(args);
  if (missing.length) console.warn(`[Setup] Skipped ${missing.length} symbol(s) not found in NSE_EQ cash master: ${missing.join(', ')}`);
  if (!symbols.length) throw new Error(`No NSE cash symbols found for requested selection.`);

  console.log(`[Setup] Selected ${symbols.length} NSE instrument(s). Range ${args.fromDate} to ${args.toDate}.`);
  console.log(`[Setup] Mode: ${args.downloadOnly ? `download-only; merge fresh 1m candles into existing cache${args.resumeFromCache ? '; resume per symbol from cache' : ''}` : 'download/cache + optimize'}`);
  console.log(`[Setup] Timeframes: ${args.timeframes.join(', ')}${args.useCache ? ' | cache mode' : ''}`);
  if (!args.downloadOnly) {
    console.log(`[Setup] Target R:R: ${args.targetRR}:1`);
    console.log(`[Setup] Config file: ${args.configFile}`);
  }
  fs.mkdirSync(args.outDir, { recursive: true });
  const configs = args.writeConfig ? readConfigFile(args.configFile) : {};

  for (const [idx, symbol] of symbols.entries()) {
    const eligibility = symbol.eligibility
      ? ` eligibleVia=${symbol.eligibility.futuresTradingSymbol} futSecId=${symbol.eligibility.futuresSecurityId}`
      : '';
    console.log(`\n[${idx + 1}/${symbols.length}] ${symbol.tradingSymbol} ${symbol.exchange}/${symbol.instrument} secId=${symbol.securityId}${eligibility}`);
    let candles;
    if (args.useCache) {
      const cached = loadCachedCandles(args.outDir, symbol);
      if (!cached) {
        console.error(`[Cache] Missing ${candleFilePath(args.outDir, symbol)}`);
        continue;
      }
      candles = cached.candles;
      candles = filterCandlesByDate(candles, args.fromDate, args.toDate);
      console.log(`[Cache] Loaded ${candles.length} x 1m candles <- ${cached.file}`);
    } else {
      let fetchFromDate = args.fromDate;
      if (args.resumeFromCache) {
        const cached = loadCachedCandles(args.outDir, symbol);
        const lastDate = cached ? lastCachedCandleDate(cached.candles) : '';
        if (lastDate) {
          fetchFromDate = nextDate(lastDate);
          if (fetchFromDate > args.toDate) {
            console.log(`[Download] Cache is current through ${lastDate}; no new calendar days to download.`);
            continue;
          }
          console.log(`[Download] Cache last date ${lastDate}; fetching ${fetchFromDate} to ${args.toDate}.`);
        } else {
          console.log(`[Download] No cached candles found; fetching ${fetchFromDate} to ${args.toDate}.`);
        }
      }
      try {
        candles = await fetchIntradayCandles(symbol, creds, fetchFromDate, args.toDate, args.delayMs, args.retries);
      } catch (err) {
        console.error(`[Download] Failed ${symbol.tradingSymbol}: ${err.response?.status || ''} ${err.response?.data?.message || err.message}`);
        continue;
      }

      if (args.downloadOnly) {
        const saved = mergeAndSaveCandles(args.outDir, symbol, candles);
        console.log(`[Download] Merged ${saved.downloadedCount} downloaded candles -> ${saved.file}`);
        console.log(`[Download] previous=${saved.previousCount} added=${saved.added} updated=${saved.updated} total=${saved.totalCount}`);
      } else {
        const file = saveCandles(args.outDir, symbol, candles);
        console.log(`[Download] Saved ${candles.length} x 1m candles -> ${file}`);
      }
    }
    if (args.downloadOnly) {
      if (idx < symbols.length - 1) await sleep(args.delayMs);
      continue;
    }
    if (candles.length < 100) {
      console.warn(`[Skip] Not enough candles for optimization: ${candles.length}`);
      continue;
    }

    const byTimeframe = {};
    for (const tf of args.timeframes) {
      const agg = aggregateCandles(candles, tf);
      const minBars = minBarsForTimeframe(tf);
      if (agg.length < minBars) {
        console.log(`[${tf}] bars=${agg.length} skipped; needs at least ${minBars} bars for a useful optimization.`);
        continue;
      }
      const { baseline, opt } = runBacktestAndOptimize(agg, tf, args.targetRR);
      const cfg = configFromOptimization(symbol, tf, opt);
      byTimeframe[tf] = cfg;
      console.log(`[${tf}] bars=${agg.length} baselineTrades=${baseline.summary.total} searched=${opt.searched} qualified=${opt.qualified} bestTrades=${opt.best?.summary?.total || 0}`);
    }

    if (args.writeConfig) {
      saveTimeframeConfigs(configs, symbol, byTimeframe);
      writeConfigFile(args.configFile, configs);
      console.log(`[Config] Updated ${args.configFile}`);
    } else {
      console.log('[Config] Dry run only. Add --write-config to save optimized configs.');
    }
    if (idx < symbols.length - 1) await sleep(args.delayMs);
  }
}

main().catch(err => {
  console.error(`[Fatal] ${err.message}`);
  process.exit(1);
});
