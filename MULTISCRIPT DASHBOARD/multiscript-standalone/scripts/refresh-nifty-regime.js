'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { loadDhanEnv } = require('../server/config/dhan-env');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
dotenv.config({ path: ENV_FILE, quiet: true });
const DHAN_ENV = loadDhanEnv();

const DHAN_BASE = process.env.DHAN_REST_URL || 'https://api.dhan.co';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_DELAY_MS = 1200;
const DEFAULT_RETRIES = 4;

const REGIME_PARAMS = {
  niftyTrend: { fast: 20, slow: 50 },
  skipNiftyHighVol: { lookbackDays: 5, rangePctThreshold: 1.2 }
};

const NIFTY = {
  tradingSymbol: 'NIFTY',
  underlying: 'NIFTY',
  securityId: process.env.MULTISCRIPT_NIFTY_SECURITY_ID || '13',
  exchange: process.env.MULTISCRIPT_NIFTY_EXCHANGE || 'IDX_I',
  instrument: process.env.MULTISCRIPT_NIFTY_INSTRUMENT || 'INDEX'
};

function parseArgs(argv) {
  const out = {
    days: Number(process.env.MULTISCRIPT_REGIME_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS),
    toDate: todayIST(),
    fromDate: '',
    delayMs: Number(process.env.MULTISCRIPT_DHAN_DELAY_MS || DEFAULT_DELAY_MS),
    retries: Number(process.env.MULTISCRIPT_DHAN_RETRIES || DEFAULT_RETRIES),
    noFetch: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--from') out.fromDate = String(next() || '');
    else if (a === '--to') out.toDate = String(next() || out.toDate);
    else if (a === '--days') out.days = Number(next() || out.days);
    else if (a === '--delay-ms') out.delayMs = Number(next() || out.delayMs);
    else if (a === '--retries') out.retries = Number(next() || out.retries);
    else if (a === '--no-fetch') out.noFetch = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (!out.fromDate) out.fromDate = addDays(out.toDate, -Math.max(1, out.days));
  return out;
}

function usage() {
  return [
    'Usage: node scripts/refresh-nifty-regime.js [--days 30] [--from YYYY-MM-DD] [--to YYYY-MM-DD]',
    '',
    'Fetches recent NIFTY 1m candles from Dhan and regenerates data/regime/nifty-regime.json.',
    '',
    'Environment required in D:\\DHAN_LOGIN\\.env:',
    '  DHAN_CLIENT_ID=...',
    '  DHAN_ACCESS_TOKEN=...',
    '',
    'Optional overrides:',
    '  MULTISCRIPT_NIFTY_SECURITY_ID=13',
    '  MULTISCRIPT_NIFTY_EXCHANGE=IDX_I',
    '  MULTISCRIPT_NIFTY_INSTRUMENT=INDEX',
    '  MULTISCRIPT_REGIME_LOOKBACK_DAYS=30'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const clientId = process.env.DHAN_CLIENT_ID || '';
  const token = process.env.DHAN_ACCESS_TOKEN || '';
  if (!args.noFetch && (!clientId || !token)) {
    throw new Error(`Missing DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN in ${DHAN_ENV.envFile}. Fill credentials, then run .\\refresh-regime.ps1`);
  }

  const candleFile = candleFilePath(NIFTY);
  const existing = loadCachedCandles(candleFile);
  const existingLastDate = lastCachedCandleDate(existing);
  let fresh = [];
  if (!args.noFetch) {
    const range = resolveFetchRange(args.fromDate, args.toDate, existingLastDate);
    if (existing.length) {
      console.log(`[Regime] Local NIFTY cache found: ${existing.length} candles, last date ${existingLastDate || 'unknown'}.`);
    } else {
      console.log('[Regime] No local NIFTY cache found.');
    }

    if (range.skip) {
      console.log(`[Regime] Local cache already covers requested range through ${args.toDate}; skipping Dhan fetch.`);
    } else {
      console.log(`[Regime] Fetching missing NIFTY 1m candles ${range.fromDate} to ${range.toDate} from Dhan...`);
      fresh = await fetchIntradayCandles(NIFTY, { clientId, token }, range.fromDate, range.toDate, args.delayMs, args.retries);
      console.log(`[Regime] Downloaded ${fresh.length} candles.`);
    }
  }

  const merged = mergeCandles(existing, fresh);
  if (merged.length < 50) {
    throw new Error(`Not enough NIFTY candles to build regime. Have ${merged.length}, need at least 50.`);
  }
  saveCandles(candleFile, NIFTY, merged);
  const regime = buildRegime(merged);
  const regimeFile = path.join(ROOT, 'data', 'regime', 'nifty-regime.json');
  fs.mkdirSync(path.dirname(regimeFile), { recursive: true });
  fs.writeFileSync(regimeFile, JSON.stringify(regime));

  console.log(`[Regime] Saved merged candle cache: ${candleFile}`);
  console.log(`[Regime] Total cached candles: ${merged.length}`);
  console.log(`[Regime] Last candle date: ${lastCachedCandleDate(merged) || 'unknown'}`);
  console.log(`[Regime] Wrote: ${regimeFile}`);
}

async function fetchIntradayCandles(symbol, creds, fromDate, toDate, delayMs, retries) {
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
    const data = await postDhanWithRetry(body, creds, {
      label: `NIFTY ${chunk.from}..${chunk.to}`,
      retries,
      baseDelayMs: Math.max(delayMs, 1000)
    });
    merged.open.push(...(data.open || []));
    merged.high.push(...(data.high || []));
    merged.low.push(...(data.low || []));
    merged.close.push(...(data.close || []));
    merged.volume.push(...(data.volume || []));
    merged.timestamp.push(...(data.timestamp || []));
    if (idx < chunks.length - 1) await sleep(delayMs);
  }
  return buildCandles(merged);
}

async function postDhanWithRetry(body, creds, opts) {
  const retries = Math.max(0, Number(opts.retries) || 0);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${DHAN_BASE}/v2/charts/intraday`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'client-id': creds.clientId,
          'access-token': creds.token
        },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { raw: text }; }
      if (!res.ok) {
        const err = new Error(`Dhan ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (err) {
      if (!isRetryableDhanError(err) || attempt >= retries) throw err;
      const waitMs = Math.min(60000, opts.baseDelayMs * (2 ** attempt));
      console.warn(`[Retry] ${opts.label} failed with ${err.status || 'network'}; retry ${attempt + 1}/${retries} after ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw new Error('Retry loop exited unexpectedly');
}

function isRetryableDhanError(err) {
  const status = err.status;
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
  })).filter(c => Number.isFinite(c.ts) && Number.isFinite(c.o) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c) && c.o > 0 && c.c > 0);
}

function buildRegime(candles) {
  const trend15 = buildIndexTrend(candles, '15', REGIME_PARAMS.niftyTrend.fast, REGIME_PARAMS.niftyTrend.slow);
  const blocked = buildHighVolDays(candles, REGIME_PARAMS.skipNiftyHighVol.rangePctThreshold, REGIME_PARAMS.skipNiftyHighVol.lookbackDays);
  return {
    generatedAt: new Date().toISOString(),
    source: {
      symbol: NIFTY.tradingSymbol,
      securityId: NIFTY.securityId,
      exchange: NIFTY.exchange,
      instrument: NIFTY.instrument,
      candleCache: path.relative(ROOT, candleFilePath(NIFTY)),
      lastCandleDate: lastCachedCandleDate(candles)
    },
    params: REGIME_PARAMS,
    trendByTs: Object.fromEntries(trend15),
    blockedDays: Array.from(blocked),
    note: 'Generated locally by scripts/refresh-nifty-regime.js from recent Dhan NIFTY 1m candles.'
  };
}

function buildIndexTrend(candles, tf, fast, slow) {
  const agg = aggregate(candles, tf);
  const closes = agg.map(x => x.c);
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const m = new Map();
  for (let i = 0; i < agg.length; i++) m.set(agg[i].ts, ef[i] >= es[i] ? 1 : -1);
  return m;
}

function buildHighVolDays(candles, thresholdPct, lookback) {
  const daily = aggregate(candles, 'D');
  const ranges = daily.map(x => 100 * (x.h - x.l) / x.c);
  const blocked = new Set();
  for (let i = 0; i < daily.length; i++) {
    const start = Math.max(0, i - (lookback - 1));
    let sum = 0;
    let n = 0;
    for (let j = start; j <= i; j++) {
      sum += ranges[j];
      n++;
    }
    if (sum / n > thresholdPct) blocked.add(istDay(daily[i].ts));
  }
  return blocked;
}

function aggregate(candles, tf) {
  if (tf === '1') return candles.slice().sort((a, b) => a.ts - b.ts);
  const buckets = new Map();
  for (const c of candles) {
    const k = bucketKey(c.ts, tf);
    const b = buckets.get(k);
    if (!b) buckets.set(k, { ts: k, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 });
    else {
      b.h = Math.max(b.h, c.h);
      b.l = Math.min(b.l, c.l);
      b.c = c.c;
      b.v += c.v || 0;
    }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

function bucketKey(ts, tf) {
  const ms = tsMs(ts);
  if (tf === 'D') {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  }
  const bucketMs = Number(tf) * 60 * 1000;
  return Math.floor(ms / bucketMs) * bucketMs / 1000;
}

function emaSeries(values, period) {
  const out = new Float64Array(values.length);
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 0; i < values.length; i++) {
    ema = i === 0 ? values[i] : values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function candleFilePath(symbol) {
  return path.join(ROOT, 'data', 'nifty-candles', symbol.underlying, `${safeName(symbol.tradingSymbol)}_1m.json`);
}

function loadCachedCandles(file) {
  if (!fs.existsSync(file)) return [];
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(payload.candles) ? payload.candles : [];
}

function saveCandles(file, symbol, candles) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ symbol, count: candles.length, candles }, null, 2));
}

function mergeCandles(existing, fresh) {
  const byTs = new Map();
  for (const c of existing || []) {
    const ts = Number(c.ts);
    if (Number.isFinite(ts)) byTs.set(ts, normalizeCandle(c));
  }
  for (const c of fresh || []) {
    const ts = Number(c.ts);
    if (Number.isFinite(ts)) byTs.set(ts, normalizeCandle(c));
  }
  return [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
}

function normalizeCandle(c) {
  return { ts: Number(c.ts), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v || 0) };
}

function resolveFetchRange(fromDate, toDate, existingLastDate) {
  if (!existingLastDate) return { skip: false, fromDate, toDate };
  const nextMissingDate = addDays(existingLastDate, 1);
  const fetchFromDate = nextMissingDate > fromDate ? nextMissingDate : fromDate;
  if (fetchFromDate > toDate) return { skip: true, fromDate: fetchFromDate, toDate };
  return { skip: false, fromDate: fetchFromDate, toDate };
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

function lastCachedCandleDate(candles) {
  let lastTs = 0;
  for (const candle of candles || []) {
    const ts = Number(candle.ts);
    if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
  }
  return lastTs ? istDateFromTimestamp(lastTs) : '';
}

function istDateFromTimestamp(ts) {
  const ms = tsMs(ts) + IST_OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

function istDay(ts) {
  return Math.floor((tsMs(ts) + IST_OFFSET_MS) / 86400000);
}

function tsMs(ts) {
  return ts > 1e12 ? ts : ts * 1000;
}

function todayIST() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function safeName(value) {
  return String(value || '').replace(/[^\w.-]+/g, '_');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(`[Regime] ${err.message}`);
  process.exit(1);
});
