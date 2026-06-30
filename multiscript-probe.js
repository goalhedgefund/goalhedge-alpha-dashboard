'use strict';
/**
 * multiscript-probe.js — run from D:\CODEX:  node multiscript-probe.js
 *
 * Confirms the two integration items without guessing:
 *   1) Does the canonical indicator engine load, and what shape does its
 *      snapshot return?  (Then: is the live board scoring it as "canonical"?)
 *   2) What exchange-charge rates will the live log use?
 */

const path = require('path');

function rule(t) { console.log('\n' + '─'.repeat(64) + '\n' + t); }
function show(v) { try { return JSON.stringify(v, (k, x) => (typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : x), 2); } catch { return String(v); } }

// synthetic rising series (enough bars for all indicators)
const prices = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 3) * 0.2);

rule('1) CANONICAL INDICATOR ENGINE');
const candidates = ['./server/lib/indicators', './server/lib/indicators.js', './public/js/indicators'];
let engine = null, foundAt = null;
for (const c of candidates) {
  try {
    const m = require(path.resolve(process.cwd(), c));
    const eng = (m && (m.Indicators || m)) || null;
    if (eng && (typeof eng.snapshot === 'function' || typeof eng === 'function')) { engine = eng; foundAt = c; break; }
    console.log(`  loaded ${c} but no snapshot()/callable export. keys: ${m && typeof m === 'object' ? Object.keys(m).join(', ') : typeof m}`);
  } catch (e) { console.log(`  not found: ${c}  (${e.code || e.message})`); }
}

if (!engine) {
  console.log('\n  → No canonical engine resolved. The board will run in FALLBACK (close-only) mode.');
  console.log('    That works, but live will not exactly match your backtests. If indicators.js');
  console.log('    lives elsewhere or uses a different export, add its path to CANDIDATES in');
  console.log('    server/lib/multiscript-signal.js (and here).');
} else {
  console.log(`  ✓ engine resolved at: ${foundAt}`);
  let snap = null;
  try { snap = typeof engine.snapshot === 'function' ? engine.snapshot(prices, { minScore: 6 }) : engine(prices, { minScore: 6 }); }
  catch (e) { console.log('  ✗ snapshot() threw:', e.message); }
  if (snap && typeof snap === 'object') {
    console.log('  snapshot() top-level keys:', Object.keys(snap).join(', '));
    console.log('  snapshot() sample:\n' + show(snap).split('\n').map((l) => '    ' + l).join('\n'));
  } else if (snap != null) {
    console.log('  snapshot() returned a non-object:', show(snap));
  }
}

rule('2) HOW multiscript-signal SCORES IT');
try {
  const Signal = require('./server/lib/multiscript-signal');
  if (engine !== undefined) Signal.setEngine(engine || undefined); // mirror probe’s resolution
  const out = Signal.snapshot(prices, { minScore: 6 });
  console.log(`  result: bull=${out.bull} bear=${out.bear} signal=${out.signal}  SOURCE=${out.source}`);
  if (out.source === 'canonical') console.log('  ✓ PARITY ACTIVE — live uses your indicator values.');
  else console.log('  → Using FALLBACK. If an engine WAS found above, its fields were not recognised;');
  console.log('    add the field spellings to voteFromReadings() in multiscript-signal.js (one-time).');
  console.log('    votes:', show(out.votes));
} catch (e) { console.log('  ✗ signal module error:', e.message); }

rule('3) EXCHANGE-CHARGE RATES (live log)');
try {
  const { RATES, getExchangeChargeRate } = require('./server/lib/exchange-charges');
  console.log('  intraday:', RATES.intraday, '=', (RATES.intraday * 100).toFixed(5) + '%');
  console.log('  daily   :', RATES.daily, '=', (RATES.daily * 100).toFixed(4) + '%');
  console.log('  sample: turnover ₹1,000,000 intraday →', '₹' + (1e6 * getExchangeChargeRate('intraday')).toFixed(2));
  console.log('\n  → Compare these to what index.js getExchangeChargeRate() returns. If they match,');
  console.log('    you can make index.js delegate here for a single source:');
  console.log("      return require('./lib/exchange-charges').getExchangeChargeRate(mode);");
  console.log('    If they differ, edit the two constants in server/lib/exchange-charges.js.');
} catch (e) { console.log('  ✗ exchange-charges error:', e.message); }

console.log('\n' + '─'.repeat(64));
