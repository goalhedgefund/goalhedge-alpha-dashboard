const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { createSelectionService } = require('../server/services/selection.service');
const { computeKellyFraction, computeTradePlan } = require('../server/engines/risk.engine');
const { scoreSeries } = require('../server/engines/signal.engine');
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

test('selection service loads catalog', () => {
  const service = createSelectionService({ rootDir: path.resolve(__dirname, '..'), maxPerFrame: 5 });
  const catalog = service.loadOptimizedCatalog();
  assert.ok(catalog['15'].length > 0);
});

test('selection service default watchlist', () => {
  const service = createSelectionService({ rootDir: path.resolve(__dirname, '..'), maxPerFrame: 5 });
  const watchlist = service.buildDefaultWatchlist(service.loadOptimizedCatalog());
  assert.ok(watchlist.symbols.length > 0);
});

test('env root points to package', () => {
  assert.ok(env.rootDir.includes('multiscript-standalone'));
});

test('resolve frame config returns config', () => {
  const service = createSelectionService({ rootDir: path.resolve(__dirname, '..'), maxPerFrame: 5 });
  const catalog = service.loadOptimizedCatalog();
  const row = service.buildDefaultWatchlist(catalog).symbols[0];
  const resolved = service.resolveFrameConfig(row, '15', catalog, {});
  assert.ok(resolved.config.minScore >= 6);
});

const totalRequired = 10;
const passed = results.filter((item) => item.ok).length;
const failed = results.filter((item) => !item.ok);

for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} - ${item.name}${item.error ? ` :: ${item.error}` : ''}`);
}

console.log(`${passed} passed, ${failed.length} failed`);

if (passed < totalRequired || failed.length) {
  process.exitCode = 1;
}
