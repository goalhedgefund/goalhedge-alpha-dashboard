const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DhanWsClient } = require('../adapters/dhan/dhan.ws.client');
const { normalizeChartResponse } = require('../engines/candle.engine');
const { DEFAULT_COMBO, evaluateCashScalper } = require('../engines/cash-scalper.strategy');

const DEFAULT_SETTINGS = {
  inventoryLimit: 100000,
  carryForwardPct: 50,
  dailyTargetPct: 1,
  tradeSizePct: 10,
  intradayCostPct: 0.12,
  deliveryCostPct: 0.28,
  scalpTargetPct: 1,
  buyDeclinePct: 0.6,
  sessionStart: '09:15',
  squareOff: '15:20'
};

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function istHHMM(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
}

function minutesOfDay(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function normalizeHHMM(value, fallback) {
  const text = String(value || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(text)) return fallback;
  const [h, m] = text.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) return fallback;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function createCashScalperService({ dataDir, rootDir, exchangeConfig, restClient }) {
  const filePath = path.join(dataDir, 'cash-scalper.json');
  const masterCsvFile = path.join(dataDir, 'api-scrip-master.csv');
  const masterJsonFile = path.join(dataDir, 'cash-symbol-master.json');
  const combosFile = path.join(dataDir, 'cash-scalper-combos.json');
  const events = new EventEmitter();
  const quotes = new Map();
  const strategyState = new Map();
  let wsClient = null;
  let connectionState = 'DISCONNECTED';

  function load() {
    const saved = readJson(filePath, {});
    return {
      settings: {
        ...DEFAULT_SETTINGS,
        ...(saved.settings || {})
      },
      symbols: Array.isArray(saved.symbols) ? saved.symbols : [],
      positions: Array.isArray(saved.positions) ? saved.positions : [],
      trades: Array.isArray(saved.trades) ? saved.trades : [],
      updatedAt: saved.updatedAt || null
    };
  }

  function save(next) {
    const current = load();
    const payload = {
      settings: {
        ...current.settings,
        ...(next.settings || {})
      },
      symbols: Array.isArray(next.symbols) ? next.symbols : current.symbols,
      positions: Array.isArray(next.positions) ? next.positions : current.positions,
      trades: Array.isArray(next.trades) ? next.trades : current.trades,
      updatedAt: new Date().toISOString()
    };
    payload.settings.inventoryLimit = Math.max(0, Number(payload.settings.inventoryLimit) || 0);
    payload.settings.carryForwardPct = clamp(payload.settings.carryForwardPct, 0, 100);
    payload.settings.tradeSizePct = clamp(payload.settings.tradeSizePct, 1, 100);
    payload.settings.dailyTargetPct = clamp(payload.settings.dailyTargetPct, 0, 100);
    payload.settings.intradayCostPct = clamp(payload.settings.intradayCostPct, 0, 5);
    payload.settings.deliveryCostPct = clamp(payload.settings.deliveryCostPct, 0, 5);
    payload.settings.scalpTargetPct = clamp(payload.settings.scalpTargetPct, 0, 25);
    payload.settings.buyDeclinePct = clamp(payload.settings.buyDeclinePct, 0, 25);
    payload.settings.sessionStart = normalizeHHMM(payload.settings.sessionStart, DEFAULT_SETTINGS.sessionStart);
    payload.settings.squareOff = normalizeHHMM(payload.settings.squareOff, DEFAULT_SETTINGS.squareOff);
    writeJson(filePath, payload);
    emit();
    return payload;
  }

  function knownSymbolRows() {
    const masterRows = loadSymbolMaster();
    if (masterRows.length) return masterRows;

    const rows = [];
    const seen = new Set();
    function add(row = {}) {
      const symbol = String(row.symbol || '').trim().toUpperCase();
      const secId = String(row.secId || row.securityId || '').trim();
      if (!symbol || !secId || seen.has(`${symbol}:${secId}`)) return;
      seen.add(`${symbol}:${secId}`);
      rows.push({
        symbol,
        name: row.name || symbol,
        exchangeSegment: row.exchangeSegment || row.exchange || 'NSE_EQ',
        securityId: secId
      });
    }

    for (const row of readJson(path.join(dataDir, 'watchlist.json'), { symbols: [] }).symbols || []) add(row);
    const optimizedDir = path.join(dataDir, 'optimized');
    for (const file of ['1m.json', '5m.json', '15m.json', '60m.json', 'D.json']) {
      for (const row of readJson(path.join(optimizedDir, file), []) || []) add(row);
    }
    const cacheDir = path.join(dataDir, 'replay-cache');
    try {
      for (const file of fs.readdirSync(cacheDir).filter((item) => item.endsWith('.json')).slice(0, 250)) {
        const meta = readJson(path.join(cacheDir, file), {});
        add({ symbol: meta.symbol || file.split('_')[0], securityId: meta.securityId, exchangeSegment: meta.exchangeSegment || 'NSE_EQ' });
      }
    } catch {
      /* optional cache */
    }
    return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  function buildSymbolMasterFromCsv() {
    if (!fs.existsSync(masterCsvFile)) return [];
    const content = fs.readFileSync(masterCsvFile, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const headers = parseCsvLine(lines[0]);
    const rows = [];
    const seen = new Set();

    for (const line of lines.slice(1)) {
      const cols = parseCsvLine(line);
      const row = {};
      headers.forEach((header, idx) => { row[header] = cols[idx] || ''; });
      if (row.SEM_EXM_EXCH_ID !== 'NSE') continue;
      if (row.SEM_SEGMENT !== 'E') continue;
      if (row.SEM_INSTRUMENT_NAME !== 'EQUITY') continue;
      if (row.SEM_SERIES !== 'EQ') continue;
      const symbol = String(row.SEM_TRADING_SYMBOL || '').trim().toUpperCase();
      const securityId = String(row.SEM_SMST_SECURITY_ID || '').trim();
      if (!symbol || !securityId || seen.has(symbol)) continue;
      seen.add(symbol);
      rows.push({
        symbol,
        name: row.SM_SYMBOL_NAME || row.SEM_CUSTOM_SYMBOL || symbol,
        exchangeSegment: 'NSE_EQ',
        securityId
      });
    }
    rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    writeJson(masterJsonFile, {
      source: 'Dhan api-scrip-master.csv',
      generatedAt: new Date().toISOString(),
      count: rows.length,
      rows
    });
    return rows;
  }

  function loadSymbolMaster() {
    const cached = readJson(masterJsonFile, null);
    if (cached && Array.isArray(cached.rows) && cached.rows.length) return cached.rows;
    return buildSymbolMasterFromCsv();
  }

  function searchSymbols(query = '') {
    const q = String(query || '').trim().toUpperCase();
    if (!q) return knownSymbolRows().slice(0, 50);
    return knownSymbolRows().filter((row) => row.symbol.includes(q)).slice(0, 50);
  }

  function resolveSymbol(symbol) {
    const key = String(symbol || '').trim().toUpperCase();
    if (!key) return null;
    return knownSymbolRows().find((row) => row.symbol === key) || null;
  }

  function normalizeSymbol(row = {}, settings = load().settings) {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const resolved = resolveSymbol(symbol);
    const securityId = String(row.securityId || row.secId || resolved?.securityId || '').trim();
    if (!symbol) throw new Error('Symbol is required');
    if (!securityId) throw new Error(`Dhan security ID not found for ${symbol}. Refresh the master list or enter a valid NSE cash symbol.`);
    return {
      symbol,
      name: row.name || resolved?.name || symbol,
      exchangeSegment: row.exchangeSegment || row.exchange || resolved?.exchangeSegment || 'NSE_EQ',
      securityId,
      scriptLimit: Math.max(0, Number(row.scriptLimit) || Number(settings.inventoryLimit) || 0),
      enabled: row.enabled !== false,
      comboKey: row.comboKey || symbol
    };
  }

  function upsertSymbol(row) {
    const current = load();
    const nextRow = normalizeSymbol(row, current.settings);
    const symbols = current.symbols.filter((item) => item.symbol !== nextRow.symbol);
    symbols.push(nextRow);
    save({ ...current, symbols: symbols.sort((a, b) => a.symbol.localeCompare(b.symbol)) });
    if (wsClient && connectionState === 'CONNECTED') subscribeLive();
    refreshStrategies([nextRow.symbol]).catch((err) => {
      strategyState.set(nextRow.symbol, { action: 'WAIT', direction: 'NONE', score: 0, reason: err.message, combo: DEFAULT_COMBO });
      emit();
    });
    return getState();
  }

  function removeSymbol(symbol) {
    const current = load();
    const key = String(symbol || '').toUpperCase();
    save({
      ...current,
      symbols: current.symbols.filter((row) => row.symbol !== key),
      positions: current.positions.filter((row) => row.symbol !== key)
    });
    if (wsClient && connectionState === 'CONNECTED') subscribeLive();
    return getState();
  }

  function getPosition(current, symbol) {
    return current.positions.find((row) => row.symbol === symbol) || {
      symbol,
      longQty: 0,
      longAvg: 0,
      shortQty: 0,
      shortAvg: 0
    };
  }

  function updatePosition(current, nextPosition) {
    const positions = current.positions.filter((row) => row.symbol !== nextPosition.symbol);
    if (nextPosition.longQty > 0 || nextPosition.shortQty > 0) positions.push(nextPosition);
    return positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  function planRows(current = load()) {
    const settings = current.settings;
    const now = istHHMM();
    const nowMin = minutesOfDay(now);
    const afterSquareOff = nowMin >= minutesOfDay(settings.squareOff);
    const carryForwardCap = Number(settings.inventoryLimit) * (Number(settings.carryForwardPct) / 100);
    const deployedLong = current.positions.reduce((sum, pos) => sum + (Number(pos.longQty) || 0) * (quotes.get(pos.symbol)?.ltp || Number(pos.longAvg) || 0), 0);

    return current.symbols.map((symbolRow) => {
      const quote = quotes.get(symbolRow.symbol) || {};
      const ltp = Number(quote.ltp || 0);
      const strategy = { ...(strategyState.get(symbolRow.symbol) || { action: 'WAIT', direction: 'NONE', score: 0, reason: 'strategy not refreshed', levels: {}, indicators: {}, combo: getCombo(symbolRow.symbol) }) };
      if (strategy.combo?.enabled === false) {
        strategy.action = 'WAIT';
        strategy.direction = 'DISABLED';
        strategy.reason = 'Disabled by latest backtest optimizer';
      }
      const pos = getPosition(current, symbolRow.symbol);
      const scriptLimit = Number(symbolRow.scriptLimit) || 0;
      const maxTradeValue = scriptLimit * (Number(settings.tradeSizePct) / 100);
      const maxTradeQty = ltp > 0 ? Math.floor(maxTradeValue / ltp) : 0;
      const longValue = (Number(pos.longQty) || 0) * ltp;
      const shortValue = (Number(pos.shortQty) || 0) * ltp;
      const remainingScript = Math.max(0, scriptLimit - longValue);
      const remainingCarry = Math.max(0, carryForwardCap - deployedLong);
      const buyQty = ltp > 0 ? Math.min(maxTradeQty, Math.floor(Math.min(remainingScript, remainingCarry) / ltp)) : 0;
      const bid = strategy.levels?.bid || (ltp > 0 ? ltp * (1 - Number(settings.buyDeclinePct) / 100) : 0);
      const ask = strategy.levels?.target || (ltp > 0 ? ltp * (1 + Number(settings.scalpTargetPct) / 100) : 0);
      const longExitCostPct = Number(settings.deliveryCostPct ?? settings.intradayCostPct) || 0;
      const longBreakEven = Number(pos.longAvg || 0) * (1 + longExitCostPct / 100);
      const canSellLong = (Number(pos.longQty) || 0) > 0 && ltp >= longBreakEven;
      const coverNow = (Number(pos.shortQty) || 0) > 0 && afterSquareOff;
      const dailyTarget = Number(settings.inventoryLimit) * (Number(settings.dailyTargetPct) / 100);
      let action = 'WAIT';
      let paperSide = '';
      let paperQty = 0;
      let paperPrice = 0;
      let reason = 'No qualifying paper action';

      if (coverNow) {
        action = 'COVER_SHORT';
        paperSide = 'COVER';
        paperQty = Number(pos.shortQty) || 0;
        paperPrice = ltp;
        reason = `Short must be covered by ${settings.squareOff}`;
      } else if (canSellLong) {
        action = 'SELL_PROFIT';
        paperSide = 'SELL';
        paperQty = Math.min(Number(pos.longQty) || 0, maxTradeQty || Number(pos.longQty) || 0);
        paperPrice = Math.max(ask, longBreakEven);
        reason = 'Long exit is above cost and breakeven';
      } else if (buyQty > 0 && ltp > 0 && strategy.action === 'BUY') {
        action = 'BID';
        paperSide = 'BUY';
        paperQty = buyQty;
        paperPrice = bid;
        reason = strategy.reason;
      } else if (ltp > 0 && strategy.action === 'SHORT' && strategy.combo?.allowShort === true && (Number(pos.longQty) || 0) === 0 && nowMin < minutesOfDay(settings.squareOff)) {
        action = 'SHORT_INTRADAY';
        paperSide = 'SHORT';
        paperQty = maxTradeQty;
        paperPrice = ltp;
        reason = strategy.reason;
      }

      return {
        ...symbolRow,
        ltp: round2(ltp),
        longQty: Number(pos.longQty) || 0,
        longAvg: round2(pos.longAvg),
        shortQty: Number(pos.shortQty) || 0,
        shortAvg: round2(pos.shortAvg),
        longValue: round2(longValue),
        shortValue: round2(shortValue),
        scriptLimit: round2(scriptLimit),
        maxTradeValue: round2(maxTradeValue),
        remainingScript: round2(remainingScript),
        bid: round2(bid),
        ask: round2(ask),
        breakEven: round2(longBreakEven),
        action,
        reason,
        paperSide,
        paperQty,
        paperPrice: round2(paperPrice),
        dailyTarget: round2(dailyTarget),
        lastTickAt: quote.lastTickAt || null,
        strategy: {
          action: strategy.action,
          direction: strategy.direction,
          score: strategy.score,
          reason: strategy.reason,
          weeklyTrend: strategy.indicators?.weeklyTrend?.state || 'UNKNOWN',
          dailyTrend: strategy.indicators?.dailyTrend?.state || 'UNKNOWN',
          rsi: round2(strategy.indicators?.intradayRsi || 0),
          emaFast: round2(strategy.indicators?.intradayEmaFast || 0),
          emaSlow: round2(strategy.indicators?.intradayEmaSlow || 0),
          bbMid: round2(strategy.indicators?.intradayBb?.mid || 0),
          entryExtensionPct: round2(strategy.indicators?.entryExtensionPct || 0),
          combo: strategy.combo
        }
      };
    });
  }

  function getState() {
    const current = load();
    const rows = planRows(current);
    const realizedPnl = current.trades.reduce((sum, trade) => sum + (Number(trade.realizedPnl) || 0), 0);
    const longInventory = rows.reduce((sum, row) => sum + row.longValue, 0);
    const shortExposure = rows.reduce((sum, row) => sum + row.shortValue, 0);
    return {
      settings: current.settings,
      symbols: current.symbols,
      rows,
      trades: current.trades.slice(0, 200),
      connectionState,
      clock: { ist: istHHMM(), afterSquareOff: minutesOfDay(istHHMM()) >= minutesOfDay(current.settings.squareOff) },
      totals: {
        symbolCount: current.symbols.length,
        inventoryLimit: round2(current.settings.inventoryLimit),
        carryForwardCap: round2(Number(current.settings.inventoryLimit) * (Number(current.settings.carryForwardPct) / 100)),
        dailyTarget: round2(Number(current.settings.inventoryLimit) * (Number(current.settings.dailyTargetPct) / 100)),
        longInventory: round2(longInventory),
        shortExposure: round2(shortExposure),
        realizedPnl: round2(realizedPnl),
        targetProgressPct: round2(realizedPnl / Math.max(1, Number(current.settings.inventoryLimit) * (Number(current.settings.dailyTargetPct) / 100)) * 100)
      }
    };
  }

  function recordPaperTrade(input = {}) {
    const current = load();
    const symbol = String(input.symbol || '').trim().toUpperCase();
    const side = String(input.side || '').trim().toUpperCase();
    const symbolRow = current.symbols.find((row) => row.symbol === symbol);
    if (!symbolRow) throw new Error(`Symbol ${symbol} is not in the cash scalper list`);
    const price = Math.max(0, Number(input.price) || quotes.get(symbol)?.ltp || 0);
    let quantity = Math.max(0, Math.floor(Number(input.quantity) || 0));
    if (!price || !quantity) throw new Error('Paper trade needs quantity and price');
    if (!['BUY', 'SELL', 'SHORT', 'COVER'].includes(side)) throw new Error('Side must be BUY, SELL, SHORT, or COVER');

    const rowsBySymbol = new Map(planRows(current).map((row) => [row.symbol, row]));
    const plan = rowsBySymbol.get(symbol);
    const maxQty = price > 0 ? Math.floor((Number(symbolRow.scriptLimit) * (Number(current.settings.tradeSizePct) / 100)) / price) : 0;
    if (side === 'BUY' || side === 'SHORT') quantity = Math.min(quantity, maxQty);
    if (!quantity) throw new Error('Trade size exceeds the 10% script limit at this price');

    const pos = getPosition(current, symbol);
    const costPct = side === 'BUY' || side === 'SELL'
      ? Number(current.settings.deliveryCostPct ?? current.settings.intradayCostPct)
      : Number(current.settings.intradayCostPct);
    const costs = round2(price * quantity * (Number(costPct) / 100));
    let realizedPnl = 0;
    let next = { ...pos };

    if (side === 'BUY') {
      const carryForwardCap = Number(current.settings.inventoryLimit) * (Number(current.settings.carryForwardPct) / 100);
      const existingLongValue = current.positions.reduce((sum, row) => {
        if (row.symbol === symbol) return sum;
        return sum + (Number(row.longQty) || 0) * (quotes.get(row.symbol)?.ltp || Number(row.longAvg) || 0);
      }, 0);
      const currentSymbolValue = (Number(pos.longQty) || 0) * price;
      const maxByScript = Math.floor(Math.max(0, Number(symbolRow.scriptLimit || 0) - currentSymbolValue) / price);
      const maxByCarry = Math.floor(Math.max(0, carryForwardCap - existingLongValue - currentSymbolValue) / price);
      quantity = Math.min(quantity, maxByScript, maxByCarry);
      if (!quantity) throw new Error('Rule blocked: carry-forward or script limit is fully used');
      const currentValue = (Number(pos.longQty) || 0) * (Number(pos.longAvg) || 0);
      const nextQty = (Number(pos.longQty) || 0) + quantity;
      next.longQty = nextQty;
      next.longAvg = round2((currentValue + price * quantity + costs) / nextQty);
    }

    if (side === 'SELL') {
      if ((Number(pos.longQty) || 0) <= 0) throw new Error('No long inventory to sell');
      quantity = Math.min(quantity, Number(pos.longQty) || 0);
      const breakEven = Number(pos.longAvg || 0) * (1 + Number(current.settings.deliveryCostPct ?? current.settings.intradayCostPct) / 100);
      if (price < breakEven) throw new Error('Rule blocked: do not sell long inventory at a loss');
      realizedPnl = round2((price - Number(pos.longAvg || 0)) * quantity - costs);
      next.longQty = (Number(pos.longQty) || 0) - quantity;
      next.longAvg = next.longQty > 0 ? next.longAvg : 0;
    }

    if (side === 'SHORT') {
      const nowMin = minutesOfDay(istHHMM());
      if (nowMin >= minutesOfDay(current.settings.squareOff)) throw new Error('Rule blocked: no new shorts after square-off time');
      if ((Number(pos.longQty) || 0) > 0) throw new Error('Rule blocked: do not open intraday shorts while long inventory exists');
      if (getCombo(symbol).allowShort !== true) throw new Error('Rule blocked: shorting is disabled for this script combo');
      const currentValue = (Number(pos.shortQty) || 0) * (Number(pos.shortAvg) || 0);
      const nextQty = (Number(pos.shortQty) || 0) + quantity;
      next.shortQty = nextQty;
      next.shortAvg = round2((currentValue + price * quantity - costs) / nextQty);
    }

    if (side === 'COVER') {
      if ((Number(pos.shortQty) || 0) <= 0) throw new Error('No short position to cover');
      quantity = Math.min(quantity, Number(pos.shortQty) || 0);
      realizedPnl = round2((Number(pos.shortAvg || 0) - price) * quantity - costs);
      next.shortQty = (Number(pos.shortQty) || 0) - quantity;
      next.shortAvg = next.shortQty > 0 ? next.shortAvg : 0;
    }

    const trade = {
      id: `${Date.now()}-${symbol}-${side}`,
      time: new Date().toISOString(),
      symbol,
      side,
      quantity,
      price: round2(price),
      costs,
      realizedPnl,
      reason: input.reason || plan?.reason || 'Paper fill'
    };

    save({
      ...current,
      positions: updatePosition(current, next),
      trades: [trade, ...current.trades].slice(0, 1000)
    });
    return getState();
  }

  function subscribeLive() {
    const current = load();
    if (!wsClient) return;
    const instruments = current.symbols
      .filter((row) => row.enabled !== false && row.securityId)
      .map((row) => ({
        symbol: row.symbol,
        exchangeSegment: row.exchangeSegment || 'NSE_EQ',
        securityId: row.securityId
      }));
    wsClient.subscribe(instruments);
  }

  function toISTValue(date, daily = false) {
    const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
    return daily ? ist.toISOString().slice(0, 10) : ist.toISOString().replace('T', ' ').slice(0, 19);
  }

  function loadCombos() {
    const data = readJson(combosFile, {});
    return data.symbols || {};
  }

  function getCombo(symbol) {
    return { ...DEFAULT_COMBO, ...(loadCombos()[symbol] || {}) };
  }

  async function fetchCandlesForStrategy(symbolRow) {
    if (!restClient) throw new Error('Dhan REST client is not available');
    const now = new Date();
    const dailyStart = new Date(now.getTime());
    dailyStart.setDate(dailyStart.getDate() - 900);
    const intraStart = new Date(now.getTime());
    intraStart.setDate(intraStart.getDate() - 8);
    const combo = getCombo(symbolRow.symbol);
    const dailyResponse = await restClient.getDailyCandles({
      securityId: symbolRow.securityId,
      exchangeSegment: symbolRow.exchangeSegment || 'NSE_EQ',
      instrument: 'EQUITY',
      fromDate: toISTValue(dailyStart, true),
      toDate: toISTValue(now, true)
    });
    const intradayResponse = await restClient.getIntradayCandles({
      securityId: symbolRow.securityId,
      exchangeSegment: symbolRow.exchangeSegment || 'NSE_EQ',
      instrument: 'EQUITY',
      interval: combo.intradayFrame || '5',
      fromDate: toISTValue(intraStart),
      toDate: toISTValue(now)
    });
    return {
      daily: normalizeChartResponse(dailyResponse),
      intraday: normalizeChartResponse(intradayResponse),
      combo
    };
  }

  async function refreshStrategies(symbols = null) {
    const current = load();
    const selected = new Set((symbols || current.symbols.map((row) => row.symbol)).map((symbol) => String(symbol).toUpperCase()));
    for (const symbolRow of current.symbols.filter((row) => selected.has(row.symbol))) {
      try {
        const combo = getCombo(symbolRow.symbol);
        if (combo.enabled === false) {
          strategyState.set(symbolRow.symbol, {
            action: 'WAIT',
            direction: 'DISABLED',
            score: 0,
            reason: 'Disabled by latest backtest optimizer',
            levels: {},
            indicators: {},
            combo,
            refreshedAt: Date.now()
          });
          continue;
        }
        const candles = await fetchCandlesForStrategy(symbolRow);
        const quote = quotes.get(symbolRow.symbol);
        const evalResult = evaluateCashScalper({
          intraday: candles.intraday,
          daily: candles.daily,
          ltp: quote?.ltp || null,
          combo: candles.combo
        });
        strategyState.set(symbolRow.symbol, { ...evalResult, refreshedAt: Date.now() });
      } catch (err) {
        strategyState.set(symbolRow.symbol, {
          action: 'WAIT',
          direction: 'NONE',
          score: 0,
          reason: err.message,
          levels: {},
          indicators: {},
          combo: getCombo(symbolRow.symbol),
          refreshedAt: Date.now()
        });
      }
    }
    emit();
    return getState();
  }

  function startLive() {
    if (wsClient) stopLive();
    wsClient = new DhanWsClient(exchangeConfig.dhan);
    wsClient.on('open', () => {
      connectionState = 'CONNECTED';
      subscribeLive();
      emit();
      refreshStrategies().catch(() => {});
    });
    wsClient.on('close', () => {
      connectionState = 'DISCONNECTED';
      emit();
    });
    wsClient.on('error', (err) => {
      connectionState = `ERROR: ${err.message || 'Dhan feed error'}`;
      emit();
    });
    wsClient.on('packet', (packet) => {
      const current = load();
      const row = current.symbols.find((item) => String(item.securityId) === String(packet.securityId));
      if (!row) return;
      quotes.set(row.symbol, {
        ltp: Number(packet.ltp || packet.close || 0),
        lastTickAt: Date.now()
      });
      const currentStrategy = strategyState.get(row.symbol);
      if (currentStrategy && Date.now() - (currentStrategy.refreshedAt || 0) > 5 * 60 * 1000) {
        refreshStrategies([row.symbol]).catch(() => {});
      }
      emit();
    });
    connectionState = 'CONNECTING';
    wsClient.connect();
    emit();
    return getState();
  }

  function stopLive() {
    if (wsClient) wsClient.close();
    wsClient = null;
    connectionState = 'DISCONNECTED';
    emit();
    return getState();
  }

  function updateSettings(settings = {}) {
    const current = load();
    save({ ...current, settings: { ...current.settings, ...settings } });
    return getState();
  }

  function emit() {
    events.emit('status', getState());
  }

  return {
    getState,
    updateSettings,
    searchSymbols,
    buildSymbolMasterFromCsv,
    upsertSymbol,
    removeSymbol,
    recordPaperTrade,
    refreshStrategies,
    startLive,
    stopLive,
    on: events.on.bind(events),
    off: events.off.bind(events)
  };
}

module.exports = { createCashScalperService, DEFAULT_SETTINGS };
