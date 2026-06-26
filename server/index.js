require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const csv     = require('csv-parse/sync');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const DATA_DIR          = path.join(__dirname, '../data');
const SEED_FILE         = path.join(DATA_DIR, 'seed-securities.json');
const MASTER_FILE       = path.join(DATA_DIR, 'securities-master.json');
const DHAN_MASTER_CSV   = path.join(DATA_DIR, 'api-scrip-master.csv');
const SYMBOL_CONFIG_FILE= path.join(DATA_DIR, 'symbol-configs.json');
const WATCHLIST_FILE    = path.join(DATA_DIR, 'watchlist.json');
const BACKTEST_CACHE_FILE = path.join(DATA_DIR, 'backtest-cache.json');
const NSE_RSS_URL       = 'https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml';
const DHAN_BASE         = 'https://api.dhan.co';
const DHAN_CSV_URL      = 'https://images.dhan.co/api-data/api-scrip-master.csv';

process.env.HTTP_PROXY = '';
process.env.HTTPS_PROXY = '';
process.env.http_proxy = '';
process.env.https_proxy = '';
process.env.NO_PROXY = '127.0.0.1,localhost';

let securitiesCache = [];
let nseNewsCache = { fetchedAt: 0, items: [], lastBuildDate: null };

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  } catch (err) {
    console.warn(`[Storage] Could not write ${path.basename(filePath)}:`, err.message);
  }
}

function readBacktestCache() {
  return readJsonFile(BACKTEST_CACHE_FILE, {});
}

function writeBacktestCache(cache) {
  writeJsonFile(BACKTEST_CACHE_FILE, cache);
}

function storeBacktestCache(securityId, meta, candles, closes) {
  const cache = readBacktestCache();
  cache[String(securityId)] = {
    meta,
    candles,
    closes
  };
  writeBacktestCache(cache);
}

function getBacktestCache(securityId) {
  const cache = readBacktestCache();
  return cache[String(securityId)] || null;
}

function stripXmlCdata(value = '') {
  return String(value)
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim();
}

function decodeXmlEntities(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractXmlTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(stripXmlCdata(m[1])) : '';
}

function parseNseRssXml(xml) {
  const channelMatch = String(xml).match(/<channel[^>]*>([\s\S]*?)<\/channel>/i);
  const channelXml = channelMatch ? channelMatch[1] : String(xml);
  const lastBuildDate = extractXmlTag(channelXml, 'lastBuildDate');
  const itemMatches = [...channelXml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

  const items = itemMatches.map((m) => {
    const itemXml = m[1];
    return {
      title: extractXmlTag(itemXml, 'title'),
      link: extractXmlTag(itemXml, 'link'),
      description: extractXmlTag(itemXml, 'description'),
      pubDate: extractXmlTag(itemXml, 'pubDate'),
      guid: extractXmlTag(itemXml, 'guid') || extractXmlTag(itemXml, 'link') || extractXmlTag(itemXml, 'title')
    };
  }).filter((item) => item.title || item.link);

  return { lastBuildDate, items };
}

function normalizePositionSizing(sizing = {}) {
  const acctSize = Number(sizing.acctSize ?? sizing.accountSize ?? sizing.account) || 0;
  const maxRiskPct = Number(sizing.maxRiskPct) || 0;
  const kellyFrac = Number(sizing.kellyFrac) || 0;
  const riskPerTrade = acctSize > 0 && maxRiskPct > 0 ? acctSize * (maxRiskPct / 100) : 0;
  return { acctSize, maxRiskPct, kellyFrac, riskPerTrade };
}

const EXCHANGE_CHARGE_RATES = {
  intraday: 0.0003521,
  delivery: 0.002222
};

function getExchangeChargeRate(timeframe) {
  return timeframe === 'D' ? EXCHANGE_CHARGE_RATES.delivery : EXCHANGE_CHARGE_RATES.intraday;
}

function enrichTradesWithSizing(trades, sizing = {}, options = {}) {
  const sized = normalizePositionSizing(sizing);
  const hasSizing = sized.riskPerTrade > 0;
  const includeTradingCost = !!options.includeTradingCost;
  const timeframe = options.timeframe || '1';
  const costRate = includeTradingCost ? getExchangeChargeRate(timeframe) : 0;

  const enrichedTrades = (trades || []).map(trade => {
    const riskPerTrade = hasSizing ? sized.riskPerTrade : (Number(trade.riskPerTrade) || 0);
    const riskAmt = Number(trade.riskAmt) || Math.abs(Number(trade.entry) - Number(trade.exit)) || 0;
    const qty = riskPerTrade > 0 && riskAmt > 0 ? Math.max(1, Math.floor(riskPerTrade / riskAmt)) : 0;
    const turnover = qty > 0 ? qty * (Number(trade.entry) + Number(trade.exit)) : 0;
    const grossCashPnl = Number.isFinite(Number(trade.grossCashPnl))
      ? Number(trade.grossCashPnl)
      : (Number.isFinite(Number(trade.cashPnl))
        ? Number(trade.cashPnl)
        : (riskPerTrade ? (Number(trade.rMultiple) || 0) * riskPerTrade : 0));
    const exchangeCost = turnover * costRate;
    const cashPnl = Number.isFinite(Number(trade.cashPnl))
      ? Number(trade.cashPnl)
      : (grossCashPnl - exchangeCost);
    return {
      ...trade,
      riskPerTrade,
      riskAmt,
      qty,
      turnover,
      grossCashPnl,
      exchangeCost,
      cashPnl,
      netCashPnl: cashPnl
    };
  });

  const totalGrossCashPnl = enrichedTrades.reduce((sum, t) => sum + (Number(t.grossCashPnl) || 0), 0);
  const totalExchangeCost = enrichedTrades.reduce((sum, t) => sum + (Number(t.exchangeCost) || 0), 0);
  const totalCashPnl = enrichedTrades.reduce((sum, t) => sum + (Number(t.cashPnl) || 0), 0);
  const cashExpectancy = enrichedTrades.length ? totalCashPnl / enrichedTrades.length : 0;
  const grossCashExpectancy = enrichedTrades.length ? totalGrossCashPnl / enrichedTrades.length : 0;
  let cashPeak = 0;
  let cashCum = 0;
  let cashMaxDD = 0;
  enrichedTrades.forEach(t => {
    cashCum += Number(t.cashPnl) || 0;
    if (cashCum > cashPeak) cashPeak = cashCum;
    const dd = cashPeak - cashCum;
    if (dd > cashMaxDD) cashMaxDD = dd;
  });

  return {
    trades: enrichedTrades,
    sizingSummary: {
      ...sized,
      hasSizing,
      includeTradingCost,
      costRate,
      totalGrossCashPnl,
      totalExchangeCost,
      totalCashPnl,
      cashExpectancy,
      grossCashExpectancy,
      cashMaxDD
    }
  };
}

function makeSizingAwareSimulator(baseSimulate, positionSizing, options = {}) {
  const sized = normalizePositionSizing(positionSizing);
  const includeTradingCost = !!options.includeTradingCost;
  const timeframe = options.timeframe || '1';

  return (closes, config) => {
    const base = baseSimulate(closes, config);
    if (!base || !Array.isArray(base.trades) || !base.trades.length || !sized.riskPerTrade) {
      return base;
    }

    const sizedResult = enrichTradesWithSizing(base.trades, sized, {
      includeTradingCost,
      timeframe
    });
    const summary = {
      ...(base.summary || {}),
      cashPnl: sizedResult.sizingSummary.totalCashPnl,
      grossCashPnl: sizedResult.sizingSummary.totalGrossCashPnl,
      exchangeCost: sizedResult.sizingSummary.totalExchangeCost,
      cashExpectancy: sizedResult.sizingSummary.cashExpectancy,
      grossCashExpectancy: sizedResult.sizingSummary.grossCashExpectancy,
      cashMaxDD: sizedResult.sizingSummary.cashMaxDD,
      cashProfitFactor: cashProfitFactor(sizedResult.trades),
      riskPerTrade: sizedResult.sizingSummary.riskPerTrade,
      qty: sizedResult.trades.reduce((sum, t) => sum + (Number(t.qty) || 0), 0)
    };

    return {
      ...base,
      trades: sizedResult.trades,
      summary
    };
  };
}

function cashProfitFactor(trades = []) {
  let grossWin = 0;
  let grossLoss = 0;
  for (const trade of trades) {
    const pnl = Number(trade.cashPnl) || 0;
    if (pnl > 0) grossWin += pnl;
    else if (pnl < 0) grossLoss += Math.abs(pnl);
  }
  return grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
}

// ── Parse CSV → NSE_EQ only ───────────────────────────────────────────────────
function parseNSEEQ(rawCSV) {
  const records = csv.parse(rawCSV, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`[Securities] Total CSV rows: ${records.length}`);

  // Filter: exchange=NSE, segment=E (equity cash), series=EQ
  const mapped = records
    .filter(r =>
      (r['SEM_EXM_EXCH_ID'] || '').trim() === 'NSE' &&
      (r['SEM_SEGMENT']      || '').trim() === 'E'   &&
      (r['SEM_SERIES']       || '').trim() === 'EQ'
    )
    .map(r => {
      const sym   = (r['SEM_TRADING_SYMBOL']   || '').trim();
      const secId = (r['SEM_SMST_SECURITY_ID'] || '').trim();
      const name  = (r['SM_SYMBOL_NAME'] || r['SEM_CUSTOM_SYMBOL'] || sym).trim();
      if (!sym || !secId) return null;
      return { symbol: sym, name, secId, exchange: 'NSE_EQ' };
    })
    .filter(Boolean);

  // De-duplicate by symbol
  const seen = new Set();
  const deduped = mapped.filter(s => {
    if (seen.has(s.symbol)) return false;
    seen.add(s.symbol);
    return true;
  });

  // Sort alphabetically
  deduped.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return deduped;
}

// ── Load securities on startup ────────────────────────────────────────────────
async function loadOrFetchMaster() {
  // Use cache if fresh (< 24 hours)
  if (fs.existsSync(MASTER_FILE)) {
    const ageHours = (Date.now() - fs.statSync(MASTER_FILE).mtimeMs) / 3_600_000;
    if (ageHours < 24) {
      securitiesCache = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
      console.log(`[Securities] Loaded ${securitiesCache.length} NSE_EQ stocks from cache`);
      return;
    }
  }

  // Try downloading fresh CSV
  try {
    console.log('[Securities] Downloading Dhan master CSV...');
    const response = await axios.get(DHAN_CSV_URL, {
      responseType: 'text',
      timeout: 30000,
      proxy: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/csv,*/*',
        'Referer': 'https://dhan.co'
      }
    });

    // Save raw CSV
    fs.writeFileSync(DHAN_MASTER_CSV, response.data, 'utf8');

    // Parse NSE_EQ only
    securitiesCache = parseNSEEQ(response.data);
    fs.writeFileSync(MASTER_FILE, JSON.stringify(securitiesCache, null, 2), 'utf8');
    console.log(`[Securities] Saved ${securitiesCache.length} NSE_EQ stocks`);

  } catch (err) {
    // If CSV already downloaded, use it
    if (fs.existsSync(DHAN_MASTER_CSV)) {
      console.log('[Securities] Using previously downloaded CSV...');
      const raw = fs.readFileSync(DHAN_MASTER_CSV, 'utf8');
      securitiesCache = parseNSEEQ(raw);
      fs.writeFileSync(MASTER_FILE, JSON.stringify(securitiesCache, null, 2), 'utf8');
      console.log(`[Securities] Parsed ${securitiesCache.length} NSE_EQ stocks from local CSV`);
      return;
    }

    // Final fallback: seed file
    console.warn('[Securities] Using seed data:', err.message);
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    securitiesCache = seed.stocks.filter(s => s.exchange === 'NSE_EQ');
    console.log(`[Securities] Loaded ${securitiesCache.length} from seed`);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Credentials from .env → auto-fill dashboard
app.get('/api/credentials', (req, res) => {
  const clientId = process.env.DHAN_CLIENT_ID    || '';
  const token    = process.env.DHAN_ACCESS_TOKEN || '';
  const ready    = !!(clientId && token &&
    clientId !== 'your_client_id_here' &&
    token    !== 'your_access_token_here');
  res.json({ clientId, token, ready });
});

app.get('/api/news-feed', async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
  const refreshMs = Math.max(10_000, Number(req.query.refreshMs) || 30_000);
  const freshEnough = Date.now() - nseNewsCache.fetchedAt < refreshMs && nseNewsCache.items.length;
  if (freshEnough) {
    return res.json({
      ok: true,
      source: NSE_RSS_URL,
      cached: true,
      fetchedAt: nseNewsCache.fetchedAt,
      lastBuildDate: nseNewsCache.lastBuildDate,
      items: nseNewsCache.items.slice(0, limit)
    });
  }

  try {
    const response = await axios.get(NSE_RSS_URL, {
      timeout: 20000,
      proxy: false,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://www.nseindia.com/'
      }
    });
    const parsed = parseNseRssXml(response.data);
    nseNewsCache = {
      fetchedAt: Date.now(),
      lastBuildDate: parsed.lastBuildDate,
      items: parsed.items
    };
    res.json({
      ok: true,
      source: NSE_RSS_URL,
      cached: false,
      fetchedAt: nseNewsCache.fetchedAt,
      lastBuildDate: nseNewsCache.lastBuildDate,
      items: nseNewsCache.items.slice(0, limit)
    });
  } catch (err) {
    if (nseNewsCache.items.length) {
      return res.json({
        ok: true,
        source: NSE_RSS_URL,
        cached: true,
        stale: true,
        fetchedAt: nseNewsCache.fetchedAt,
        lastBuildDate: nseNewsCache.lastBuildDate,
        items: nseNewsCache.items.slice(0, limit),
        warning: err.response?.status ? `NSE feed returned ${err.response.status}` : err.message
      });
    }
    res.status(502).json({ error: err.response?.status ? `NSE feed returned ${err.response.status}` : err.message });
  }
});

// ── Per-symbol optimized config storage (file-backed, on disk) ───────────────
// Stored at data/symbol-configs.json as { [secId]: { slMultiplier, tpMultiplier,
// minScore, thresholds, params, targetRR, symbol, savedAt } }. This survives
// browser changes, incognito mode, and machine restarts — unlike localStorage,
// which is scoped to one browser profile.
function readSymbolConfigs() {
  try {
    if (!fs.existsSync(SYMBOL_CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(SYMBOL_CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.warn('[SymbolConfig] Read failed, returning empty:', e.message);
    return {};
  }
}

function writeSymbolConfigs(configs) {
  fs.writeFileSync(SYMBOL_CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf8');
}

// Get all saved configs (used on dashboard load)
app.get('/api/symbol-configs', (req, res) => {
  res.json({ ok: true, configs: readSymbolConfigs() });
});

// Save/update one symbol's config
app.post('/api/symbol-configs/:secId', (req, res) => {
  const secId   = String(req.params.secId);
  const configs = readSymbolConfigs();
  configs[secId] = { ...req.body, savedAt: Date.now() };
  writeSymbolConfigs(configs);
  res.json({ ok: true, secId, config: configs[secId] });
});

// Delete one symbol's config (reset to default 2:1)
app.delete('/api/symbol-configs/:secId', (req, res) => {
  const secId   = String(req.params.secId);
  const configs = readSymbolConfigs();
  delete configs[secId];
  writeSymbolConfigs(configs);
  res.json({ ok: true, secId });
});

// ── Watchlist storage (file-backed) ───────────────────────────────────────────
// data/watchlist.json — simple array of { secId, symbol, name, exchange }
function readWatchlist() {
  try {
    if (!fs.existsSync(WATCHLIST_FILE)) return [];
    return JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
  } catch (e) {
    console.warn('[Watchlist] Read failed:', e.message);
    return [];
  }
}
function writeWatchlist(list) {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2), 'utf8');
}

app.get('/api/watchlist', (req, res) => {
  res.json({ ok: true, watchlist: readWatchlist() });
});

app.post('/api/watchlist', (req, res) => {
  const { secId, symbol, name, exchange } = req.body;
  if (!secId || !symbol) return res.status(400).json({ error: 'secId and symbol required' });
  const list = readWatchlist();
  if (list.some(s => s.secId === String(secId))) {
    return res.json({ ok: true, watchlist: list, note: 'already in watchlist' });
  }
  list.push({ secId: String(secId), symbol, name: name || symbol, exchange: exchange || 'NSE_EQ' });
  writeWatchlist(list);
  res.json({ ok: true, watchlist: list });
});

app.delete('/api/watchlist/:secId', (req, res) => {
  const secId = String(req.params.secId);
  const list  = readWatchlist().filter(s => s.secId !== secId);
  writeWatchlist(list);
  res.json({ ok: true, watchlist: list });
});


// Securities list (NSE_EQ only)
app.get('/api/securities', (req, res) => {
  const { q, limit = 5000 } = req.query;
  let results = securitiesCache;
  if (q) {
    const lq = q.toLowerCase();
    results = results.filter(s =>
      s.symbol.toLowerCase().startsWith(lq) ||
      (s.name || '').toLowerCase().includes(lq)
    );
  }
  res.json({ count: results.length, items: results.slice(0, parseInt(limit)) });
});

// Force refresh securities
app.post('/api/securities/refresh', async (req, res) => {
  if (fs.existsSync(MASTER_FILE))     fs.unlinkSync(MASTER_FILE);
  if (fs.existsSync(DHAN_MASTER_CSV)) fs.unlinkSync(DHAN_MASTER_CSV);
  await loadOrFetchMaster();
  res.json({ ok: true, count: securitiesCache.length });
});

// ── Dhan API proxy ────────────────────────────────────────────────────────────
app.all('/dhan/*', async (req, res) => {
  const clientId = req.headers['client-id']    || req.headers['x-client-id'];
  const token    = req.headers['access-token'] || req.headers['x-access-token'];
  const dhanPath = req.path.replace('/dhan', '');
  const dhanUrl  = `${DHAN_BASE}${dhanPath}`;

  if (!clientId || !token) {
    return res.status(401).json({ error: 'Missing client-id or access-token header' });
  }

  try {
    const axiosConfig = {
      method:  req.method,
      url:     dhanUrl,
      proxy:   false,
      headers: {
        'Content-Type': 'application/json',
        'client-id':    clientId,
        'access-token': token
      },
      params:  req.query,
      timeout: 15000
    };
    if (['POST','PUT','PATCH'].includes(req.method) && req.body) {
      axiosConfig.data = req.body;
    }
    const response = await axios(axiosConfig);
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(err.response?.status || 502).json(err.response?.data || { error: err.message });
  }
});

// ── Backtest + Auto-Optimizer ─────────────────────────────────────────────────
const { simulate }  = require('./lib/simulate');
const { optimize }  = require('./lib/optimizer');
const { computeDmaSeries } = require('./lib/indicators');
const { buildTradeWorkbook } = require('./lib/excel-export');

// In-memory store of last backtest's raw closes per symbol, so the optimizer
// endpoint can reuse the same candle data without re-fetching from Dhan.
const _lastBacktestCloses  = new Map();   // securityId -> number[]
const _lastBacktestCandles = new Map();   // securityId -> full candle objects (for chart display)
const _lastBacktestMeta    = new Map();   // securityId -> { fromDate, toDate, timeframe }
const _lastBaselineTrades  = new Map();   // securityId -> trade[] (Step 1 result, for Excel export)
const _lastOptimizedTrades = new Map();   // securityId -> { trades, config, targetRR } (Step 2 result, for Excel export)

app.post('/api/backtest', async (req, res) => {
  const { clientId, token, securityId, exchange, fromDate, toDate, autoOptimize, targetRR, timeframe } = req.body;
  if (!clientId || !token || !securityId) {
    return res.status(400).json({ error: 'clientId, token, securityId required' });
  }
  const tf = timeframe || 'D';   // '1','5','15','25','60' = intraday minutes, 'D' = daily
  try {
    let response;

    if (tf === 'D') {
      response = await axios.post(
        `${DHAN_BASE}/v2/charts/historical`,
        {
          securityId:      String(securityId),
          exchangeSegment: exchange || 'NSE_EQ',
          instrument:      'EQUITY',
          expiryCode:      0,
          oi:              false,
          fromDate:        fromDate || dateStr(-180),
          toDate:          toDate   || dateStr(0)
        },
        {
          proxy: false,
          headers: { 'Content-Type': 'application/json', 'client-id': clientId, 'access-token': token },
          timeout: 30000
        }
      );
    } else {
      // Intraday endpoint — Dhan typically limits this to ~90 days per request,
      // so for longer ranges we chunk into multiple calls and stitch results together.
      const chunks = splitDateRange(fromDate || dateStr(-30), toDate || dateStr(0), 85);
      let merged = { open: [], high: [], low: [], close: [], volume: [], timestamp: [] };

      for (const { from, to } of chunks) {
        const chunkRes = await axios.post(
          `${DHAN_BASE}/v2/charts/intraday`,
          {
            securityId:      String(securityId),
            exchangeSegment: exchange || 'NSE_EQ',
            instrument:      'EQUITY',
            interval:        tf,
            fromDate:        from,
            toDate:          to
          },
          {
            proxy: false,
            headers: { 'Content-Type': 'application/json', 'client-id': clientId, 'access-token': token },
            timeout: 30000
          }
        );
        const d = chunkRes.data || {};
        merged.open.push(...(d.open || []));
        merged.high.push(...(d.high || []));
        merged.low.push(...(d.low || []));
        merged.close.push(...(d.close || []));
        merged.volume.push(...(d.volume || []));
        merged.timestamp.push(...(d.timestamp || []));
      }
      response = { data: merged };
    }

    const candles = buildCandles(response.data);
    const closes  = candles.map(c => c.c);

    // Attach 10/20/50/200-period DMA values onto each candle so the chart
    // can plot them as overlay lines without recomputing client-side.
    const dma = computeDmaSeries(closes, [10, 20, 50, 200]);
    candles.forEach((c, i) => {
      c.dma10  = dma.dma10[i];
      c.dma20  = dma.dma20[i];
      c.dma50  = dma.dma50[i];
      c.dma200 = dma.dma200[i];
    });

    const backtestMeta = {
      fromDate: fromDate || (tf === 'D' ? dateStr(-180) : dateStr(-30)),
      toDate: toDate || dateStr(0),
      timeframe: tf
    };
    _lastBacktestCloses.set(String(securityId), closes);
    _lastBacktestCandles.set(String(securityId), candles);
    _lastBacktestMeta.set(String(securityId), backtestMeta);
    storeBacktestCache(securityId, backtestMeta, candles, closes);

    if (candles.length < 30) {
      return res.json({
        ok: true, candles: candles.length, summary: emptySummaryClient(), trades: 0,
        warning: `Only ${candles.length} candles returned for this range/timeframe. Try a wider date range or a longer interval.`
      });
    }

    // Run baseline simulation at current default config (2:1)
    const baseline = simulate(closes, {});
    const sizedBaseline = enrichTradesWithSizing(baseline.trades, req.body.positionSizing, {
      includeTradingCost: req.body.includeTradingCost,
      timeframe: tf
    });

    // Attach actual candle timestamps to each trade (bar index -> ts) so the
    // frontend can place markers on the chart and show real trade times in the log.
    const tradesWithTs = sizedBaseline.trades.map(t => ({
      ...t,
      entryTs: candles[t.entryBar] ? candles[t.entryBar].ts : null,
      exitTs:  candles[t.exitBar]  ? candles[t.exitBar].ts  : null
    }));

    const payload = {
      ok: true, candles: candles.length,
      summary: {
        ...baseline.summary,
        cashPnl: sizedBaseline.sizingSummary.totalCashPnl,
        grossCashPnl: sizedBaseline.sizingSummary.totalGrossCashPnl,
        exchangeCost: sizedBaseline.sizingSummary.totalExchangeCost,
        cashExpectancy: sizedBaseline.sizingSummary.cashExpectancy,
        grossCashExpectancy: sizedBaseline.sizingSummary.grossCashExpectancy,
        cashMaxDD: sizedBaseline.sizingSummary.cashMaxDD
      },
      sizingSummary: sizedBaseline.sizingSummary,
      trades: tradesWithTs.length,
      tradeList: tradesWithTs
    };

    _lastBaselineTrades.set(String(securityId), { trades: tradesWithTs, symbol: req.body.symbol || securityId, fromDate, toDate, timeframe: tf });

    // Auto-optimize feedback loop — runs immediately after every backtest
    if (autoOptimize !== false) {
      const rr = targetRR || 3.0;
      const t0 = Date.now();
      const optResult = optimize(closes, rr, {
        maxCombos: 999999,
        minTrades: 10,
        simulate: makeSizingAwareSimulator(simulate, req.body.positionSizing, {
          includeTradingCost: req.body.includeTradingCost,
          timeframe: tf
        })
      });
      if (optResult.best) {
        const sizedBest = enrichTradesWithSizing(optResult.best.trades || [], req.body.positionSizing, {
          includeTradingCost: req.body.includeTradingCost,
          timeframe: tf
        });
        optResult.best.trades = sizedBest.trades.map(t => ({
          ...t,
          entryTs: candles[t.entryBar] ? candles[t.entryBar].ts : null,
          exitTs:  candles[t.exitBar]  ? candles[t.exitBar].ts  : null
        }));
        optResult.best.summary = {
          ...optResult.best.summary,
          cashPnl: sizedBest.sizingSummary.totalCashPnl,
          grossCashPnl: sizedBest.sizingSummary.totalGrossCashPnl,
          exchangeCost: sizedBest.sizingSummary.totalExchangeCost,
          cashExpectancy: sizedBest.sizingSummary.cashExpectancy,
          grossCashExpectancy: sizedBest.sizingSummary.grossCashExpectancy,
          cashMaxDD: sizedBest.sizingSummary.cashMaxDD
        };
        _lastOptimizedTrades.set(String(securityId), {
          trades: optResult.best.trades, config: optResult.best.config,
          targetRR: rr, symbol: req.body.symbol || securityId
        });
      }
      payload.optimization = {
        targetRR: rr,
        searchTimeMs: Date.now() - t0,
        combosSearched: optResult.searched,
        qualified: optResult.qualified,
        baseline: baseline.summary,
        best: optResult.best,
        leaderboard: optResult.leaderboard
      };
    }

    res.json(payload);
  } catch (err) {
    const cachedCandles = _lastBacktestCandles.get(String(securityId));
    const cachedCloses = _lastBacktestCloses.get(String(securityId));
    const memoryMeta = _lastBacktestMeta.get(String(securityId)) || null;
    const cachedDisk = getBacktestCache(securityId);
    const requestedMeta = {
      fromDate: fromDate || (tf === 'D' ? dateStr(-180) : dateStr(-30)),
      toDate: toDate || dateStr(0),
      timeframe: tf
    };
    const status = err.response?.status;
    const authFailure = status === 401 || status === 403;
    const cacheableFetchFailure = authFailure || status === 429 || status === 502 || status === 503 || status === 504 || !err.response;
    const memoryCacheMatches = !!(
      cachedCandles && cachedCloses && memoryMeta &&
      memoryMeta.fromDate === requestedMeta.fromDate &&
      memoryMeta.toDate === requestedMeta.toDate &&
      memoryMeta.timeframe === requestedMeta.timeframe
    );
    const diskCacheMatches = !!(
      cachedDisk && cachedDisk.candles && cachedDisk.closes && cachedDisk.meta &&
      cachedDisk.meta.fromDate === requestedMeta.fromDate &&
      cachedDisk.meta.toDate === requestedMeta.toDate &&
      cachedDisk.meta.timeframe === requestedMeta.timeframe
    );
    const canReuseCache = cacheableFetchFailure && (memoryCacheMatches || diskCacheMatches);

    if (canReuseCache) {
      const closes = memoryCacheMatches ? cachedCloses : cachedDisk.closes;
      const candles = memoryCacheMatches ? cachedCandles : cachedDisk.candles;
      const baseline = simulate(closes, {});
      const sizedBaseline = enrichTradesWithSizing(baseline.trades, req.body.positionSizing, {
        includeTradingCost: req.body.includeTradingCost,
        timeframe: tf
      });
      const tradesWithTs = sizedBaseline.trades.map(t => ({
        ...t,
        entryTs: candles[t.entryBar] ? candles[t.entryBar].ts : null,
        exitTs:  candles[t.exitBar] ? candles[t.exitBar].ts : null
      }));
      const payload = {
        ok: true,
        candles: candles.length,
        warning: `Used cached candles because Dhan returned ${status || 'a network error'} for this exact backtest range.`,
        summary: {
          ...baseline.summary,
          cashPnl: sizedBaseline.sizingSummary.totalCashPnl,
          grossCashPnl: sizedBaseline.sizingSummary.totalGrossCashPnl,
          exchangeCost: sizedBaseline.sizingSummary.totalExchangeCost,
          cashExpectancy: sizedBaseline.sizingSummary.cashExpectancy,
          grossCashExpectancy: sizedBaseline.sizingSummary.grossCashExpectancy,
          cashMaxDD: sizedBaseline.sizingSummary.cashMaxDD
        },
        sizingSummary: sizedBaseline.sizingSummary,
        trades: tradesWithTs.length,
        tradeList: tradesWithTs
      };
      _lastBaselineTrades.set(String(securityId), { trades: tradesWithTs, symbol: req.body.symbol || securityId, fromDate: requestedMeta.fromDate, toDate: requestedMeta.toDate, timeframe: tf });
      return res.json(payload);
    }
    if (authFailure) {
      return res.status(status).json({
        error: `Dhan authentication failed (${status}). Refresh the Dhan access token, or run the exact range/timeframe again if cached candles exist locally.`
      });
    }
    if (status === 429) {
      return res.status(status).json({
        error: 'Dhan rate limit hit (429). Wait a minute and retry, or rerun an exact cached range/timeframe.'
      });
    }
    res.status(err.response?.status || 502).json({ error: err.response?.data?.message || err.message });
  }
});

// Re-run optimizer on already-fetched candles (no Dhan re-fetch) — for "try a different target R:R" without re-pulling data
app.post('/api/optimize', (req, res) => {
  const { securityId, targetRR, maxCombos, minTrades, positionSizing, includeTradingCost, timeframe } = req.body;
  const cachedDisk = getBacktestCache(securityId);
  const closes  = _lastBacktestCloses.get(String(securityId)) || cachedDisk?.closes;
  const candles = _lastBacktestCandles.get(String(securityId)) || cachedDisk?.candles || [];
  if (!closes) {
    return res.status(400).json({ error: 'No cached candles for this security. Run a backtest first.' });
  }
  const t0 = Date.now();
  const result = optimize(closes, targetRR || 3.0, {
    maxCombos: maxCombos || 999999,
    minTrades: minTrades || 10,
    simulate: makeSizingAwareSimulator(simulate, positionSizing, {
      includeTradingCost,
      timeframe
    })
  });

  // Attach real candle timestamps to the best config's trades for chart markers + trade log
  if (result.best) {
    const sizedBest = enrichTradesWithSizing(result.best.trades || [], positionSizing, {
      includeTradingCost,
      timeframe
    });
    result.best.trades = sizedBest.trades.map(t => ({
      ...t,
      entryTs: candles[t.entryBar] ? candles[t.entryBar].ts : null,
      exitTs:  candles[t.exitBar]  ? candles[t.exitBar].ts  : null
    }));
    result.best.summary = {
      ...result.best.summary,
      cashPnl: sizedBest.sizingSummary.totalCashPnl,
      grossCashPnl: sizedBest.sizingSummary.totalGrossCashPnl,
      exchangeCost: sizedBest.sizingSummary.totalExchangeCost,
      cashExpectancy: sizedBest.sizingSummary.cashExpectancy,
      grossCashExpectancy: sizedBest.sizingSummary.grossCashExpectancy,
      cashMaxDD: sizedBest.sizingSummary.cashMaxDD
    };
    _lastOptimizedTrades.set(String(securityId), {
      trades: result.best.trades, config: result.best.config,
      targetRR: targetRR || 3.0, symbol: req.body.symbol || securityId
    });
  }

  res.json({ ok: true, searchTimeMs: Date.now() - t0, ...result });
});

// Returns the full OHLC candles from the last backtest, for chart rendering
app.get('/api/backtest/candles/:securityId', (req, res) => {
  const securityId = String(req.params.securityId);
  const cachedDisk = getBacktestCache(securityId);
  const candles = _lastBacktestCandles.get(securityId) || cachedDisk?.candles;
  if (!candles) return res.status(404).json({ error: 'No cached candles for this security.' });
  res.json({
    ok: true,
    count: candles.length,
    meta: cachedDisk?.meta || null,
    source: _lastBacktestCandles.has(securityId) ? 'memory' : 'disk',
    candles
  });
});

// ── Excel exports — Step 1 (baseline) and Step 2 (optimizer) trade lists ────
// Both read from the in-memory cache populated by /api/backtest and
// /api/optimize, so no re-simulation happens here — just formatting.
app.get('/api/backtest/export/:securityId', async (req, res) => {
  const cached = _lastBaselineTrades.get(String(req.params.securityId));
  if (!cached || !cached.trades.length) {
    return res.status(404).json({ error: 'No baseline backtest trades cached for this security. Run Step 1 first.' });
  }
  try {
    const buf = await buildTradeWorkbook({
      trades: cached.trades,
      symbol: cached.symbol,
      title: 'Backtest — Baseline (2:1)',
      meta: {
        'Date range': `${cached.fromDate} to ${cached.toDate}`,
        'Candle size': cached.timeframe === 'D' ? 'Daily' : `${cached.timeframe} minute`
      }
    });
    const filename = `${cached.symbol}_backtest_baseline_${dateStr(0)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Could not generate Excel file: ' + err.message });
  }
});

app.get('/api/optimize/export/:securityId', async (req, res) => {
  const cached = _lastOptimizedTrades.get(String(req.params.securityId));
  if (!cached || !cached.trades.length) {
    return res.status(404).json({ error: 'No optimizer trades cached for this security. Run Step 2 first.' });
  }
  try {
    const c = cached.config || {};
    const thr = c.thresholds || {};
    const buf = await buildTradeWorkbook({
      trades: cached.trades,
      symbol: cached.symbol,
      title: `Optimizer — Best Config (${cached.targetRR}:1 target)`,
      meta: {
        'Stop loss': `${c.slMultiplier}× ATR`,
        'Target': `${c.tpMultiplier}× ATR`,
        'Min indicators required': `${thr.minScore || 6}/8`
      }
    });
    const filename = `${cached.symbol}_optimizer_${cached.targetRR}to1_${dateStr(0)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Could not generate Excel file: ' + err.message });
  }
});

// ── Batch backtest + optimize queue ───────────────────────────────────────────
// Runs sequentially through a list of symbols with a fixed delay between each,
// to stay safely under Dhan's API rate limits. State is in-memory (a single
// batch run at a time) and exposed via polling so the frontend can show a
// live progress bar without needing WebSockets.
const BATCH_DELAY_MS = 1500;   // fixed delay between symbols, per user's choice

let batchState = {
  running: false,
  total: 0,
  completed: 0,
  currentSymbol: null,
  results: [],     // [{ secId, symbol, status: 'done'|'error'|'skipped', summary, optimized, error }]
  startedAt: null,
  finishedAt: null,
  cancelRequested: false
};

app.post('/api/batch/start', async (req, res) => {
  if (batchState.running) {
    return res.status(409).json({ error: 'A batch run is already in progress.' });
  }
  const { clientId, token, symbols, fromDate, toDate, timeframe, targetRR, autoApply, positionSizing } = req.body;
  if (!clientId || !token)            return res.status(400).json({ error: 'clientId and token required' });
  if (!symbols || !symbols.length)    return res.status(400).json({ error: 'symbols array required' });

  batchState = {
    running: true,
    total: symbols.length,
    completed: 0,
    currentSymbol: null,
    results: [],
    startedAt: Date.now(),
    finishedAt: null,
    cancelRequested: false
  };

  res.json({ ok: true, message: `Batch started for ${symbols.length} symbols.` });

  // Run the queue in the background — NOT awaited, so the HTTP response
  // returns immediately and the frontend polls /api/batch/status for progress.
  runBatchQueue({ clientId, token, symbols, fromDate, toDate, timeframe, targetRR, autoApply, positionSizing });
});

app.get('/api/batch/status', (req, res) => {
  res.json({ ok: true, ...batchState });
});

app.post('/api/batch/cancel', (req, res) => {
  batchState.cancelRequested = true;
  res.json({ ok: true, message: 'Cancellation requested — batch will stop after the current symbol.' });
});

async function runBatchQueue({ clientId, token, symbols, fromDate, toDate, timeframe, targetRR, autoApply, positionSizing }) {
  const tf = timeframe || '5';
  const rr = targetRR || 3.0;

  for (const sym of symbols) {
    if (batchState.cancelRequested) {
      batchState.results.push({ secId: sym.secId, symbol: sym.symbol, status: 'skipped', error: 'Cancelled by user' });
      continue;
    }

    batchState.currentSymbol = sym.symbol;

    try {
      const candles = await fetchCandlesForBacktest({
        clientId, token, securityId: sym.secId, exchange: sym.exchange || 'NSE_EQ',
        fromDate: fromDate || dateStr(-60), toDate: toDate || dateStr(0), timeframe: tf
      });

      if (candles.length < 30) {
        batchState.results.push({
          secId: sym.secId, symbol: sym.symbol, status: 'error',
          error: `Only ${candles.length} candles returned — insufficient data`
        });
      } else {
        const closes = candles.map(c => c.c);
        _lastBacktestCloses.set(String(sym.secId), closes);
        _lastBacktestCandles.set(String(sym.secId), candles);

        const baseline = simulate(closes, {});
        const sizedBaseline = enrichTradesWithSizing(baseline.trades, positionSizing, {
          includeTradingCost: false,
          timeframe: tf
        });
      const optResult = optimize(closes, rr, {
        maxCombos: 999999,
        minTrades: 10,
        simulate: makeSizingAwareSimulator(simulate, positionSizing, {
          includeTradingCost: false,
          timeframe: tf
        })
      });

        let appliedConfig = null;
        if (optResult.best && autoApply !== false) {
          const c = optResult.best.config;
          appliedConfig = {
            slMultiplier: c.slMultiplier, tpMultiplier: c.tpMultiplier,
            minScore: c.thresholds.minScore || 6, thresholds: c.thresholds, params: c.params,
            targetRR: rr, symbol: sym.symbol, savedAt: Date.now()
          };
          const configs = readSymbolConfigs();
          configs[String(sym.secId)] = appliedConfig;
          writeSymbolConfigs(configs);
        }

        const sizedBest = optResult.best ? enrichTradesWithSizing(optResult.best.trades || [], positionSizing, {
          includeTradingCost: false,
          timeframe: tf
        }) : null;
        if (optResult.best && sizedBest) {
          optResult.best.summary = {
            ...optResult.best.summary,
            cashPnl: sizedBest.sizingSummary.totalCashPnl,
            grossCashPnl: sizedBest.sizingSummary.totalGrossCashPnl,
            exchangeCost: sizedBest.sizingSummary.totalExchangeCost,
            cashExpectancy: sizedBest.sizingSummary.cashExpectancy,
            grossCashExpectancy: sizedBest.sizingSummary.grossCashExpectancy,
            cashMaxDD: sizedBest.sizingSummary.cashMaxDD
          };
        }

        batchState.results.push({
          secId: sym.secId, symbol: sym.symbol, status: 'done',
          candleCount: candles.length,
          baseline: {
            ...baseline.summary,
            cashPnl: sizedBaseline.sizingSummary.totalCashPnl,
            grossCashPnl: sizedBaseline.sizingSummary.totalGrossCashPnl,
            exchangeCost: sizedBaseline.sizingSummary.totalExchangeCost,
            cashExpectancy: sizedBaseline.sizingSummary.cashExpectancy,
            grossCashExpectancy: sizedBaseline.sizingSummary.grossCashExpectancy,
            cashMaxDD: sizedBaseline.sizingSummary.cashMaxDD
          },
          optimized: optResult.best ? optResult.best.summary : null,
          applied: !!appliedConfig
        });
      }
    } catch (err) {
      batchState.results.push({
        secId: sym.secId, symbol: sym.symbol, status: 'error',
        error: err.response?.data?.message || err.message
      });
    }

    batchState.completed++;
    if (batchState.completed < batchState.total) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  batchState.running = false;
  batchState.currentSymbol = null;
  batchState.finishedAt = Date.now();
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Shared candle-fetching logic, extracted so both /api/backtest and the batch
// queue use identical chunking/timeframe behavior.
async function fetchCandlesForBacktest({ clientId, token, securityId, exchange, fromDate, toDate, timeframe }) {
  let response;
  if (timeframe === 'D') {
    response = await axios.post(
      `${DHAN_BASE}/v2/charts/historical`,
      { securityId: String(securityId), exchangeSegment: exchange, instrument: 'EQUITY', expiryCode: 0, oi: false, fromDate, toDate },
      { proxy: false, headers: { 'Content-Type': 'application/json', 'client-id': clientId, 'access-token': token }, timeout: 30000 }
    );
  } else {
    const chunks = splitDateRange(fromDate, toDate, 85);
    let merged = { open: [], high: [], low: [], close: [], volume: [], timestamp: [] };
    for (const { from, to } of chunks) {
      const chunkRes = await axios.post(
        `${DHAN_BASE}/v2/charts/intraday`,
        { securityId: String(securityId), exchangeSegment: exchange, instrument: 'EQUITY', interval: timeframe, fromDate: from, toDate: to },
        { proxy: false, headers: { 'Content-Type': 'application/json', 'client-id': clientId, 'access-token': token }, timeout: 30000 }
      );
      const d = chunkRes.data || {};
      merged.open.push(...(d.open || []));
      merged.high.push(...(d.high || []));
      merged.low.push(...(d.low || []));
      merged.close.push(...(d.close || []));
      merged.volume.push(...(d.volume || []));
      merged.timestamp.push(...(d.timestamp || []));
    }
    response = { data: merged };
  }
  return buildCandles(response.data);
}

function dateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Splits a [from, to] range into chunks of at most `maxDays` each.
// Dhan's intraday endpoint rejects ranges beyond ~90 days, so long backtests
// must be fetched in pieces and stitched together.
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

function emptySummaryClient() {
  return { total: 0, wins: 0, losses: 0, winRate: 0, pnlR: 0, expectancy: 0, avgWinR: 0, avgLossR: 0, maxDD: 0, profitFactor: 0 };
}

function buildCandles(raw) {
  const open  = raw.open      || [];
  const high  = raw.high      || [];
  const low   = raw.low       || [];
  const close = raw.close     || [];
  const vol   = raw.volume    || [];
  const ts    = raw.timestamp || [];
  return open.map((o, i) => ({
    ts: ts[i], o: parseFloat(o), h: parseFloat(high[i]),
    l: parseFloat(low[i]), c: parseFloat(close[i]), v: parseInt(vol[i] || 0)
  })).filter(c => c.o > 0 && c.c > 0);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadOrFetchMaster();
  app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════╗`);
    console.log(`║  CLAUDE Scalping System              ║`);
    console.log(`║  http://localhost:${PORT}               ║`);
    console.log(`║  Symbols: ${String(securitiesCache.length).padEnd(6)} NSE_EQ stocks        ║`);
    console.log(`╚══════════════════════════════════════╝\n`);
  });
})();
