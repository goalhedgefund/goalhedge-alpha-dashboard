const fs = require('node:fs');
const path = require('node:path');

function normalizeKey(value = '') {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toMs(ts) {
  const value = Number(ts || 0);
  if (!Number.isFinite(value)) return 0;
  return value < 1e12 ? value * 1000 : value;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function walkFiles(rootDir, predicate, results = []) {
  if (!fs.existsSync(rootDir)) return results;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, results);
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function getDayKey(tsMs) {
  const date = new Date(tsMs);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getBucketKey(tsMs, frame) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(tsMs)).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const interval = Number(frame);
  const bucketMinute = Math.floor(minute / interval) * interval;
  return `${year}-${parts.month}-${parts.day} ${String(hour).padStart(2, '0')}:${String(bucketMinute).padStart(2, '0')}`;
}

function aggregateCandles(candles, frame) {
  if (frame === '1' || frame === '1m' || frame === 1) {
    return candles.slice();
  }

  const interval = Number(frame);
  const grouped = new Map();

  for (const candle of candles) {
    const ts = toMs(candle.ts || candle.timestamp || candle.time);
    const bucket = frame === 'D' ? getDayKey(ts) : getBucketKey(ts, interval);
    const existing = grouped.get(bucket);
    if (!existing) {
      grouped.set(bucket, {
        ts,
        o: Number(candle.o ?? candle.open ?? candle.c ?? candle.close ?? 0),
        h: Number(candle.h ?? candle.high ?? candle.c ?? candle.close ?? 0),
        l: Number(candle.l ?? candle.low ?? candle.c ?? candle.close ?? 0),
        c: Number(candle.c ?? candle.close ?? 0),
        v: Number(candle.v ?? candle.volume ?? 0)
      });
      continue;
    }
    existing.h = Math.max(existing.h, Number(candle.h ?? candle.high ?? candle.c ?? candle.close ?? 0));
    existing.l = Math.min(existing.l, Number(candle.l ?? candle.low ?? candle.c ?? candle.close ?? 0));
    existing.c = Number(candle.c ?? candle.close ?? existing.c);
    existing.v += Number(candle.v ?? candle.volume ?? 0);
  }

  return Array.from(grouped.values()).sort((a, b) => a.ts - b.ts);
}

function buildCandidateKeys(symbol) {
  const keys = new Set();
  const raw = String(symbol || '').toUpperCase();
  const cleaned = normalizeKey(raw);
  const stripped = cleaned.replace(/_/g, '');
  keys.add(raw);
  keys.add(cleaned);
  keys.add(stripped);
  return Array.from(keys).filter(Boolean);
}

function normalizeReplayRange(range = {}) {
  const from = range?.from ? new Date(range.from).getTime() : null;
  const to = range?.to ? new Date(range.to).getTime() : null;
  return {
    from: Number.isFinite(from) ? from : null,
    to: Number.isFinite(to) ? to : null
  };
}

function rangeKey(range = {}) {
  const normalized = normalizeReplayRange(range);
  return `${normalized.from || 'start'}_${normalized.to || 'end'}`;
}

// Calendar days of pre-range history loaded purely for indicator warm-up when
// getClosedSeries() is used (i.e. trade-decision evaluation), never for the
// tick stream. Without this, RSI/Stoch/CCI/BB converge within ~20 bars, but
// EMA9/EMA21 are seeded from the FIRST bar of whatever array they're given
// (signal.scalper.js's ema()) and take ~60-100 bars (exponential decay) to
// reach values resembling a continuously-running system. A 1-month replay
// range with zero pre-range buffer cold-starts every indicator at the range
// boundary, producing meaningfully different (and far fewer) qualifying
// signals than the standalone backtest, which always runs on full multi-year
// history. Confirmed via direct comparison: April 2026 alone with no warm-up
// produced ~2 trades/symbol vs the backtest's ~10-13/symbol for the same
// config and basket. 60 days gives ~1000+ 15m bars of lookback.
const WARMUP_DAYS = 60;

class ReplayRepository {
  constructor({ sourceDir, cacheDir, lookbackDays = 7, speedMultiplier = 120 }) {
    this.sourceDir = sourceDir;
    this.cacheDir = cacheDir;
    this.lookbackDays = lookbackDays;
    this.speedMultiplier = speedMultiplier;
    this.index = new Map();
    this.datasetCache = new Map();
    ensureDir(this.cacheDir);
  }

  buildIndex() {
    if (this.index.size) return this.index;
    const files = walkFiles(this.sourceDir, (filePath) => /_1m\.json$/i.test(filePath));
    for (const filePath of files) {
      const base = path.basename(filePath, '.json').replace(/_1m$/i, '');
      const folder = path.basename(path.dirname(filePath));
      const keys = new Set([base, folder, ...buildCandidateKeys(base), ...buildCandidateKeys(folder)]);
      for (const key of keys) {
        this.index.set(normalizeKey(key), filePath);
      }
    }
    return this.index;
  }

  resolveSymbolFile(symbol) {
    this.buildIndex();
    const candidates = buildCandidateKeys(symbol);
    for (const candidate of candidates) {
      const file = this.index.get(normalizeKey(candidate));
      if (file) return file;
    }
    return null;
  }

  loadSourceDataset(symbol, range = null, opts = {}) {
    const warmupDays = opts.warmup ? WARMUP_DAYS : 0;
    const normalizedRange = normalizeReplayRange(range || {});
    const cacheId = `${normalizeKey(symbol)}:${rangeKey(normalizedRange)}:w${warmupDays}`;
    const cached = this.datasetCache.get(cacheId);
    if (cached) return cached;

    const cacheFile = path.join(this.cacheDir, `${normalizeKey(symbol)}_1m_${rangeKey(normalizedRange)}_w${warmupDays}.json`);
    if (fs.existsSync(cacheFile)) {
      const fromCache = readJson(cacheFile, null);
      if (fromCache) {
        this.datasetCache.set(cacheId, fromCache);
        return fromCache;
      }
    }

    const filePath = this.resolveSymbolFile(symbol);
    if (!filePath) {
      const fallback = { symbol, candles: [], meta: {} };
      this.datasetCache.set(cacheId, fallback);
      return fallback;
    }

    const payload = readJson(filePath, null);
    const rawCandles = Array.isArray(payload?.candles) ? payload.candles : [];
    const meta = payload?.symbol || {};
    const normalized = rawCandles
      .map((candle) => ({
        ts: toMs(candle.ts),
        o: Number(candle.o ?? candle.open ?? 0),
        h: Number(candle.h ?? candle.high ?? 0),
        l: Number(candle.l ?? candle.low ?? 0),
        c: Number(candle.c ?? candle.close ?? 0),
        v: Number(candle.v ?? candle.volume ?? 0)
      }))
      .filter((candle) => candle.ts > 0 && Number.isFinite(candle.c))
      .sort((a, b) => a.ts - b.ts);

    const end = normalized.length ? normalized[normalized.length - 1].ts : Date.now();
    const defaultStart = end - (this.lookbackDays * 24 * 60 * 60 * 1000);
    const requestedStart = Number.isFinite(normalizedRange.from) ? normalizedRange.from : defaultStart;
    const start = requestedStart - (warmupDays * 24 * 60 * 60 * 1000);
    const stop = Number.isFinite(normalizedRange.to) ? normalizedRange.to : end;
    const slice = normalized.filter((candle) => candle.ts >= start && candle.ts <= stop);
    const dataset = {
      symbol: meta.underlying || meta.tradingSymbol || symbol,
      securityId: String(meta.securityId || meta.futuresSecurityId || ''),
      exchange: meta.exchange || 'NSE_EQ',
      instrument: meta.instrument || 'EQUITY',
      name: meta.customSymbol || meta.symbolName || symbol,
      candles: slice,
      sourceFile: filePath,
      generatedAt: new Date().toISOString(),
      lookbackDays: this.lookbackDays,
      replayRange: {
        from: Number.isFinite(normalizedRange.from) ? normalizedRange.from : null,
        to: Number.isFinite(normalizedRange.to) ? normalizedRange.to : null
      }
    };
    fs.writeFileSync(cacheFile, JSON.stringify(dataset, null, 2), 'utf8');
    this.datasetCache.set(cacheId, dataset);
    return dataset;
  }

  loadSelected(symbols = [], range = null) {
    const resolved = [];
    for (const symbol of symbols) {
      const dataset = this.loadSourceDataset(symbol, range);
      resolved.push(dataset);
    }
    return resolved.filter((entry) => entry.candles.length);
  }

  getSeries(symbol, frame = '1', range = null) {
    const dataset = this.loadSourceDataset(symbol, range);
    const frameKey = String(frame);
    if (frameKey === '1' || frameKey === '1m') {
      return dataset.candles.slice();
    }
    return aggregateCandles(dataset.candles, frameKey);
  }

  // Causal version of getSeries: returns only candles that have actually
  // "happened" by `asOfMs` (the simulated replay clock), and excludes the most
  // recent bucket if it isn't fully closed yet. This is what makes REPLAY mode
  // a true walk-forward (no look-ahead) instead of revealing the whole future
  // range immediately. asOfMs must be a finite ms timestamp; if not provided,
  // returns an empty series (no data "exists" yet).
  getClosedSeries(symbol, frame = '1', range = null, asOfMs = null) {
    if (!Number.isFinite(asOfMs)) return [];
    const dataset = this.loadSourceDataset(symbol, range, { warmup: true });
    const filtered1m = dataset.candles.filter((c) => c.ts <= asOfMs);
    if (!filtered1m.length) return [];

    const frameKey = String(frame);
    if (frameKey === '1' || frameKey === '1m') {
      return filtered1m;
    }

    const aggregated = aggregateCandles(filtered1m, frameKey);
    if (!aggregated.length) return aggregated;
    const last = aggregated[aggregated.length - 1];
    const lastAvailableTs = filtered1m[filtered1m.length - 1].ts;
    let closed;
    if (frameKey === 'D') {
      const bucketDayKey = getDayKey(last.ts);
      const lastMinuteDayKey = getDayKey(lastAvailableTs);
      if (bucketDayKey !== lastMinuteDayKey) {
        closed = true; // a later trading day's data has appeared -> this day is done
      } else {
        const closeBoundary = new Date(`${bucketDayKey}T15:30:00+05:30`).getTime();
        closed = asOfMs >= closeBoundary;
      }
    } else {
      const interval = Number(frameKey);
      const lastNeededTs = last.ts + (interval - 1) * 60000;
      closed = lastAvailableTs >= lastNeededTs;
    }
    return closed ? aggregated : aggregated.slice(0, -1);
  }

  buildReplayTicks(symbols = [], frame = '1', range = null) {
    const datasets = this.loadSelected(symbols, range);
    const streams = datasets.map((dataset) => ({
      symbol: dataset.symbol,
      securityId: dataset.securityId,
      exchange: dataset.exchange,
      candles: frame === '1' || frame === '1m' ? dataset.candles : aggregateCandles(dataset.candles, frame),
      cursor: 0
    })).filter((stream) => stream.candles.length);

    const ticks = [];
    while (true) {
      let nextIndex = -1;
      let nextTs = Infinity;
      for (let i = 0; i < streams.length; i += 1) {
        const stream = streams[i];
        const candle = stream.candles[stream.cursor];
        if (!candle) continue;
        if (candle.ts < nextTs) {
          nextTs = candle.ts;
          nextIndex = i;
        }
      }
      if (nextIndex < 0) break;
      const stream = streams[nextIndex];
      const candle = stream.candles[stream.cursor++];
      ticks.push({
        securityId: stream.securityId,
        exchangeSegment: stream.exchange,
        symbol: stream.symbol,
        ltp: candle.c,
        timestamp: candle.ts,
        candle
      });
    }
    return ticks;
  }
}

module.exports = {
  ReplayRepository,
  aggregateCandles,
  buildCandidateKeys,
  normalizeKey,
  toMs
};
