const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createSelectionService } = require('../server/services/selection.service');
const { createInventoryService } = require('../server/services/inventory.service');
const { createCashScalperService } = require('../server/services/cash-scalper.service');
const { computeKellyFraction, computeTradePlan } = require('../server/engines/risk.engine');
const { scoreSeries } = require('../server/engines/signal.engine');
const { evaluateCashScalper } = require('../server/engines/cash-scalper.strategy');
const { normalizeChartResponse } = require('../server/engines/candle.engine');
const { decodeDhanBuffer } = require('../server/adapters/dhan/dhan.packet.decoder');
const { env } = require('../server/config/env');

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
  }
}

const results = [];

test('kelly fraction caps', () => {
  assert.ok(computeKellyFraction(0.9) <= 0.25);
});

test('trade plan long', () => {
  const plan = computeTradePlan({ signal: 'LONG', entry: 100, atr: 2, rr: 3, multiplier: 1.5 });
  assert.ok(plan.stop < plan.entry);
  assert.ok(plan.target > plan.entry);
});

test('trade plan short', () => {
  const plan = computeTradePlan({ signal: 'SHORT', entry: 100, atr: 2, rr: 3, multiplier: 1.5 });
  assert.ok(plan.stop > plan.entry);
  assert.ok(plan.target < plan.entry);
});

test('signal engine scores trend', () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 10,
    timestamp: i
  }));
  const score = scoreSeries(candles, 132);
  assert.ok(['LONG', 'WAIT', 'SHORT'].includes(score.signal));
});

test('candle normalization', () => {
  const candles = normalizeChartResponse({
    open: [1, 2],
    high: [2, 3],
    low: [1, 2],
    close: [2, 3],
    volume: [10, 20],
    timestamp: [100, 200]
  });
  assert.equal(candles.length, 2);
});

test('dhan packet decode header', () => {
  const buf = Buffer.alloc(16);
  buf.writeUInt8(2, 0);
  buf.writeUInt16LE(16, 1);
  buf.writeUInt8(1, 3);
  buf.writeUInt32LE(2885, 4);
  buf.writeFloatLE(123.45, 8);
  buf.writeInt32LE(1700000000, 12);
  const decoded = decodeDhanBuffer(buf);
  assert.equal(decoded[0].securityId, '2885');
  assert.ok(Math.abs(decoded[0].ltp - 123.45) < 0.02);
});

test('selection service loads active watchlist', () => {
  const service = createSelectionService({ rootDir: path.resolve(__dirname, '..'), maxPerFrame: 5 });
  const watchlist = service.loadWatchlist();
  assert.equal(watchlist.symbols.length, 15);
  assert.ok(watchlist.symbols.every((row) => row.enabledFrames.includes('15')));
});

test('env root points to package', () => {
  assert.ok(env.rootDir.includes('multiscript-standalone'));
});

test('resolve frame config returns config', () => {
  const service = createSelectionService({ rootDir: path.resolve(__dirname, '..'), maxPerFrame: 5 });
  const catalog = service.loadOptimizedCatalog();
  const row = service.loadWatchlist().symbols[0];
  const resolved = service.resolveFrameConfig(row, '15', catalog, service.loadSymbolOverrides());
  assert.equal(resolved.config.rr, 5);
  assert.equal(resolved.config.slMultiplier, 2.5);
  assert.equal(resolved.config.tpMultiplier, 12.5);
});

test('inventory service builds equal-weight bid ask plan', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-selftest-'));
  const service = createInventoryService({
    dataDir: tempDir,
    defaultCapital: 100000,
    getSnapshot: () => ({
      symbols: [
        { symbol: 'AAA', name: 'Alpha', ltp: 100, enabledFramesList: ['15'] },
        { symbol: 'BBB', name: 'Beta', ltp: 200, enabledFramesList: ['15'] },
        { symbol: 'CCC', name: 'Gamma', ltp: 300, enabledFramesList: ['15'] },
        { symbol: 'DDD', name: 'Delta', ltp: 400, enabledFramesList: ['15'] },
        { symbol: 'EEE', name: 'Echo', ltp: 500, enabledFramesList: ['15'] }
      ],
      legs: [
        { symbol: 'AAA', frame: '15', signal: 'LONG', ltp: 100, stop: 98, target: 104 }
      ]
    })
  });
  const plan = service.save({
    settings: { totalCapital: 100000, minStocks: 5, maxStocks: 25 },
    positions: [{ symbol: 'AAA', quantity: 10, avgPrice: 95 }]
  });
  assert.equal(plan.totals.stockCount, 5);
  assert.equal(plan.totals.perStockCapital, 20000);
  assert.ok(plan.rows[0].bid > 0);
  assert.ok(plan.rows[0].ask > plan.rows[0].bid);
  const afterBuy = service.recordPaperTrade({ symbol: 'AAA', side: 'BUY', quantity: 5, price: 100, reason: 'test buy' });
  assert.equal(afterBuy.rows[0].quantity, 15);
  const afterSell = service.recordPaperTrade({ symbol: 'AAA', side: 'SELL', quantity: 5, price: 110, reason: 'test sell' });
  assert.equal(afterSell.rows[0].quantity, 10);
  assert.ok(afterSell.totals.realizedPaperPnl > 0);
});

test('cash scalper enforces paper inventory rules', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cash-scalper-selftest-'));
  const service = createCashScalperService({
    dataDir: tempDir,
    rootDir: tempDir,
    exchangeConfig: { dhan: { wsUrl: 'ws://127.0.0.1', clientId: 'x', accessToken: 'y' } }
  });
  fs.writeFileSync(
    path.join(tempDir, 'api-scrip-master.csv'),
    [
      'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
      'NSE,E,27052,EQUITY,0,SAGILITY,1.0,Sagility,,,,1.0000,NA,ES,EQ,SAGILITY LIMITED'
    ].join('\n'),
    'utf8'
  );
  let state = service.updateSettings({ inventoryLimit: 100000, carryForwardPct: 50, tradeSizePct: 10, intradayCostPct: 0.1 });
  assert.equal(state.totals.carryForwardCap, 50000);
  state = service.upsertSymbol({ symbol: 'TEST', securityId: '123', scriptLimit: 100000 });
  assert.equal(state.totals.symbolCount, 1);
  state = service.recordPaperTrade({ symbol: 'TEST', side: 'BUY', quantity: 500, price: 100 });
  assert.equal(state.rows[0].longQty, 100);
  assert.throws(() => service.recordPaperTrade({ symbol: 'TEST', side: 'SELL', quantity: 1, price: 99 }), /loss/);
  state = service.recordPaperTrade({ symbol: 'TEST', side: 'SELL', quantity: 10, price: 102 });
  assert.equal(state.rows[0].longQty, 90);
  assert.ok(state.totals.realizedPnl > 0);
  const matches = service.searchSymbols('SAGILITY');
  assert.equal(matches[0].securityId, '27052');
  state = service.upsertSymbol({ symbol: 'SAGILITY', scriptLimit: 50000 });
  assert.ok(state.rows.some((row) => row.symbol === 'SAGILITY' && row.securityId === '27052'));
});

test('cash scalper blocks shorts unless combo allows them', () => {
  const falling = Array.from({ length: 40 }, (_, i) => ({
    open: 140 - i,
    high: 141 - i,
    low: 139 - i,
    close: 140 - i,
    volume: 1000,
    timestamp: 1700000000000 + i * 60 * 60 * 1000
  }));
  const combo = {
    weeklyFastEma: 2,
    weeklySlowEma: 3,
    dailyFastEma: 2,
    dailySlowEma: 3,
    entryFastEma: 2,
    entrySlowEma: 3,
    bbPeriod: 5,
    rsiPeriod: 5,
    minScore: 2
  };
  const blocked = evaluateCashScalper({ intraday: falling, daily: falling, weekly: falling, combo: { ...combo, allowShort: false } });
  const allowed = evaluateCashScalper({ intraday: falling, daily: falling, weekly: falling, combo: { ...combo, allowShort: true } });
  assert.notEqual(blocked.action, 'SHORT');
  assert.equal(allowed.action, 'SHORT');
});

const totalRequired = 12;
const passed = results.filter((item) => item.ok).length;
const failed = results.filter((item) => !item.ok);

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} - ${item.name}${item.error ? ` :: ${item.error}` : ''}`);
}

console.log(`${passed} passed, ${failed.length} failed`);

if (passed < totalRequired || failed.length) {
  process.exitCode = 1;
}
