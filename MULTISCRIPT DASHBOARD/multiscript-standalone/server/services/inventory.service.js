const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  totalCapital: 100000,
  minStocks: 5,
  maxStocks: 25,
  intradayCostPct: 0.12,
  deliveryCostPct: 0.28,
  scalpTargetPct: 0.75,
  buyDeclinePct: 0.75,
  supportBufferPct: 0.25,
  resistanceBufferPct: 0.25,
  maxBuildPct: 100,
  sessionStart: '09:15',
  squareOff: '15:20'
};

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

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

function istHHMM(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
}

function minutesOfDay(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function createInventoryService({ dataDir, getSnapshot, defaultCapital }) {
  const filePath = path.join(dataDir, 'inventory.json');

  function load() {
    const saved = readJson(filePath, {});
    const settings = {
      ...DEFAULT_SETTINGS,
      totalCapital: defaultCapital || DEFAULT_SETTINGS.totalCapital,
      ...(saved.settings || {})
    };
    settings.minStocks = clamp(settings.minStocks, 1, 25);
    settings.maxStocks = clamp(settings.maxStocks, settings.minStocks, 25);
    settings.maxBuildPct = clamp(settings.maxBuildPct, 1, 100);
    return {
      settings,
      positions: Array.isArray(saved.positions) ? saved.positions : [],
      paperTrades: Array.isArray(saved.paperTrades) ? saved.paperTrades : [],
      updatedAt: saved.updatedAt || null
    };
  }

  function save(next) {
    const current = load();
    const settings = { ...current.settings, ...(next.settings || {}) };
    settings.minStocks = clamp(settings.minStocks, 1, 25);
    settings.maxStocks = clamp(settings.maxStocks, settings.minStocks, 25);
    settings.maxBuildPct = clamp(settings.maxBuildPct, 1, 100);

    const positions = Array.isArray(next.positions)
      ? next.positions.map((row) => ({
          symbol: String(row.symbol || '').trim().toUpperCase(),
          quantity: Math.max(0, Math.floor(Number(row.quantity) || 0)),
          avgPrice: Math.max(0, Number(row.avgPrice) || 0)
        })).filter((row) => row.symbol)
      : current.positions;

    const payload = {
      settings,
      positions,
      paperTrades: current.paperTrades,
      updatedAt: new Date().toISOString()
    };
    writeJson(filePath, payload);
    return buildPlan(payload);
  }

  function saveState(next) {
    const payload = {
      settings: next.settings,
      positions: next.positions,
      paperTrades: next.paperTrades || [],
      updatedAt: new Date().toISOString()
    };
    writeJson(filePath, payload);
    return buildPlan(payload);
  }

  function recordPaperTrade({ symbol, side, quantity, price, reason }) {
    const current = load();
    const plan = buildPlan(current);
    const row = plan.rows.find((item) => item.symbol === String(symbol || '').toUpperCase());
    if (!row) throw new Error(`Unknown inventory symbol: ${symbol}`);

    const tradeSide = String(side || '').toUpperCase();
    const fillQty = Math.max(0, Math.floor(Number(quantity) || 0));
    const fillPrice = Math.max(0, Number(price) || 0);
    if (!['BUY', 'SELL'].includes(tradeSide)) throw new Error('Paper trade side must be BUY or SELL');
    if (!fillQty) throw new Error('Paper trade quantity is required');
    if (!fillPrice) throw new Error('Paper trade price is required');

    const positions = [...current.positions];
    const idx = positions.findIndex((item) => item.symbol === row.symbol);
    const existing = idx >= 0 ? positions[idx] : { symbol: row.symbol, quantity: 0, avgPrice: 0 };
    const costPct = row.costPct || current.settings.intradayCostPct || 0;
    const costs = round2(fillPrice * fillQty * (costPct / 100));
    let realizedPnl = 0;
    let nextPosition;

    if (tradeSide === 'BUY') {
      const oldQty = Math.max(0, Math.floor(Number(existing.quantity) || 0));
      const oldAvg = Math.max(0, Number(existing.avgPrice) || 0);
      const nextQty = oldQty + fillQty;
      const nextAvg = nextQty > 0 ? ((oldQty * oldAvg) + (fillQty * fillPrice) + costs) / nextQty : 0;
      nextPosition = { symbol: row.symbol, quantity: nextQty, avgPrice: round2(nextAvg) };
    } else {
      const oldQty = Math.max(0, Math.floor(Number(existing.quantity) || 0));
      if (oldQty <= 0) throw new Error(`No paper inventory available to sell for ${row.symbol}`);
      const sellQty = Math.min(fillQty, oldQty);
      realizedPnl = round2(((fillPrice - Number(existing.avgPrice || 0)) * sellQty) - costs);
      nextPosition = { symbol: row.symbol, quantity: oldQty - sellQty, avgPrice: Number(existing.avgPrice || 0) };
      if (nextPosition.quantity === 0) nextPosition.avgPrice = 0;
    }

    if (idx >= 0) positions[idx] = nextPosition;
    else positions.push(nextPosition);

    const trade = {
      id: `${Date.now()}-${row.symbol}-${tradeSide}`,
      time: new Date().toISOString(),
      symbol: row.symbol,
      side: tradeSide,
      quantity: tradeSide === 'SELL' ? Math.min(fillQty, Math.max(0, Math.floor(Number(existing.quantity) || 0))) : fillQty,
      price: round2(fillPrice),
      costs,
      realizedPnl,
      reason: reason || row.reason || 'Paper fill'
    };

    return saveState({
      settings: current.settings,
      positions: positions.filter((item) => item.quantity > 0 || item.avgPrice > 0),
      paperTrades: [trade, ...current.paperTrades].slice(0, 500)
    });
  }

  function buildPlan(source = load()) {
    const snapshot = getSnapshot();
    const settings = source.settings || DEFAULT_SETTINGS;
    const symbolRows = snapshot.symbols || [];
    const activeSymbols = symbolRows.filter((row) => row.enabledFramesList?.length || row.activeTimeframes?.length);
    const universe = activeSymbols.length ? activeSymbols : symbolRows;
    const stockCount = clamp(universe.length || settings.minStocks, settings.minStocks, settings.maxStocks);
    const perStockCapital = (Number(settings.totalCapital) || 0) / stockCount;
    const maxBuildValue = perStockCapital * ((Number(settings.maxBuildPct) || 100) / 100);
    const nowHHMM = istHHMM();
    const nowMin = minutesOfDay(nowHHMM);
    const afterSquareOff = nowMin >= minutesOfDay(settings.squareOff);
    const beforeStart = nowMin < minutesOfDay(settings.sessionStart);
    const positionMap = new Map((source.positions || []).map((row) => [row.symbol, row]));
    const legMap = new Map((snapshot.legs || []).map((leg) => [`${leg.symbol}:${leg.frame}`, leg]));

    const rows = universe.slice(0, settings.maxStocks).map((symbolRow) => {
      const leg = legMap.get(`${symbolRow.symbol}:15`) || (snapshot.legs || []).find((item) => item.symbol === symbolRow.symbol) || {};
      const pos = positionMap.get(symbolRow.symbol) || {};
      const ltp = Number(symbolRow.ltp || leg.ltp || leg.entry || 0);
      const qty = Math.max(0, Math.floor(Number(pos.quantity) || 0));
      const avgPrice = Number(pos.avgPrice || 0);
      const positionValue = qty * ltp;
      const positionCost = qty * avgPrice;
      const capacityValue = Math.max(0, maxBuildValue - positionValue);
      const addQty = ltp > 0 ? Math.floor(capacityValue / ltp) : 0;
      const support = Number(leg.stop || 0) > 0 ? Number(leg.stop) : ltp * (1 - Number(settings.buyDeclinePct) / 100);
      const resistance = Number(leg.target || 0) > 0 ? Number(leg.target) : ltp * (1 + Number(settings.scalpTargetPct) / 100);
      const bid = ltp > 0 ? Math.min(
        ltp * (1 - Number(settings.buyDeclinePct) / 100),
        support * (1 + Number(settings.supportBufferPct) / 100)
      ) : 0;
      const rawAsk = ltp > 0 ? Math.max(
        ltp * (1 + Number(settings.scalpTargetPct) / 100),
        resistance * (1 - Number(settings.resistanceBufferPct) / 100)
      ) : 0;
      const costPct = afterSquareOff ? Number(settings.deliveryCostPct) : Number(settings.intradayCostPct);
      const breakEven = avgPrice > 0 ? avgPrice * (1 + costPct / 100) : ltp * (1 + costPct / 100);
      const ask = qty > 0 ? Math.max(rawAsk, breakEven) : rawAsk;
      const scalpEdgePct = ltp > 0 ? ((ask - ltp) / ltp) * 100 - costPct : 0;

      let action = 'WAIT';
      let reason = 'No edge yet';
      if (beforeStart) {
        action = 'PREPARE';
        reason = `Market plan starts at ${settings.sessionStart}`;
      } else if (afterSquareOff && qty > 0) {
        action = 'SQUARE_OFF';
        reason = `Intraday square-off window after ${settings.squareOff}`;
      } else if (leg.signal === 'LONG' && addQty > 0 && scalpEdgePct > 0) {
        action = 'BID';
        reason = 'Long signal with remaining inventory capacity';
      } else if (qty > 0 && (leg.signal === 'SHORT' || ltp >= rawAsk)) {
        action = 'ASK';
        reason = leg.signal === 'SHORT' ? 'Resistance/short signal' : 'Target zone reached';
      } else if (addQty > 0 && ltp <= bid) {
        action = 'ACCUMULATE';
        reason = 'Price is near support/decline zone';
      }

      return {
        symbol: symbolRow.symbol,
        name: symbolRow.name,
        signal: leg.signal || 'WAIT',
        ltp: round2(ltp),
        quantity: qty,
        avgPrice: round2(avgPrice),
        positionValue: round2(positionValue),
        positionCost: round2(positionCost),
        targetAllocation: round2(perStockCapital),
        capacityValue: round2(capacityValue),
        addQty,
        bid: round2(bid),
        ask: round2(ask),
        support: round2(support),
        resistance: round2(resistance),
        costPct: round2(costPct),
        scalpEdgePct: round2(scalpEdgePct),
        paperSide: ['BID', 'ACCUMULATE'].includes(action) ? 'BUY' : ['ASK', 'SQUARE_OFF'].includes(action) ? 'SELL' : '',
        paperQty: ['BID', 'ACCUMULATE'].includes(action) ? addQty : ['ASK', 'SQUARE_OFF'].includes(action) ? qty : 0,
        paperPrice: ['BID', 'ACCUMULATE'].includes(action) ? round2(bid) : ['ASK', 'SQUARE_OFF'].includes(action) ? round2(afterSquareOff ? ltp : ask) : 0,
        action,
        reason
      };
    });

    const deployed = rows.reduce((sum, row) => sum + row.positionValue, 0);
    const realizedPaperPnl = (source.paperTrades || []).reduce((sum, trade) => sum + (Number(trade.realizedPnl) || 0), 0);
    return {
      settings,
      updatedAt: source.updatedAt || null,
      paperTrades: source.paperTrades || [],
      clock: { ist: nowHHMM, beforeStart, afterSquareOff },
      totals: {
        stockCount,
        totalCapital: round2(settings.totalCapital),
        perStockCapital: round2(perStockCapital),
        deployed: round2(deployed),
        cashRemaining: round2(Math.max(0, Number(settings.totalCapital) - deployed)),
        maxBuildValue: round2(maxBuildValue),
        realizedPaperPnl: round2(realizedPaperPnl)
      },
      rows
    };
  }

  return {
    getPlan: () => buildPlan(load()),
    save,
    recordPaperTrade
  };
}

module.exports = { createInventoryService, DEFAULT_SETTINGS };
