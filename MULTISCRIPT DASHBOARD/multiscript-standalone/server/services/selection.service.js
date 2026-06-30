const fs = require('node:fs');
const path = require('node:path');
const timeframeConfig = require('../config/timeframe.config');

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function normalizeEntries(input, timeframe) {
  const list = Array.isArray(input) ? input : (input.symbols || input.items || []);
  return list.map((entry, index) => ({
    symbol: entry.symbol,
    name: entry.name || entry.symbol,
    exchange: entry.exchange || 'NSE_EQ',
    secId: String(entry.secId || entry.securityId || ''),
    rank: Number(entry.rank || index + 1),
    score: Number(entry.score || 0),
    config: entry.config || entry.params || {},
    timeframe
  })).filter((entry) => entry.symbol && entry.secId);
}

function createSelectionService({ rootDir, maxPerFrame = 5 }) {
  const optimizedDir = path.join(rootDir, 'data', 'optimized');
  const symbolConfigFile = path.join(optimizedDir, 'symbol-configs.json');
  const watchlistFile = path.join(rootDir, 'data', 'watchlist.json');

  function loadOptimizedCatalog() {
    const catalog = {};
    for (const item of timeframeConfig) {
      const filePath = path.join(optimizedDir, `${item.timeframe}.json`);
      catalog[item.key] = normalizeEntries(loadJson(filePath, []), item.key).sort((a, b) => a.rank - b.rank || b.score - a.score);
    }
    return catalog;
  }

  function loadSymbolOverrides() {
    return loadJson(symbolConfigFile, {});
  }

  function loadRuntimeConfig() {
    const data = loadJson(symbolConfigFile, {});
    return data._runtime || {};
  }

  function saveRuntimeConfig(nextRuntime = {}) {
    const current = loadJson(symbolConfigFile, {});
    const next = {
      ...current,
      _runtime: {
        ...(current._runtime || {}),
        ...nextRuntime
      }
    };
    fs.mkdirSync(path.dirname(symbolConfigFile), { recursive: true });
    fs.writeFileSync(symbolConfigFile, JSON.stringify(next, null, 2), 'utf8');
    return next._runtime;
  }

  function loadWatchlist() {
    return loadJson(watchlistFile, { symbols: [] });
  }

  function saveWatchlist(next) {
    fs.mkdirSync(path.dirname(watchlistFile), { recursive: true });
    fs.writeFileSync(watchlistFile, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  function buildDefaultWatchlist(catalog) {
    const seen = new Map();
    for (const item of timeframeConfig) {
      const rows = (catalog[item.key] || []).slice(0, maxPerFrame);
      for (const row of rows) {
        if (!seen.has(row.symbol)) {
          seen.set(row.symbol, {
            symbol: row.symbol,
            name: row.name,
            exchange: row.exchange,
            secId: row.secId,
            enabledFrames: [],
            primaryTimeframe: item.key
          });
        }
        seen.get(row.symbol).enabledFrames.push(item.key);
      }
    }
    return { symbols: Array.from(seen.values()) };
  }

  function mergeWatchlist(baseWatchlist, catalog, overrides = {}) {
    const map = new Map();
    for (const row of baseWatchlist.symbols || []) {
      map.set(row.symbol, {
        symbol: row.symbol,
        name: row.name,
        exchange: row.exchange || 'NSE_EQ',
        secId: String(row.secId || ''),
        enabledFrames: Array.from(new Set(row.enabledFrames || [])),
        primaryTimeframe: row.primaryTimeframe || '15'
      });
    }

    for (const item of timeframeConfig) {
      for (const row of catalog[item.key] || []) {
        const existing = map.get(row.symbol) || {
          symbol: row.symbol,
          name: row.name,
          exchange: row.exchange,
          secId: row.secId,
          enabledFrames: [],
          primaryTimeframe: item.key
        };
        if (!existing.enabledFrames.includes(item.key) && existing.enabledFrames.length < 5) {
          existing.enabledFrames.push(item.key);
        }
        map.set(row.symbol, existing);
      }
    }

    for (const [symbol, override] of Object.entries(overrides)) {
      const row = map.get(symbol);
      if (row) {
        if (override.primaryTimeframe) row.primaryTimeframe = override.primaryTimeframe;
        if (Array.isArray(override.enabledFrames)) row.enabledFrames = Array.from(new Set(override.enabledFrames));
      }
    }

    return { symbols: Array.from(map.values()) };
  }

  function resolveFrameConfig(row, frame, catalog, overrides = {}) {
    const list = catalog[frame] || [];
    const entry = list.find((item) => item.symbol === row.symbol) || null;
    const overrideKey = `${row.exchange || 'NSE_EQ'}:${row.secId}:${frame}`;
    const override = overrides[overrideKey] || {};
    const config = {
      minScore: override.minScore ?? entry?.config?.minScore ?? 6,
      slMultiplier: override.slMultiplier ?? entry?.config?.slMultiplier ?? 1.2,
      tpMultiplier: override.tpMultiplier ?? entry?.config?.tpMultiplier ?? 3,
      kellyFraction: override.kellyFraction ?? entry?.config?.kellyFraction ?? 0.25,
      rr: override.rr ?? override.targetRR ?? entry?.config?.rr ?? 3,
      fastPeriod: override.fastPeriod ?? entry?.config?.fastPeriod ?? 5,
      slowPeriod: override.slowPeriod ?? entry?.config?.slowPeriod ?? 20,
      slopeLookback: override.slopeLookback ?? entry?.config?.slopeLookback ?? 5,
      rsiPeriod: override.rsiPeriod ?? override.params?.rsiPeriod ?? entry?.config?.rsiPeriod ?? 14,
      atrPeriod: override.atrPeriod ?? entry?.config?.atrPeriod ?? 14,
      winRate: override.winRate ?? entry?.config?.winRate ?? 0.55
    };
    return {
      symbol: row.symbol,
      name: row.name,
      exchange: row.exchange || 'NSE_EQ',
      secId: String(row.secId || ''),
      frame,
      usingDefault: !entry && !override.minScore,
      config,
      configKey: overrideKey
    };
  }

  return {
    watchlistFile,
    loadOptimizedCatalog,
    loadSymbolOverrides,
    loadRuntimeConfig,
    saveRuntimeConfig,
    loadWatchlist,
    saveWatchlist,
    buildDefaultWatchlist,
    mergeWatchlist,
    resolveFrameConfig
  };
}

module.exports = { createSelectionService };
