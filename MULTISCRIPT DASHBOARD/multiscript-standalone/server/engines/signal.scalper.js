// ─────────────────────────────────────────────────────────────────────────────
// signal.scalper.js — faithful port of the BACKTESTED signal engine.
//
// The default signal.engine.js uses an SMA/slope/RSI score. The backtested
// "realistic-path" system instead uses the 8-indicator score (RSI, MACD, Stoch,
// CCI, Williams %R, EMA9>EMA21, Bollinger %B, ADX) with thresholds + minScore —
// identical to D:\CODEX\server\lib (optimizer). Use this module so paper/replay
// trading tests the SAME strategy that was validated. Drop-in for scoreSeries().
//
// Matches the backtest by scoring on CLOSED candles (does not fold the live tick
// into the score); the live price is still used as the entry in strategy.engine.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const DEFAULT_THRESHOLDS = {
  rsiBullLo: 52, rsiBullHi: 70, rsiBearLo: 30, rsiBearHi: 48,
  stochBullLo: 55, stochBullHi: 85, stochBearLo: 15, stochBearHi: 45,
  cciBullMin: 50, cciBearMax: -50,
  willrBullMin: -45, willrBearMax: -55,
  bbBullLo: 0.5, bbBullHi: 0.9, bbBearLo: 0.1, bbBearHi: 0.5,
  adxMin: 22, minScore: 6
};

// EMA seeded from arr[0] to match the backtest's precomputeIndicators exactly
// (so live/replay signals equal the validated backtest). Pass enough history.
function ema(arr, p){ if (arr.length < p) return null; const k=2/(p+1); let e=arr[0]; for(let i=1;i<arr.length;i++) e=arr[i]*k+e*(1-k); return e; }
function calcRSI(a,p=14){ if(a.length<p+1) return 50; let g=0,l=0; for(let i=a.length-p;i<a.length;i++){const d=a[i]-a[i-1]; d>0?g+=d:l+=Math.abs(d);} return 100-100/(1+g/(l||1e-9)); }
function calcStoch(a,p=14){ if(a.length<p) return 50; const s=a.slice(-p),lo=Math.min(...s),hi=Math.max(...s); return hi===lo?50:((a[a.length-1]-lo)/(hi-lo))*100; }
function calcCCI(a,p=20){ if(a.length<p) return 0; const s=a.slice(-p),m=s.reduce((x,y)=>x+y,0)/p,md=s.reduce((x,y)=>x+Math.abs(y-m),0)/p; return md===0?0:(a[a.length-1]-m)/(0.015*md); }
function calcMACD(a){ if(a.length<26) return 0; return (ema(a,12)||0)-(ema(a,26)||0); }
function calcBB(a,p=20){ if(a.length<p) return {pct:0.5}; const s=a.slice(-p),m=s.reduce((x,y)=>x+y,0)/p,sd=Math.sqrt(s.reduce((x,y)=>x+(y-m)**2,0)/p),u=m+2*sd,l=m-2*sd; return {pct:u===l?0.5:(a[a.length-1]-l)/(u-l)}; }
function calcATR(a,p=14){ if(a.length<p+1) return a[a.length-1]*0.005; let s=0; for(let i=a.length-p;i<a.length;i++) s+=Math.abs(a[i]-a[i-1]); return s/p; }
function calcADX(a,p=14){ const atr=calcATR(a,p); const range=a.length>p?Math.abs(a[a.length-1]-a[a.length-1-p]):0; return Math.min(60,Math.max(10,(range/(atr*p||1e-9))*30)); }

function scoreSeries(candles = [], livePrice, config = {}){
  const closes = candles.map(c => Number(c.close ?? c.c ?? c.ltp ?? 0)).filter(Number.isFinite);
  if (closes.length < 30) return { bull:0, bear:0, signal:'WAIT', trend:'flat', indicators:{ last: closes[closes.length-1] || livePrice || 0 } };

  const thr = { ...DEFAULT_THRESHOLDS, ...(config.thresholds || {}), minScore: config.minScore ?? DEFAULT_THRESHOLDS.minScore };
  const rsi   = calcRSI(closes, config.rsiPeriod || 14);
  const stoch = calcStoch(closes, config.stochPeriod || 14);
  const cci   = calcCCI(closes, config.cciPeriod || 20);
  const macd  = calcMACD(closes);
  const bb    = calcBB(closes, config.bbPeriod || 20).pct;
  const e9    = ema(closes, 9)  ?? closes[closes.length-1];
  const e21   = ema(closes, 21) ?? closes[closes.length-1];
  const willr = stoch - 100;
  const adx   = calcADX(closes, config.atrPeriod || 14);

  let bull = 0, bear = 0;
  if (rsi>thr.rsiBullLo && rsi<thr.rsiBullHi) bull++;
  if (macd>0) bull++;
  if (stoch>thr.stochBullLo && stoch<thr.stochBullHi) bull++;
  if (cci>thr.cciBullMin) bull++;
  if (willr>thr.willrBullMin) bull++;
  if (e9>e21) bull++;
  if (bb>thr.bbBullLo && bb<thr.bbBullHi) bull++;
  if (adx>thr.adxMin) bull++;
  if (rsi<thr.rsiBearHi && rsi>thr.rsiBearLo) bear++;
  if (macd<0) bear++;
  if (stoch<thr.stochBearHi && stoch>thr.stochBearLo) bear++;
  if (cci<thr.cciBearMax) bear++;
  if (willr<thr.willrBearMax) bear++;
  if (e9<e21) bear++;
  if (bb<thr.bbBearHi && bb>thr.bbBearLo) bear++;
  if (adx>thr.adxMin) bear++;

  const minScore = thr.minScore;
  const signal = (bull>=minScore && bull>bear) ? 'LONG' : (bear>=minScore && bear>bull) ? 'SHORT' : 'WAIT';
  return {
    bull, bear, signal,
    trend: signal==='LONG' ? 'up' : signal==='SHORT' ? 'down' : 'flat',
    indicators: { rsi, stoch, cci, macd, bbPct: bb, ema9: e9, ema21: e21, adx, last: closes[closes.length-1] }
  };
}

module.exports = { scoreSeries, DEFAULT_THRESHOLDS };
