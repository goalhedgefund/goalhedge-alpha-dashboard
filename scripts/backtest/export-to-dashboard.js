// ─────────────────────────────────────────────────────────────────────────────
// Export the recommended system into the live dashboard (multiscript-standalone)
// for PAPER / REPLAY forward-testing. Writes NON-destructive *.recommended.json
// files + a NIFTY regime file. Nothing is overwritten; see PAPER_TRADING.md.
//
// Usage: node scripts/backtest/export-to-dashboard.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const DASH = path.join(E.ROOT, 'MULTISCRIPT DASHBOARD', 'multiscript-standalone');
const DASH_DATA = path.join(DASH, 'data');
const recFile = path.join(E.DATA_DIR, 'recommended-system.json');
if (!fs.existsSync(recFile)) { console.error('Run recommended.js --write first.'); process.exit(1); }
const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
const S = rec.strategy;

// map symbol -> {secId,name,exchange} from the optimizer config (15m entries)
const cfgMap = JSON.parse(fs.readFileSync(path.join(E.DATA_DIR, 'symbol-configs.json'), 'utf8'));
const meta = {};
for (const v of Object.values(cfgMap)) if (String(v.timeframe)==='15') meta[v.underlying] = { secId:String(v.secId), name:v.underlying, exchange:v.exchange||'NSE_EQ' };

const overrides = {};
const watch = { symbols: [] };
const missing = [];
for (const sym of rec.basket){
  const m = meta[sym];
  if (!m){ missing.push(sym); continue; }
  overrides[`${m.exchange}:${m.secId}:15`] = {
    minScore: S.minScore, slMultiplier: S.slMultiplier, tpMultiplier: S.tpMultiplier,
    rr: S.rr, atrPeriod: 14, kellyFraction: 0, engine: 'scalper', regime: 'nifty',
    note: 'recommended realistic-path system; fixed-risk sizing (Kelly disabled)'
  };
  watch.symbols.push({ symbol: sym, name: m.name, exchange: m.exchange, secId: m.secId, enabledFrames: ['15'], primaryTimeframe: '15' });
}
if (missing.length) console.warn('No secId for:', missing.join(', '));

// NIFTY regime file (trend map at 15m + high-vol blocked days) for replay validation
const trend = E.buildIndexTrend('NIFTY', '15', S.niftyTrend.fast, S.niftyTrend.slow);
const blocked = E.buildHighVolDays('NIFTY', S.skipNiftyHighVol.rangePctThreshold, S.skipNiftyHighVol.lookbackDays);
const regime = {
  generatedAt: new Date().toISOString(),
  params: { niftyTrend:S.niftyTrend, skipNiftyHighVol:S.skipNiftyHighVol },
  trendByTs: Object.fromEntries(trend),         // bucketTs(15m) -> +1 / -1
  blockedDays: Array.from(blocked),             // IST dayKeys to skip
  note: 'For LIVE use, regenerate daily from fresh NIFTY data; this snapshot suits REPLAY validation.'
};

fs.mkdirSync(path.join(DASH_DATA, 'optimized'), { recursive: true });
fs.mkdirSync(path.join(DASH_DATA, 'regime'), { recursive: true });
const f1 = path.join(DASH_DATA, 'optimized', 'symbol-configs.recommended.json');
const f2 = path.join(DASH_DATA, 'watchlist.recommended.json');
const f3 = path.join(DASH_DATA, 'regime', 'nifty-regime.json');
fs.writeFileSync(f1, JSON.stringify({ _meta:{ source:'recommended realistic-path system', strategy:S }, ...overrides }, null, 2));
fs.writeFileSync(f2, JSON.stringify(watch, null, 2));
fs.writeFileSync(f3, JSON.stringify(regime));
console.log(`Wrote:\n  ${f1}\n  ${f2}\n  ${f3}`);
console.log(`Basket: ${watch.symbols.length} symbols. Activate per PAPER_TRADING.md (replay-validate first).`);
