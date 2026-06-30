// ─────────────────────────────────────────────────────────────────────────────
// Structural config sweep (re-discovery tool).
// Ranks global configs (TF × stop × RR × score × NIFTY trend filter) by pooled
// net edge on a DESIGN window, with a HOLDOUT window shown for confirmation.
// Pooled across the whole universe (NO per-symbol fitting) => low overfitting.
//
// Usage: node --max-old-space-size=4096 scripts/backtest/sweep.js
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const E = require('./engine');

const COST = 0.00025;
const designFrom = E.parseIST('2023-06-01'), designTo = E.parseIST('2025-06-30')+86400000-1;
const holdFrom = E.parseIST('2025-07-01'),   holdTo = E.parseIST('2026-06-30')+86400000-1;
const DESIGN_YEARS = 2, HOLD_YEARS = 1;

const TFS = ['15','30','60'], SLS = [1.0,1.5,2.5], RRS = [3,4,5], MINS = [6,7,8], NIFTY = [false,true];

const symbols = E.listSymbols().filter(s => s!=='NIFTY' && s!=='BANKNIFTY');
const trendByTf = {}; for (const tf of TFS) trendByTf[tf] = E.buildIndexTrend('NIFTY', tf);

const configs = [];
for (const tf of TFS) for (const sl of SLS) for (const rr of RRS) for (const ms of MINS) for (const nf of NIFTY)
  configs.push({ id:`${tf}m sl${sl} rr${rr} ms${ms} ${nf?'NIFTY':'noflt'}`, tf, sl, rr, ms, nf });

console.log(`${symbols.length} symbols x ${configs.length} configs, cost=${COST}`);
const acc = {}; for (const c of configs) acc[c.id] = { dR:0,dN:0,hR:0,hN:0 };

const t0 = Date.now(); let done = 0;
for (const sym of symbols){
  let c = E.loadCandles(sym); if (!c) continue;
  const aggByTf = {}; for (const tf of TFS) aggByTf[tf] = E.aggregate(c, tf); c = null;
  for (const cfg of configs){
    const trades = E.applyCost(E.simulate(aggByTf[cfg.tf], { tf:cfg.tf, slMultiplier:cfg.sl, tpMultiplier:+(cfg.sl*cfg.rr).toFixed(3), minScore:cfg.ms, indexTrend:cfg.nf?trendByTf[cfg.tf]:null }), COST);
    const a = acc[cfg.id];
    for (const t of trades){ const m = E.tsMs(t.entryTs);
      if (m>=designFrom && m<=designTo){ a.dR+=t.netR; a.dN++; }
      else if (m>=holdFrom && m<=holdTo){ a.hR+=t.netR; a.hN++; } }
  }
  for (const tf of TFS) aggByTf[tf] = null;
  if (++done % 40 === 0) console.log(`  ${done}/${symbols.length} [${((Date.now()-t0)/1000).toFixed(0)}s]`);
}

const rows = configs.map(c => { const a = acc[c.id]; return { id:c.id,
  dExp:a.dN?a.dR/a.dN:0, dR:a.dR, dPerYr:Math.round(a.dN/DESIGN_YEARS),
  hExp:a.hN?a.hR/a.hN:0, hR:a.hR, hPerYr:Math.round(a.hN/HOLD_YEARS) }; }).filter(r => r.dPerYr*DESIGN_YEARS >= 300);
rows.sort((a,b)=>b.dExp-a.dExp);

console.log('\nTOP 25 by DESIGN pooled net expectancy/trade (holdout shown for confirmation):');
console.log('CONFIG                          designExp  dTr/yr  designR  |  holdExp  hTr/yr  holdR');
for (const r of rows.slice(0,25))
  console.log(r.id.padEnd(32), r.dExp.toFixed(4).padStart(8), String(r.dPerYr).padStart(6), r.dR.toFixed(0).padStart(8), ' |',
    r.hExp.toFixed(4).padStart(8), String(r.hPerYr).padStart(6), r.hR.toFixed(0).padStart(7));
console.log('\nReminder: a positive designExp that goes negative in holdExp = overfit. Prefer configs');
console.log('positive in BOTH, then build a basket with recommended.js and confirm OOS.');
