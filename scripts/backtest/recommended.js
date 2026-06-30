// ─────────────────────────────────────────────────────────────────────────────
// Recommended system — end-to-end, out-of-sample.
//   15m · 2.5x ATR stops · 5:1 RR · score>=6 · NIFTY trend filter
//   · skip NIFTY high-vol days (5d avg range > 1.2%) · futures cost · liquid basket
//
// Selects the basket on the DESIGN window (2023-06..2025-06) and reports the
// HOLDOUT window (2025-07..2026-06) which the selection never saw.
//
// Usage: node scripts/backtest/recommended.js [--n 15] [--cost 0.00025] [--write]
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const arg = (k, d) => { const i = process.argv.indexOf('--'+k); return i>=0 ? process.argv[i+1] : d; };
const has = (k) => process.argv.includes('--'+k);

const CFG = {
  tf: '15', slMultiplier: 2.5, rr: 5, minScore: 6,
  niftyFast: 20, niftySlow: 50,
  volThresholdPct: +arg('vol', 1.2), volLookback: 5,
  cost: +arg('cost', 0.00025),
  N: +arg('n', 15),
  minDesignTrades: 20,
  dailyLossLimitR: +arg('dailyLimit', 5),   // portfolio daily loss cap (R)
  selectBy: arg('selectBy', 'sharpe'),       // 'sharpe' | 'recovery' | 'R'
  designFrom: E.parseIST('2023-06-01'), designTo: E.parseIST('2025-06-30')+86400000-1,
  holdFrom: E.parseIST('2025-07-01'),   holdTo: E.parseIST('2026-06-30')+86400000-1,
};
const tpMul = +(CFG.slMultiplier*CFG.rr).toFixed(3);
const inWin = (ts,a,b)=>{ const m=E.tsMs(ts); return m>=a&&m<=b; };
const PF_OPTS = { dailyLossLimitR: CFG.dailyLossLimitR };

console.log('RECOMMENDED SYSTEM — out-of-sample evaluation');
console.log(`config: ${CFG.tf}m sl${CFG.slMultiplier} rr${CFG.rr} ms${CFG.minScore} | NIFTY trend(${CFG.niftyFast}/${CFG.niftySlow}) | skip NIFTY ${CFG.volLookback}d-range>${CFG.volThresholdPct}% | dailyLimit ${CFG.dailyLossLimitR}R | select by ${CFG.selectBy} | cost ${CFG.cost} | basket top${CFG.N}`);

const trend = E.buildIndexTrend('NIFTY', CFG.tf, CFG.niftyFast, CFG.niftySlow);
const blocked = E.buildHighVolDays('NIFTY', CFG.volThresholdPct, CFG.volLookback);
const symbols = E.listSymbols().filter(s => s!=='NIFTY' && s!=='BANKNIFTY');

// per-symbol design metrics incl. risk-adjusted (monthly Sharpe, recovery factor)
function symMetrics(tr){
  let cum=0,peak=0,dd=0,w=0; const mon=new Map();
  const byExit=tr.slice().sort((a,b)=>E.tsMs(a.exitTs)-E.tsMs(b.exitTs));
  for(const t of byExit){ cum+=t.netR; if(cum>peak)peak=cum; const d=peak-cum; if(d>dd)dd=d; if(t.netR>0)w++; const k=E.monthKey(t.exitTs); mon.set(k,(mon.get(k)||0)+t.netR); }
  const mr=[...mon.values()]; const mean=mr.length?cum/mr.length:0;
  const std=mr.length?Math.sqrt(mr.reduce((s,r)=>s+(r-mean)**2,0)/mr.length):0;
  return { n:tr.length, R:cum, wr:tr.length?100*w/tr.length:0, maxDD:dd, recovery:dd>0?cum/dd:cum, sharpe:std>0?mean/std:0 };
}
const rankKey = { sharpe:m=>m.sharpe, recovery:m=>m.recovery, R:m=>m.R }[CFG.selectBy] || (m=>m.sharpe);
function statR(tr){ const R=tr.reduce((s,t)=>s+t.netR,0); let w=0; for(const t of tr) if(t.netR>0)w++; return {n:tr.length,R,wr:tr.length?100*w/tr.length:0}; }

const per = [];
for (const sym of symbols){
  let c = E.loadCandles(sym); if(!c) continue;
  const agg = E.aggregate(c, CFG.tf); c=null;
  const tr = E.applyCost(E.simulate(agg, { tf:CFG.tf, slMultiplier:CFG.slMultiplier, tpMultiplier:tpMul, minScore:CFG.minScore, indexTrend:trend, blockedDays:blocked }), CFG.cost);
  for (const t of tr) t.symbol = sym;
  const design = tr.filter(t=>inWin(t.entryTs, CFG.designFrom, CFG.designTo));
  const hold   = tr.filter(t=>inWin(t.entryTs, CFG.holdFrom, CFG.holdTo));
  per.push({ sym, design, hold, d:statR(design), h:statR(hold), dm:symMetrics(design) });
}

const ranked = per.filter(p=>p.d.n>=CFG.minDesignTrades && p.dm.R>0).sort((a,b)=>rankKey(b.dm)-rankKey(a.dm));
const sel = ranked.slice(0, CFG.N);
console.log(`\nBasket (top ${CFG.N} of ${ranked.length} qualifiers, selected on design): ${sel.map(s=>s.sym).join(', ')}`);
console.log('\nPer-symbol design -> holdout (netR):');
for (const s of sel) console.log(`  ${s.sym.padEnd(12)} design ${s.d.R.toFixed(1).padStart(7)} (n${s.d.n}, wr${s.d.wr.toFixed(0)})   holdout ${s.h.R.toFixed(1).padStart(7)} (n${s.h.n}, wr${s.h.wr.toFixed(0)})`);

const designTrades = [].concat(...sel.map(s=>s.design));
const holdTrades   = [].concat(...sel.map(s=>s.hold));
const pd = E.aggregatePortfolio(designTrades, PF_OPTS);
const ph = E.aggregatePortfolio(holdTrades, PF_OPTS);
const line = (t,p)=>`${t}: trades=${p.totalTrades} netR=${p.totalR} avgMo=${p.avgMonthR} worstMo=${p.worstMonthR} maxDD_R=${p.maxDD_R} recov=${p.recovery} +mo=${p.posMonths}/${p.months} sharpe=${p.monthlySharpe} maxConc=${p.maxConcurrent}`;
console.log('\n'+line('DESIGN (in-sample)', pd));
console.log(line('HOLDOUT (OOS)     ', ph));
console.log('\nOOS monthly R:'); for (const [m,r] of ph.monthlyR_byMonth) console.log(`  ${m}: ${r>=0?'+':''}${r}`);

console.log('\nOOS sizing (fixed-R, per-trade risk as % of capital):');
console.log('  risk/trade   avg/month   worst month   max drawdown');
for (const rp of [0.10,0.15,0.20,0.25]){ const f=rp/100;
  console.log(`   ${rp.toFixed(2)}%`.padEnd(13),
    `${(ph.avgMonthR*f*100).toFixed(2)}%`.padStart(9),
    `${(ph.worstMonthR*f*100).toFixed(2)}%`.padStart(13),
    `${(ph.maxDD_R*f*100).toFixed(2)}%`.padStart(14));
}
console.log('\nNOTE: use FIXED fractional risk (0.15-0.20%). Do NOT use Kelly off these stats — in-sample Kelly oversizes ~5-9x and causes ruin out-of-sample.');

if (has('write')){
  const out = {
    generatedAt: new Date().toISOString(),
    strategy: { timeframe:CFG.tf, slMultiplier:CFG.slMultiplier, tpMultiplier:tpMul, rr:CFG.rr, minScore:CFG.minScore,
      niftyTrend:{fast:CFG.niftyFast, slow:CFG.niftySlow}, skipNiftyHighVol:{lookbackDays:CFG.volLookback, rangePctThreshold:CFG.volThresholdPct},
      dailyLossLimitR:CFG.dailyLossLimitR, selectBy:CFG.selectBy,
      execution:'futures intraday, square-off 15:25 IST, no carry', costRoundTrip:CFG.cost },
    basket: sel.map(s=>s.sym),
    holdout: ph, design: pd,
    sizing: 'fixed fractional 0.15-0.20% risk/trade; not Kelly',
  };
  const file = path.join(E.DATA_DIR, 'recommended-system.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${file}`);
}
