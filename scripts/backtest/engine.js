// ─────────────────────────────────────────────────────────────────────────────
// Intraday futures backtest engine (realistic path)
//
// Faithful re-implementation of the dashboard's execution model
// (signal on candle close -> entry next candle open -> intrabar SL/TP, intraday
// square-off) extended with the realistic-path levers found to matter:
//   - forced intraday square-off at ANY timeframe (15/30/60m)
//   - wide ATR stops (lower cost-per-R)
//   - NIFTY trend filter (only trade with the index)
//   - NIFTY high-volatility-day filter (skip whipsaw regimes)  <-- biggest robustness win
//   - configurable round-trip cost (futures), applied per trade in R terms
//   - portfolio aggregation: monthly R, drawdown, concurrency, optional daily loss limit
//
// All evaluation is meant to be done train/holdout (out-of-sample). See README.md.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');         // D:\CODEX
const DATA_DIR = path.join(ROOT, 'data');
const CANDLE_DIR = path.join(DATA_DIR, 'futures-eligible-cash-candles');
const { precomputeIndicators } = require(path.join(ROOT, 'server', 'lib', 'simulate'));
const { DEFAULT_THRESHOLDS } = require(path.join(ROOT, 'server', 'lib', 'indicators'));

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const LAST_ENTRY_MIN = 15 * 60 + 15;   // no new intraday entry after 15:15 IST
const SQUARE_OFF_MIN = 15 * 60 + 25;   // force square-off from 15:25 IST

// Default realistic all-in futures round-trip cost (incl. light slippage), as a
// fraction of (entry+exit) turnover. ~0.025%. Lower it for index futures.
const COST_FUTURES = 0.00025;

// ── candle io ────────────────────────────────────────────────────────────────
function safeName(s){ return String(s||'').replace(/[^\w.-]+/g,'_'); }
function candleFileFor(symbol){
  const direct = path.join(CANDLE_DIR, symbol, `${safeName(symbol)}_1m.json`);
  if (fs.existsSync(direct)) return direct;
  const dir = path.join(CANDLE_DIR, symbol);
  if (fs.existsSync(dir)){
    const f = fs.readdirSync(dir).find(x => /_1m\.json$/i.test(x));
    if (f) return path.join(dir, f);
  }
  return direct;
}
// NOTE: no persistent candle cache — callers process one symbol at a time and
// release the raw 1m array after aggregating (213 x ~35MB would blow the heap).
function loadCandles(symbol){
  const file = candleFileFor(symbol);
  if (!fs.existsSync(file)) return null;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(payload.candles) ? payload.candles : [];
}
function listSymbols(){
  if (!fs.existsSync(CANDLE_DIR)) return [];
  return fs.readdirSync(CANDLE_DIR).filter(n => fs.statSync(path.join(CANDLE_DIR,n)).isDirectory()).sort();
}

// ── aggregation (UTC-floored buckets align to IST 15/30/60m boundaries) ───────
function bucketKey(ts, tf){
  const ms = ts > 1e12 ? ts : ts * 1000;
  if (tf === 'D'){ const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())/1000; }
  const bk = Number(tf) * 60 * 1000;
  return Math.floor(ms/bk) * bk / 1000;
}
function aggregate(candles, tf){
  if (tf === '1') return candles;
  const buckets = new Map();
  for (const c of candles){
    const k = bucketKey(c.ts, tf);
    const b = buckets.get(k);
    if (!b) buckets.set(k, { ts:k, o:c.o, h:c.h, l:c.l, c:c.c, v:c.v||0 });
    else { b.h = Math.max(b.h, c.h); b.l = Math.min(b.l, c.l); b.c = c.c; b.v += c.v||0; }
  }
  return [...buckets.values()].sort((a,b)=>a.ts-b.ts);
}

// ── time helpers (IST) ────────────────────────────────────────────────────────
function tsMs(ts){ return ts > 1e12 ? ts : ts * 1000; }
function istMin(ts){ const d = new Date(tsMs(ts)+IST_OFFSET_MS); return d.getUTCHours()*60 + d.getUTCMinutes(); }
function istDay(ts){ return Math.floor((tsMs(ts)+IST_OFFSET_MS)/86400000); }
function monthKey(ts){ const d = new Date(tsMs(ts)+IST_OFFSET_MS); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function parseIST(dateStr){ return Date.parse(`${dateStr}T00:00:00+05:30`); }

// ── per-candle caches (keyed by the aggregated array via WeakMap) ─────────────
const _closes = new WeakMap(), _meta = new WeakMap(), _pre = new WeakMap();
function getCloses(c){ let v=_closes.get(c); if(!v){ v=c.map(x=>x.c); _closes.set(c,v);} return v; }
function getMeta(c){ let v=_meta.get(c); if(!v){ v={min:c.map(x=>istMin(x.ts)), day:c.map(x=>istDay(x.ts))}; _meta.set(c,v);} return v; }
function getPre(c, closes){ let v=_pre.get(c); if(!v){ v=precomputeIndicators(closes,{rsiPeriod:14,stochPeriod:14,cciPeriod:20,bbPeriod:20,atrPeriod:14}); _pre.set(c,v);} return v; }

// ── NIFTY regime helpers ──────────────────────────────────────────────────────
function emaSeries(a, p){ const k=2/(p+1); const o=new Float64Array(a.length); let e=a[0]; for(let i=0;i<a.length;i++){ e=i===0?a[i]:a[i]*k+e*(1-k); o[i]=e; } return o; }
// trend map: bucketTs -> +1 (uptrend) / -1 (downtrend) using fast/slow EMA on the trade TF
function buildIndexTrend(symbol, tf, fast=20, slow=50){
  const c = loadCandles(symbol); if (!c) return null;
  const agg = aggregate(c, tf); const closes = agg.map(x=>x.c);
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  const m = new Map(); for (let i=0;i<agg.length;i++) m.set(agg[i].ts, ef[i] >= es[i] ? 1 : -1);
  return m;
}
// set of IST dayKeys where NIFTY's N-day average daily range% exceeds threshold (whipsaw regimes)
function buildHighVolDays(symbol, thresholdPct=1.2, lookback=5){
  const c = loadCandles(symbol); if (!c) return new Set();
  const d = aggregate(c, 'D'); const rng = d.map(x => 100*(x.h-x.l)/x.c);
  const blocked = new Set();
  for (let i=0;i<d.length;i++){ const s=Math.max(0,i-(lookback-1)); let sum=0,n=0; for(let j=s;j<=i;j++){sum+=rng[j];n++;} if (sum/n > thresholdPct) blocked.add(istDay(d[i].ts)); }
  return blocked;
}

// ── core simulation ───────────────────────────────────────────────────────────
// config: { tf, slMultiplier, tpMultiplier, minScore, cooldown,
//           indexTrend(Map|null), blockedDays(Set|null), volMin, volMax, startMin, endMin }
// returns trades: { dir, entry, exit, grossR, riskAmt, entryTs, exitTs, reason }
function simulate(candles, config){
  const closes = getCloses(candles), n = closes.length;
  if (n < 60) return [];
  const m = getMeta(candles), pre = getPre(candles, closes);
  const thr = DEFAULT_THRESHOLDS;
  const minScore = config.minScore ?? 6;
  const slMul = config.slMultiplier ?? 2.5, tpMul = config.tpMultiplier ?? (slMul*5);
  const cd = config.cooldown ?? 8;
  const trend = config.indexTrend || null;
  const blocked = config.blockedDays || null;
  const volMin = config.volMin ?? -1, volMax = config.volMax ?? 1e9;
  const startMin = config.startMin ?? 0, endMin = config.endMin ?? 1440;
  const trades = [];
  let active = null, cool = 0, lastDir = null;

  const exitAt = (bi, t) => {
    const candle = candles[bi];
    if (m.min[bi] >= SQUARE_OFF_MIN) return { price:candle.o, reason:'EOD' };
    if (m.day[bi] !== m.day[t.entryBar]) return { price:candle.o, reason:'NOCARRY' };
    const hitTp = t.dir==='LONG' ? candle.h>=t.tp : candle.l<=t.tp;
    const hitSl = t.dir==='LONG' ? candle.l<=t.sl : candle.h>=t.sl;
    if (hitTp && hitSl) return { price:t.sl, reason:'SL_TP' };   // conservative: assume SL first
    if (hitTp) return { price:t.tp, reason:'TARGET' };
    if (hitSl) return { price:t.sl, reason:'SL' };
    return null;
  };
  const close = (t, px, reason, exitBar) => {
    const riskAmt = Math.abs(t.entry-t.sl) || 1e-9;
    const signed = t.dir==='LONG' ? px-t.entry : t.entry-px;
    const grossR = reason==='TARGET' ? Math.abs(t.tp-t.entry)/riskAmt : signed/riskAmt;
    trades.push({ dir:t.dir, entry:t.entry, exit:px, grossR, riskAmt, entryTs:candles[t.entryBar].ts, exitTs:candles[exitBar].ts, reason });
  };

  for (let i=30; i<n; i++){
    if (active){
      if (i > active.entryBar){ const ex = exitAt(i, active); if (ex){ close(active, ex.price, ex.reason, i); active=null; cool=cd; } }
      continue;
    }
    if (cool>0){ cool--; continue; }
    if (i+1>=n) continue;
    const rsi=pre.rsiArr[i],st=pre.stochArr[i],cci=pre.cciArr[i],macd=pre.macdArr[i],bb=pre.bbPctArr[i],e9=pre.ema9Arr[i],e21=pre.ema21Arr[i],adx=pre.adxArr[i],wr=st-100;
    let bull=0,bear=0;
    if(rsi>thr.rsiBullLo&&rsi<thr.rsiBullHi)bull++; if(macd>0)bull++; if(st>thr.stochBullLo&&st<thr.stochBullHi)bull++; if(cci>thr.cciBullMin)bull++; if(wr>thr.willrBullMin)bull++; if(e9>e21)bull++; if(bb>thr.bbBullLo&&bb<thr.bbBullHi)bull++; if(adx>thr.adxMin)bull++;
    if(rsi<thr.rsiBearHi&&rsi>thr.rsiBearLo)bear++; if(macd<0)bear++; if(st<thr.stochBearHi&&st>thr.stochBearLo)bear++; if(cci<thr.cciBearMax)bear++; if(wr<thr.willrBearMax)bear++; if(e9<e21)bear++; if(bb<thr.bbBearHi&&bb>thr.bbBearLo)bear++; if(adx>thr.adxMin)bear++;
    let dir=null;
    if (bull>=minScore && bull>bear) dir='LONG'; else if (bear>=minScore && bear>bull) dir='SHORT';
    if (!dir){ lastDir=null; continue; }
    if (dir===lastDir) continue;
    const entryBar = i+1;
    // ── entry filters ──
    if (m.min[entryBar] > LAST_ENTRY_MIN){ lastDir=dir; continue; }
    if (m.min[entryBar] < startMin || m.min[entryBar] > endMin){ lastDir=dir; continue; }
    if (blocked && blocked.has(m.day[entryBar])){ lastDir=dir; continue; }
    const atr = pre.atrArr[i], atrPct = atr/closes[i];
    if (atrPct < volMin || atrPct > volMax){ lastDir=dir; continue; }
    if (trend){ const tr = trend.get(candles[i].ts); if (tr!==undefined){ if (dir==='LONG'&&tr<0){lastDir=dir;continue;} if (dir==='SHORT'&&tr>0){lastDir=dir;continue;} } }
    const entry = candles[entryBar].o;
    const risk = Math.max(atr*slMul, closes[i]*0.0015);
    const reward = Math.max(atr*tpMul, closes[i]*0.0015*(tpMul/slMul));
    lastDir = dir;
    active = { dir, entry, sl: dir==='LONG'?entry-risk:entry+risk, tp: dir==='LONG'?entry+reward:entry-reward, entryBar };
    const ex = exitAt(entryBar, active); if (ex){ close(active, ex.price, ex.reason, entryBar); active=null; cool=cd; }
  }
  return trades;
}

// ── cost ──────────────────────────────────────────────────────────────────────
function applyCost(trades, rate=COST_FUTURES){
  for (const t of trades){
    const turnover = Math.abs(t.entry)+Math.abs(t.exit);
    t.costR = turnover*rate/(Math.abs(t.riskAmt)||1e-9);
    t.netR = t.grossR - t.costR;
  }
  return trades;
}

// ── portfolio aggregation ─────────────────────────────────────────────────────
// opts: { maxConcurrent, dailyLossLimitR }  (trades must have netR/entryTs/exitTs)
function aggregatePortfolio(trades, opts={}){
  let pool = trades;
  if (opts.dailyLossLimitR){
    const ev=[]; for (const t of trades){ ev.push({ts:tsMs(t.entryTs),k:'E',t}); ev.push({ts:tsMs(t.exitTs),k:'X',t}); }
    ev.sort((a,b)=>a.ts-b.ts || (a.k==='X'?-1:1));
    const dayReal={}, kept=new Set();
    for (const e of ev){ const d=istDay(e.t.entryTs);
      if (e.k==='E'){ if ((dayReal[d]||0) > -opts.dailyLossLimitR) kept.add(e.t); }
      else if (kept.has(e.t)) dayReal[d]=(dayReal[d]||0)+e.t.netR; }
    pool = trades.filter(t=>kept.has(t));
  }
  const maxConc = opts.maxConcurrent || Infinity;
  const byEntry = pool.slice().sort((a,b)=>tsMs(a.entryTs)-tsMs(b.entryTs));
  const taken=[]; const open=[]; let maxObs=0;
  for (const t of byEntry){
    for (let k=open.length-1;k>=0;k--){ if (tsMs(open[k])<=tsMs(t.entryTs)) open.splice(k,1); }
    if (open.length<maxConc){ taken.push(t); open.push(t.exitTs); if(open.length>maxObs)maxObs=open.length; }
  }
  const byExit = taken.slice().sort((a,b)=>tsMs(a.exitTs)-tsMs(b.exitTs));
  let cum=0,peak=0,maxDD=0,wins=0; const monthly=new Map();
  for (const t of byExit){ cum+=t.netR; if(cum>peak)peak=cum; const dd=peak-cum; if(dd>maxDD)maxDD=dd; if(t.netR>0)wins++; const mk=monthKey(t.exitTs); monthly.set(mk,(monthly.get(mk)||0)+t.netR); }
  const months=[...monthly.keys()].sort(); const mr=months.map(k=>monthly.get(k));
  const totalR=byExit.reduce((s,t)=>s+t.netR,0);
  const mean = mr.length? totalR/mr.length : 0;
  const std = mr.length? Math.sqrt(mr.reduce((s,r)=>s+(r-mean)**2,0)/mr.length) : 0;
  const sorted = mr.slice().sort((a,b)=>a-b);
  return {
    totalTrades:taken.length, skipped:trades.length-taken.length,
    totalR:+totalR.toFixed(2), winRate:+(taken.length?100*wins/taken.length:0).toFixed(2),
    maxDD_R:+maxDD.toFixed(2), recovery:+(maxDD>0?totalR/maxDD:Infinity).toFixed(2),
    months:mr.length, posMonths:mr.filter(r=>r>0).length, negMonths:mr.filter(r=>r<=0).length,
    avgMonthR:+mean.toFixed(2), medianMonthR:+(sorted.length?sorted[Math.floor(sorted.length/2)]:0).toFixed(2),
    worstMonthR:+(sorted.length?sorted[0]:0).toFixed(2), bestMonthR:+(sorted.length?sorted[sorted.length-1]:0).toFixed(2),
    monthStdR:+std.toFixed(2), monthlySharpe:+(std>0?mean/std:0).toFixed(2),
    maxConcurrent:maxObs, monthlyR_byMonth: months.map((k,i)=>[k,+mr[i].toFixed(2)])
  };
}

module.exports = {
  ROOT, DATA_DIR, CANDLE_DIR, COST_FUTURES,
  loadCandles, listSymbols, aggregate, simulate, applyCost, aggregatePortfolio,
  buildIndexTrend, buildHighVolDays,
  tsMs, istDay, monthKey, parseIST
};
