#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parse } = require('csv-parse/sync');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MASTER_CSV = path.join(DATA_DIR, 'api-scrip-master.csv');
const DEFAULT_OUT_DIR = path.join(DATA_DIR, 'futures-eligible-cash-candles');
const UNIVERSE_DIR = path.join(DATA_DIR, 'universes');
const DHAN_BASE = 'https://api.dhan.co';
const DEFAULT_MAX_FUT_EXPIRY_DAYS = 120;
const DEFAULT_INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY'];
const DEFAULT_RETRIES = 4;
const DEFAULT_DAYS = 7;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    symbol: '',
    symbols: [],
    file: '',
    universe: '',
    all: false,
    limit: 0,
    maxFutExpiryDays: DEFAULT_MAX_FUT_EXPIRY_DAYS,
    years: 0,
    months: 0,
    days: DEFAULT_DAYS,
    outDir: DEFAULT_OUT_DIR,
    resumeFromCache: false,
    delayMs: 1200,
    retries: DEFAULT_RETRIES,
    fromDate: '',
    toDate: new Date().toISOString().slice(0, 10),
    help: false
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
    else if (a === '--years') {
      args.years = Number(next()) || 0;
      args.months = 0;
      args.days = 0;
    } else if (a === '--months') {
      args.months = Number(next()) || 0;
      args.years = 0;
      args.days = 0;
    } else if (a === '--days') {
      args.days = Number(next()) || DEFAULT_DAYS;
      args.years = 0;
      args.months = 0;
    } else if (a === '--from') args.fromDate = String(next() || '');
    else if (a === '--to') args.toDate = String(next() || args.toDate);
    else if (a === '--out') args.outDir = path.resolve(next() || args.outDir);
    else if (a === '--resume-from-cache' || a === '--incremental') args.resumeFromCache = true;
    else if (a === '--delay-ms') args.delayMs = Number(next()) || args.delayMs;
    else if (a === '--retries') args.retries = Number(next()) || args.retries;
    else if (a === '--help') args.help = true;
    else throw new Error(`Unknown option: ${a}`);
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
  if (!args.fromDate && args.years > 0) {
    const d = new Date(args.toDate);
    d.setFullYear(d.getFullYear() - args.years);
    args.fromDate = d.toISOString().slice(0, 10);
  }
  if (!args.fromDate) {
    const d = new Date(args.toDate);
    d.setDate(d.getDate() - Math.max(0, DEFAULT_DAYS - 1));
    args.fromDate = d.toISOString().slice(0, 10);
  }
  return args;
}

function usage() {
  return `
Usage:
  node scripts/download-candles.js --symbol RELIANCE
  node scripts/download-candles.js --symbols RELIANCE,SBIN,TCS --days 7
  node scripts/download-candles.js --file D:\\CODEX\\data\\my-symbols.csv --resume-from-cache
  node scripts/download-candles.js --universe FUTSTK --resume-from-cache
  node scripts/download-candles.js --universe ALL_EQ --days 7

Options:
  --symbol RELIANCE              Download one NSE cash/index symbol.
  --symbols RELIANCE,SBIN        Comma-separated NSE cash/index symbols.
  --file PATH                    Text/CSV/JSON file containing NSE cash/index symbols.
  --universe FUTSTK              Futures-eligible cash stocks from the Dhan master.
                                  Includes NIFTY and BANKNIFTY indexes.
  --universe NIFTY500            Local universe file from data/universes.
  --universe ALL_EQ              All NSE cash EQ symbols from the Dhan master.
  --all                          Same as --universe FUTSTK.
  --limit 5                      Process only first N selected symbols.
  --max-fut-expiry-days 120      Ignore far-future/test FUTSTK contracts.
  --days 7                       Lookback calendar days. Default: 7.
  --months 3                     Lookback months. Overrides default --days.
  --years 3                      Lookback years. Overrides default --days.
  --from YYYY-MM-DD              Override start date.
  --to YYYY-MM-DD                Override end date. Default: today.
  --out PATH                     Candle output folder. Default: data/futures-eligible-cash-candles.
  --resume-from-cache            Start each symbol from the day after its last cached candle.
                                  Alias: --incremental.
  --delay-ms 1200                Delay between Dhan calls.
  --retries 4                    Retry transient Dhan errors per candle chunk.

Safety:
  This script only downloads and merges 1m candles.
  It never runs backtests, optimization, or writes symbol-configs.json.
`.trim();
}

function parseSymbolList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
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
    if (!symbol || isTestSymbol(symbol)) continue;
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
    const ts = Number(candle.ts);
    if (Number.isFinite(ts)) byTs.set(ts, candle);
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.symbol && !args.symbols.length && !args.file && !args.universe && !args.all)) {
    console.log(usage());
    return;
  }

  const env = readEnv();
  const creds = { clientId: env.DHAN_CLIENT_ID, token: env.DHAN_ACCESS_TOKEN };
  if (!creds.clientId || !creds.token) throw new Error('Missing DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN in .env');

  const { selected: symbols, missing } = resolveRequestedSymbols(args);
  if (missing.length) console.warn(`[Setup] Skipped ${missing.length} symbol(s) not found in NSE_EQ cash master: ${missing.join(', ')}`);
  if (!symbols.length) throw new Error('No NSE instruments found for requested selection.');

  fs.mkdirSync(args.outDir, { recursive: true });
  console.log(`[Setup] Selected ${symbols.length} NSE instrument(s). Fallback range ${args.fromDate} to ${args.toDate}.`);
  console.log(`[Setup] Mode: download only; merge 1m candles into existing cache${args.resumeFromCache ? '; incremental per symbol' : ''}`);
  console.log(`[Setup] Output: ${args.outDir}`);

  for (const [idx, symbol] of symbols.entries()) {
    const eligibility = symbol.eligibility
      ? ` eligibleVia=${symbol.eligibility.futuresTradingSymbol} futSecId=${symbol.eligibility.futuresSecurityId}`
      : '';
    console.log(`\n[${idx + 1}/${symbols.length}] ${symbol.tradingSymbol} ${symbol.exchange}/${symbol.instrument} secId=${symbol.securityId}${eligibility}`);

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
        console.log(`[Download] No cached candles found; fetching fallback range ${fetchFromDate} to ${args.toDate}.`);
      }
    }

    let candles;
    try {
      candles = await fetchIntradayCandles(symbol, creds, fetchFromDate, args.toDate, args.delayMs, args.retries);
    } catch (err) {
      console.error(`[Download] Failed ${symbol.tradingSymbol}: ${err.response?.status || ''} ${err.response?.data?.message || err.message}`);
      continue;
    }

    const saved = mergeAndSaveCandles(args.outDir, symbol, candles);
    console.log(`[Download] Merged ${saved.downloadedCount} downloaded candles -> ${saved.file}`);
    console.log(`[Download] previous=${saved.previousCount} added=${saved.added} updated=${saved.updated} total=${saved.totalCount}`);

    if (idx < symbols.length - 1) await sleep(args.delayMs);
  }
}

main().catch(err => {
  console.error(`[Fatal] ${err.message}`);
  process.exit(1);
});
