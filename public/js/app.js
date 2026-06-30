// ── CLAUDE Scalping System — Main App ─────────────────────────────────
'use strict';

window.CLAUDE_BASE = window.location.origin;

// ── State ─────────────────────────────────────────────────────────────
const State = {
  running:       true,
  isLive:        false,
  prices:        [],
  candles:       [],
  currentCandle: null,
  ticksInCandle: 0,
  tradeCount:    0,
  wins:          0,
  losses:        0,
  pnl:           0,
  peakPnl:       0,
  maxDD:         0,
  allTrades:     [],
  equityCurve:   [0],
  activeTrade:   null,
  signalCooldown:0,
  lastDir:       null,
  vwapState:     { sum: 0, vol: 0, price: 0 },
  newsBlocked:   false,
  newsTimer:     0,
  tickN:         0,
  newsSchedule:  [], // legacy fallback; no longer used by the live NSE feed
  nseFeedItems:  [],
  nseFeedLastGuid: '',
  nseFeedPaused:  false,
  nseFeedLoading: false,
  nseFeedLastUpdated: '',
  simPrice:      2450.00,
  selectedSec:   null,   // {symbol, name, secId, exchange}
  livePollTimer: null,
  simInterval:   null,
  credentials:   { clientId: '', token: '' },
  // Per-symbol optimized configs, keyed by secId. Persists across symbol
  // switches (and across browser sessions via localStorage) so tuning HCC
  // to 3:1 doesn't get wiped out just by checking RELIANCE and coming back.
  symbolConfigs: {},   // { [secId]: { slMultiplier, tpMultiplier, minScore, thresholds, params, targetRR, savedAt } }
  liveConfig:    null, // computed pointer: symbolConfigs[selectedSec.secId] || null

  // ── Chart view mode ───────────────────────────────────────────────────
  // 'live'     -> chart shows the rolling live candle buffer (State.candles), updated every poll tick
  // 'backtest' -> chart shows a frozen historical snapshot (State.backtestCandles), untouched by live polling
  // This separation is what stops the live price poller from corrupting
  // backtest trade markers while you're reviewing Step 1/Step 2 results.
  chartMode:         'live',
  backtestCandles:   [],     // frozen historical candles for the currently-displayed backtest/optimize run
  backtestTrades:    [],     // the trade list currently shown in the Backtest Trade Log + as chart markers
  backtestOffset:    0,      // candle index where the displayed 200-candle slice starts, for marker mapping
  highlightedTradeIdx: -1,   // index into backtestTrades currently highlighted (clicked row), -1 = none

  // ── Top-level app mode: drives which sidebars/cards/tables are visible ──
  // 'live'     -> left+center+right show live trading UI (watchlist, batch, live trade log)
  // 'backtest' -> same left sidebar, but center/right show backtest trade log + optimizer panel
  // Distinct from chartMode above: appMode is the user's explicit top-bar
  // toggle choice; chartMode is what the CHART CANVAS is currently displaying
  // (which usually but not always matches — e.g. live mode chart can still
  // be "frozen" briefly if you just switched away from reviewing a backtest).
  appMode: 'live',
  chartType:   'candle',   // 'candle' | 'line' — persists across mode switches
  showVolume:  true
};

const NEWS_EVENTS = [
  "RBI policy in 2 min — trading suspended",
  "Q4 results in 2 min — trading suspended",
  "Budget statement in 2 min — trading suspended",
  "FII/DII data in 2 min — trading suspended",
  "SEBI circular in 2 min — trading suspended"
];
const NEWS_CLEAR = [
  "Event passed — scanning resumed",
  "Blackout lifted — indicators re-validated",
  "News window closed"
];
const TICKS_PER_CANDLE = { '1': 6, '3': 12, '5': 20 };

// ── Per-symbol config persistence (file-backed on disk via server) ────
// Saved configs live in data/symbol-configs.json on the server, keyed by
// Dhan security ID — so each stock keeps its own tuned R:R/thresholds, and
// it survives browser changes, incognito mode, and machine restarts (unlike
// localStorage, which is scoped to a single browser profile).

async function loadSymbolConfigsFromStorage() {
  try {
    const res  = await fetch(`${window.CLAUDE_BASE}/api/symbol-configs`);
    const data = await res.json();
    State.symbolConfigs = data.configs || {};
  } catch (e) {
    console.warn('[Config] Could not load saved configs from server:', e.message);
    State.symbolConfigs = {};
  }
  // Re-apply to whatever symbol is currently selected, now that configs are loaded
  applySymbolConfigForSelected();
}

async function saveSymbolConfigToServer(secId, config) {
  try {
    const res = await fetch(`${window.CLAUDE_BASE}/api/symbol-configs/${secId}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(config)
    });
    const data = await res.json();
    State.symbolConfigs[secId] = data.config;
    return data.config;
  } catch (e) {
    console.warn('[Config] Could not save config to server:', e.message);
    throw e;
  }
}

async function deleteSymbolConfigFromServer(secId) {
  try {
    await fetch(`${window.CLAUDE_BASE}/api/symbol-configs/${secId}`, { method: 'DELETE' });
    delete State.symbolConfigs[secId];
  } catch (e) {
    console.warn('[Config] Could not delete config on server:', e.message);
  }
}

// Sets the active liveConfig for the currently selected symbol, pulling from
// the saved per-symbol map if one exists, or null (defaults to 2:1) if not.
function applySymbolConfigForSelected() {
  if (!State.selectedSec) { State.liveConfig = null; return; }
  const saved = State.symbolConfigs[State.selectedSec.secId];
  State.liveConfig = saved || null;
  updateLiveConfigBadge();
}

function updateLiveConfigBadge() {
  const cfg = State.liveConfig;
  const statusEl = el('selectedConfigStatus');
  if (cfg) {
    const rr = (cfg.tpMultiplier / cfg.slMultiplier).toFixed(1);
    setText('mRR', rr + ':1');
    const badge = el('liveConfigBadge');
    if (badge) {
      badge.style.display = 'inline-flex';
      badge.title = `Tuned ${rr}:1 config saved on ${new Date(cfg.savedAt).toLocaleDateString('en-IN')} — applies only to ${State.selectedSec.symbol}`;
    }
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = `✓ ${rr}:1 tuned config saved for this stock`;
    }
  } else {
    setText('mRR', '2.0:1');
    const badge = el('liveConfigBadge');
    if (badge) badge.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';
  }
}

// ── Kelly Criterion ───────────────────────────────────────────────────
function kellyCalc(atr) {
  const acct   = parseFloat(document.getElementById('acctSize').value)   || 100000;
  const maxRpct= parseFloat(document.getElementById('maxRiskPct').value) || 1;
  const frac   = parseFloat(document.getElementById('kellyFrac').value)  || 0.5;
  const wp     = State.tradeCount > 0 ? State.wins / State.tradeCount : 0;
  const rawK   = State.tradeCount >= 3 ? Math.max(0, (2 * wp - (1 - wp)) / 2) : 0;
  const fracK  = rawK * frac;
  const capK   = Math.min(fracK, maxRpct / 100);
  const effR   = State.tradeCount >= 3 && fracK > 0 ? capK : (maxRpct / 100) * 0.4;
  const dRisk  = acct * effR;
  const shares = atr > 0 ? Math.floor(dRisk / (atr * 1.2)) : 0;

  setText('kWinP',  State.tradeCount ? (wp * 100).toFixed(1) + '%' : '—');
  setText('kRaw',   rawK > 0 ? (rawK * 100).toFixed(1) + '%' : '—');
  setText('kFrac',  fracK > 0 ? (fracK * 100).toFixed(1) + '%' : '—');
  setText('kDollar','₹' + dRisk.toLocaleString('en-IN', { maximumFractionDigits: 0 }));
  setText('kShares',shares > 0 ? shares + ' shares' : '—');
  setText('mKelly', fracK > 0 ? (fracK * 100).toFixed(1) + '%' : '—');
  setText('mSize',  '₹' + dRisk.toLocaleString('en-IN', { maximumFractionDigits: 0 }));
  return { dRisk, shares };
}

// ── Candle aggregation ────────────────────────────────────────────────
function tpcCount() {
  return TICKS_PER_CANDLE[document.getElementById('tfSel').value] || 6;
}

function addTick(price) {
  if (!State.currentCandle) {
    State.currentCandle = { o: price, h: price, l: price, c: price, ts: Date.now() };
    State.ticksInCandle  = 0;
  }
  State.currentCandle.h = Math.max(State.currentCandle.h, price);
  State.currentCandle.l = Math.min(State.currentCandle.l, price);
  State.currentCandle.c = price;
  State.ticksInCandle++;

  if (State.ticksInCandle >= tpcCount()) {
    const e9  = Indicators.ema(State.prices, 9);
    const e21 = Indicators.ema(State.prices, 21);
    const bb  = Indicators.calcBB(State.prices);
    State.candles.push({ ...State.currentCandle, ema9: e9, ema21: e21, bbu: bb.upper, bbl: bb.lower });
    if (State.candles.length > 200) State.candles.shift();
    State.currentCandle = null;
  }
}

// ── Signal engine ─────────────────────────────────────────────────────
function processPrice(price, prev) {
  State.prices.push(price);
  if (State.prices.length > 300) State.prices.shift();
  State.vwapState.sum += price * 1000;
  State.vwapState.vol += 1000;
  State.vwapState.price = State.vwapState.sum / State.vwapState.vol;
  addTick(price);

  const ind = Indicators.snapshot(State.prices);
  if (!ind) return;

  // Only redraw the chart with LIVE candles if we're actually in live view mode.
  // While reviewing a backtest/optimize result (chartMode === 'backtest'), the
  // chart stays frozen on the historical snapshot — the live poller still runs
  // underneath (so signals keep firing and trades keep logging), it just
  // doesn't touch the chart until you switch back to live view.
  if (State.chartMode === 'live') {
    const signal = State.activeTrade
      ? [{ dir: State.activeTrade.dir, entry: State.activeTrade.entry, sl: State.activeTrade.sl, tp: State.activeTrade.tp }]
      : [];
    CandleChart.update(State.candles, State.currentCandle ? { ...State.currentCandle, c: price } : null, signal);
  }

  updateTopBarFromState(ind);
  updateIndicators(ind, price);
  kellyCalc(ind.atr);

  // Active trade management
  if (State.activeTrade) {
    const d     = State.activeTrade.dir;
    const hit_tp = d === 'LONG' ? price >= State.activeTrade.tp : price <= State.activeTrade.tp;
    const hit_sl = d === 'LONG' ? price <= State.activeTrade.sl : price >= State.activeTrade.sl;
    if (hit_tp || hit_sl) {
      closeTrade(price, hit_tp, ind.atr);
    }
    return;
  }

  if (State.signalCooldown > 0) { State.signalCooldown--; return; }
  if (State.newsBlocked) {
    setBadge('sbadge', 'NEWS HOLD', 'badge-news');
    return;
  }

  const bull = ind.bull, bear = ind.bear;
  const uiMinScore = parseInt(el('minSignal')?.value, 10) || 6;
  const minScore = (State.liveConfig && State.liveConfig.minScore) || uiMinScore;
  let dir = null, score = 0;
  if (bull >= minScore && bull > bear) { dir = 'LONG';  score = bull; }
  else if (bear >= minScore && bear > bull) { dir = 'SHORT'; score = bear; }

  if (dir && dir !== State.lastDir) {
    openTrade(dir, price, ind.atr, score);
  } else if (!dir) {
    State.lastDir = null;
  }
}

function openTrade(dir, price, atr, score) {
  const cfg   = State.liveConfig || {};
  const slMul = cfg.slMultiplier || 1.2;
  const tpMul = cfg.tpMultiplier || 2.4;
  const risk   = Math.max(atr * slMul, price * 0.0015);
  const reward = Math.max(atr * tpMul, price * 0.0015 * (tpMul / slMul));
  const entry  = price;
  const sl     = dir === 'LONG' ? entry - risk   : entry + risk;
  const tp     = dir === 'LONG' ? entry + reward : entry - reward;
  State.lastDir     = dir;
  State.activeTrade = { dir, entry, sl, tp, score, atr, entryBar: liveChartBarIndex() };
  const rr = (tpMul / slMul).toFixed(1);
  setBadge('sbadge', dir === 'LONG' ? '▲ LONG' : '▼ SHORT', dir === 'LONG' ? 'badge-long' : 'badge-short');
  setText('sigStr', `${score}/8 indicators aligned · ${rr}:1 R:R`);
  setText('sEntry', fmtPrice(entry));
  setText('sSL',    fmtPrice(sl));
  setText('sTP',    fmtPrice(tp));
}

function closeTrade(exitPrice, won) {
  const rMult = won ? 2 : -1;
  State.pnl += rMult;
  won ? State.wins++ : State.losses++;
  if (State.pnl > State.peakPnl) State.peakPnl = State.pnl;
  const dd = State.peakPnl - State.pnl;
  if (dd > State.maxDD) State.maxDD = dd;
  State.tradeCount++;

  const sz    = kellyCalc(State.activeTrade.atr);
  const dPnl  = won ? sz.dRisk * 2 : -sz.dRisk;
  const trade = {
    n: State.tradeCount,
    dir: State.activeTrade.dir,
    entry: State.activeTrade.entry,
    exit: exitPrice,
    rMult, won,
    score: State.activeTrade.score,
    dPnl,
    entryBar: State.activeTrade.entryBar,
    exitBar: liveChartBarIndex(),
    ts: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };
  State.allTrades.push(trade);
  addTradeRow(trade);
  updateMetrics();
  updateEquityCurve();
  if (State.chartMode === 'live') syncLiveTradeMarkers();
  syncLiveTradeMarkers();

  State.activeTrade    = null;
  State.signalCooldown = 8;
  setBadge('sbadge', 'SCANNING', 'badge-wait');
  setText('sigStr', 'Waiting for setup');
  setText('sEntry', '—'); setText('sSL', '—'); setText('sTP', '—');
}

// ── Auto-load credentials from .env via server ────────────────────────
async function autoLoadCredentials() {
  try {
    const res  = await fetch(`${window.CLAUDE_BASE}/api/credentials`);
    const data = await res.json();
    if (data.clientId) el('credClientId').value = data.clientId;
    if (data.token)    el('credToken').value    = data.token;
    if (data.ready) {
      setConnStatus('sim', 'Credentials loaded from .env — select a symbol & connect');
      el('credClientId').style.borderColor = 'var(--green)';
      el('credToken').style.borderColor    = 'var(--green)';
    } else {
      setConnStatus('sim', 'No credentials in .env yet — see README');
    }
  } catch (e) {
    // Server not running — silent fail, user enters manually
  }
}

// ── Simulation tick ───────────────────────────────────────────────────
function simTick() {
  if (!State.running) return;
  State.tickN++;

  // News filter
  const nfOn = document.getElementById('newsFilter').value === '1';
  if (State.newsTimer > 0) {
    State.newsTimer--;
    if (State.newsTimer === 0) {
      State.newsBlocked = false;
      setText('ntext', 'NSE feed clear');
    }
  }
  if (!nfOn) {
    State.newsBlocked = false;
  }

  if (State.selectedSec) {
    // When a symbol is selected, keep the top bar anchored to that symbol
    // instead of letting the generic demo ticker drift away from it.
    refreshTopBarFromHover(null);
    return;
  }

  const prev = State.simPrice;
  const vol  = State.simPrice * 0.0007;
  State.simPrice = Math.max(State.simPrice * 0.85, Math.min(State.simPrice * 1.15,
    State.simPrice + rnd(-vol, vol * 1.1) + rnd(-vol * 0.5, vol * 0.5)));

  processPrice(State.simPrice, prev);
  updateMarketClock();
}

// ── Live polling from Dhan ────────────────────────────────────────────
async function pollLTP() {
  if (!State.running || !State.selectedSec) return;
  try {
    const prices = await DhanAPI.getLTP(
      State.selectedSec.exchange,
      [State.selectedSec.secId]
    );
    const p    = prices[State.selectedSec.secId];
    const prev = State.prices[State.prices.length - 1] || p;
    if (p && p > 0) {
      State.simPrice = p;
      processPrice(p, prev);
    }
  } catch (e) {
    console.warn('[Live] Poll error:', e.message);
  }
}

// ── UI helpers ────────────────────────────────────────────────────────
const el   = id => document.getElementById(id);
const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };
function fmtPrice(p) { return '₹' + p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function rnd(a, b) { return Math.random() * (b - a) + a; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function setBadge(id, text, cls) {
  const e = el(id);
  if (!e) return;
  e.className = 'badge ' + cls;
  e.textContent = text;
}

// ── Global toast ────────────────────────────────────────────────────
// Visible regardless of which mode (Live/Backtest) is active — used for
// confirmations like "Added to watchlist" that would otherwise get written
// to a status line hidden by the current mode's CSS rules.
let toastTimer = null;
function showToast(msg, isError) {
  const t = el('globalToast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'global-toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'global-toast'; }, 3200);
}

// ── Top-level app mode switching (LIVE ↔ BACKTEST & OPTIMIZE) ─────────
// Switches which cards/tables are visible via a data-mode attribute on
// <body> (CSS in styles.css does the actual show/hide). Crucially, this
// does NOT touch State.allTrades / State.backtestTrades / chart data —
// each mode keeps its own trade log and equity curve completely separate,
// so switching back and forth never mixes live trades into backtest
// results or vice versa.
function setAppMode(mode) {
  if (mode !== 'live' && mode !== 'backtest') return;
  State.appMode = mode;
  document.body.setAttribute('data-mode', mode);

  el('btnModeLive').classList.toggle('active', mode === 'live');
  el('btnModeBacktest').classList.toggle('active', mode === 'backtest');

  if (mode === 'live') {
    // Returning to live: redraw the chart with whatever the live buffer
    // currently holds (the live poller never stopped running underneath).
    // Live mode should show completed live trades, but not backtest markers.
    State.chartMode = 'live';
    State.highlightedTradeIdx = -1;
    syncLiveTradeMarkers();
    el('chartMarkerLegend').style.display = State.allTrades.length ? 'flex' : 'none';
    CandleChart.update(State.candles, State.currentCandle ? { ...State.currentCandle } : null, []);
  } else {
    // Entering backtest mode: if a backtest snapshot already exists (user
    // ran one earlier this session), show it again; otherwise the chart
    // just stays on whatever was last drawn until "Run Backtest" is clicked.
    if (State.backtestCandles.length) {
      State.chartMode = 'backtest';
      CandleChart.update(State.backtestCandles, null, []);
      if (State.backtestTrades.length) {
        CandleChart.setTradeMarkers(State.backtestTrades.map((t, i) => ({
          entryBar: t.entryBar, exitBar: t.exitBar, dir: t.dir, entry: t.entry, exit: t.exit, result: t.result, tradeIdx: i
        })));
        el('chartMarkerLegend').style.display = 'flex';
      }
    }
  }
}

// ── Chart type (candlestick/line) + volume toggle ─────────────────────
function setChartType(type) {
  State.chartType = type;
  CandleChart.setChartType(type);
  el('btnChartCandle').classList.toggle('active', type === 'candle');
  el('btnChartLine').classList.toggle('active', type === 'line');
}

function setShowVolume(show) {
  State.showVolume = show;
  CandleChart.setShowVolume(show);
}

// ── Panel maximize / restore ──────────────────────────────────────────
// Clicking ⤢ on any of the 3 columns (left sidebar, center chart, right
// sidebar) expands it to fill the whole window — the other two columns are
// fully removed from layout (display:none via CSS), not just visually
// shrunk. Clicking the same button again (now showing ⤡) restores the
// normal 3-column view. Only one panel can be maximized at a time.
let maximizedPanel = null;   // 'left' | 'center' | 'right' | null

function togglePanelMaximize(panel) {
  const mainEl = el('mainLayout');
  const btnMap = { left: 'btnMaximizeLeft', center: 'btnMaximizeCenter', right: 'btnMaximizeRight' };

  if (maximizedPanel === panel) {
    // Restore
    mainEl.classList.remove(`maximized-${panel}`);
    el(btnMap[panel]).textContent = '⤢';
    el(btnMap[panel]).title = 'Maximize this panel';
    maximizedPanel = null;
  } else {
    // Switch directly from one maximized panel to another, or maximize fresh
    if (maximizedPanel) {
      mainEl.classList.remove(`maximized-${maximizedPanel}`);
      el(btnMap[maximizedPanel]).textContent = '⤢';
      el(btnMap[maximizedPanel]).title = 'Maximize this panel';
    }
    mainEl.classList.add(`maximized-${panel}`);
    el(btnMap[panel]).textContent = '⤡';
    el(btnMap[panel]).title = 'Restore 3-column view';
    maximizedPanel = panel;
  }

  // The chart's canvas needs an explicit resize once its container's
  // width actually changes, since canvas dimensions don't auto-follow CSS.
  // When the center panel is maximized, also grow the chart's height to
  // use the extra vertical space freed up by the hidden sidebars.
  setTimeout(() => {
    CandleChart.setHeight(maximizedPanel === 'center' ? 520 : 250);
  }, 50);
}

// ── Indicators panel collapse ────────────────────────────────────────
let indicatorsCollapsed = false;

function toggleIndicatorsPanel() {
  indicatorsCollapsed = !indicatorsCollapsed;
  el('indicatorsGridBody').style.display = indicatorsCollapsed ? 'none' : 'grid';
  el('indicatorsToggleIcon').textContent = indicatorsCollapsed ? '▸ show' : '▾ hide';
}

function updateTopBarFromState(ind) {
  const hover = CandleChart.getHoverCandle ? CandleChart.getHoverCandle() : null;
  const backtestMode = State.chartMode === 'backtest' && State.backtestCandles.length > 0;
  const liveMode = !!State.isLive;

  let source = null;
  let price = 0;
  let prev = 0;

  if (hover) {
    source = hover;
    price = Number(hover.c ?? hover.candleClose ?? hover.close ?? hover.o ?? 0) || 0;
    const candles = backtestMode ? State.backtestCandles : State.candles;
    const prevCandle = candles[Math.max(0, hover.barIndex - 1)] || null;
    prev = prevCandle ? Number(prevCandle.c ?? prevCandle.close ?? price) : price;
  } else if (backtestMode) {
    source = State.backtestCandles[State.backtestCandles.length - 1];
    price = Number(source?.c ?? source?.close ?? 0) || 0;
    const prevCandle = State.backtestCandles[State.backtestCandles.length - 2] || null;
    prev = prevCandle ? Number(prevCandle.c ?? prevCandle.close ?? price) : price;
  } else {
    source = State.currentCandle || State.candles[State.candles.length - 1] || null;
    price = liveMode && Number.isFinite(State.simPrice)
      ? State.simPrice
      : Number(source?.c ?? source?.close ?? 0) || 0;
    prev = State.prices.length > 1
      ? State.prices[State.prices.length - 2]
      : price;
  }

  const delta = price - prev;
  const up    = delta >= 0;
  el('topPrice').textContent = fmtPrice(price);
  el('topPrice').className   = 'topbar-price ' + (up ? 'up' : 'dn');
  el('topDelta').textContent = (up ? '▲ +' : '▼ ') + Math.abs(delta).toFixed(2);
  el('topDelta').className   = 'topbar-delta ' + (up ? 'up' : 'dn');
  if (source) {
    const o = Number(source.o ?? source.open ?? price) || price;
    const h = Number(source.h ?? source.high ?? price) || price;
    const l = Number(source.l ?? source.low ?? price) || price;
    const c = Number(source.c ?? source.close ?? price) || price;
    el('topOHLC').textContent = `O ${fmtPrice(o)}  H ${fmtPrice(h)}  L ${fmtPrice(l)}  C ${fmtPrice(c)}`;
  }
  el('topSym').textContent = formatTopSymLabel(
    hover ? 'HOVER' : (liveMode ? 'LIVE' : backtestMode ? 'BACKTEST' : 'SIMULATION')
  );
}

function updateIndicators(ind, price) {
  const vdev = price - State.vwapState.price;
  const setI = (id, val, pct, color) => {
    const e = el(id + 'Val');
    if (e) e.textContent = typeof val === 'number' ? val.toFixed(Math.abs(val) > 10 ? 1 : 2) : val;
    const b = el(id + 'Bar');
    if (b) { b.style.width = clamp(pct, 2, 98) + '%'; b.style.background = color; }
  };
  setI('rsi',   ind.rsi,        ind.rsi,              ind.rsi > 70 || ind.rsi < 30 ? '#E24B4A' : '#378ADD');
  setI('macd',  ind.macd,       50 + ind.macd * 0.5,  ind.macd > 0 ? '#1D9E75' : '#E24B4A');
  setI('stoch', ind.stoch,      ind.stoch,            ind.stoch > 80 || ind.stoch < 20 ? '#E24B4A' : '#1D9E75');
  setI('atr',   ind.atr,        clamp(ind.atr / (price * 0.0002) * 40, 5, 95), '#EF9F27');
  setI('cci',   ind.cci,        50 + ind.cci / 4,     ind.cci > 100 ? '#1D9E75' : ind.cci < -100 ? '#E24B4A' : '#D4537E');
  setI('willr', ind.willr,      100 + ind.willr,      ind.willr > -20 ? '#E24B4A' : ind.willr < -80 ? '#1D9E75' : '#7F77DD');
  const emaStatus = ind.e9 > ind.e21 ? 'BULL' : 'BEAR';
  setI('ema',   emaStatus,     ind.e9 > ind.e21 ? 70 : 30, ind.e9 > ind.e21 ? '#1D9E75' : '#E24B4A');
  setI('bb',    ind.bb.pct,    ind.bb.pct * 100,      '#0F6E56');
  setI('adx',   ind.adx,       ind.adx,               ind.adx > 25 ? '#D85A30' : '#565d6a');
  setI('mfi',   ind.mfi,       ind.mfi,               ind.mfi > 70 ? '#1D9E75' : ind.mfi < 30 ? '#E24B4A' : '#185FA5');
  setI('mom',   ind.mom,       50 + ind.mom * 0.5,    ind.mom > 0 ? '#639922' : '#E24B4A');
  setI('vwap',  vdev,          50 + vdev * 0.5,       vdev > 0 ? '#993556' : '#D4537E');
}

function updateMetrics() {
  const totalRs = State.allTrades.reduce((s, t) => s + t.dPnl, 0);
  const pe = el('mPnl');
  if (pe) { pe.textContent = (totalRs >= 0 ? '+' : '') + '₹' + Math.abs(totalRs).toLocaleString('en-IN', { maximumFractionDigits: 0 }); pe.className = 'metric-value ' + (totalRs >= 0 ? 'up' : 'dn'); }
  setText('mWr',     State.tradeCount ? (State.wins / State.tradeCount * 100).toFixed(0) + '%' : '—');
  setText('mTrades', State.tradeCount);
  setText('mDD',     State.maxDD.toFixed(1) + 'R');
  const exp = State.tradeCount ? (State.wins / State.tradeCount * 2 - State.losses / State.tradeCount).toFixed(2) + 'R' : '—';
  setText('mExp',    exp);
}

function addTradeRow(t) {
  const tbody = el('liveTradeBody');
  if (!tbody) return;
  const row = document.createElement('tr');
  row.innerHTML = `
    <td>${t.n}</td>
    <td><span class="badge ${t.dir === 'LONG' ? 'badge-long' : 'badge-short'}" style="font-size:9px">${t.dir === 'LONG' ? '↑ L' : '↓ S'}</span></td>
    <td>${fmtPrice(t.entry)}</td>
    <td>${fmtPrice(t.exit)}</td>
    <td class="${t.won ? 'win' : 'loss'}">${t.rMult > 0 ? '+' : ''}${t.rMult.toFixed(1)}R</td>
    <td class="${t.won ? 'win' : 'loss'}">${t.won ? 'WIN' : 'LOSS'}</td>
    <td>${t.score}/8</td>
    <td class="${t.won ? 'win' : 'loss'}">${t.won ? '+' : '-'}₹${Math.abs(t.dPnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
    <td style="color:var(--text3)">${t.ts}</td>`;
  tbody.insertBefore(row, tbody.firstChild);
  if (tbody.rows.length > 30) tbody.deleteRow(tbody.rows.length - 1);
  setText('liveLogCount', State.tradeCount + ' trades');
}

let liveEqChart;
function initEqChart() {
  if (!window.Chart) return;
  const ctx = el('liveEqChart');
  if (!ctx) return;
  liveEqChart = new Chart(ctx, {
    type: 'line',
    data: { labels: ['0'], datasets: [{ data: [0], borderColor: '#7F77DD', borderWidth: 1.5, pointRadius: 1.5, pointBackgroundColor: '#7F77DD', tension: 0.35, fill: true, backgroundColor: 'rgba(127,119,221,0.08)' }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { position: 'right', ticks: { color: '#565d6a', font: { size: 10 }, callback: v => v.toFixed(1) + 'R' }, grid: { color: 'rgba(255,255,255,0.04)' } } } }
  });
}
function updateEquityCurve() {
  if (!liveEqChart) return;
  liveEqChart.data.labels.push(State.tradeCount);
  liveEqChart.data.datasets[0].data.push(State.pnl);
  if (liveEqChart.data.labels.length > 80) { liveEqChart.data.labels.shift(); liveEqChart.data.datasets[0].data.shift(); }
  liveEqChart.update('none');
}

function liveChartBarIndex() {
  return State.currentCandle ? State.candles.length : Math.max(0, State.candles.length - 1);
}

function syncLiveTradeMarkers() {
  if (!CandleChart) return;
  CandleChart.setTradeMarkers(State.allTrades.map((t, i) => ({
    entryBar: t.entryBar,
    exitBar:  t.exitBar,
    dir:      t.dir,
    entry:    t.entry,
    exit:     t.exit,
    result:   t.won ? 'WIN' : 'LOSS',
    tradeIdx: i
  })));
}

function syncLiveTradeMarkers() {
  if (!CandleChart) return;
  CandleChart.setTradeMarkers(State.allTrades.map((t, i) => ({
    entryBar: t.entryBar,
    exitBar:  t.exitBar,
    dir:      t.dir,
    entry:    t.entry,
    exit:     t.exit,
    result:   t.won ? 'WIN' : 'LOSS',
    tradeIdx: i
  })));
}

let backtestEqChart;
function initBacktestEqChart() {
  if (!window.Chart) return;
  const ctx = el('backtestEqChart');
  if (!ctx) return;
  backtestEqChart = new Chart(ctx, {
    type: 'line',
    data: { labels: ['0'], datasets: [{ data: [0], borderColor: '#7F77DD', borderWidth: 1.5, pointRadius: 1.5, pointBackgroundColor: '#7F77DD', tension: 0.35, fill: true, backgroundColor: 'rgba(127,119,221,0.08)' }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { position: 'right', ticks: { color: '#565d6a', font: { size: 10 }, callback: v => v.toFixed(1) + 'R' }, grid: { color: 'rgba(255,255,255,0.04)' } } } }
  });
}

// Renders the backtest/optimizer trade list as a cumulative R equity curve
// (independent of the live session's equity curve — this is purely derived
// from the trade array each time, not an incrementally-updated running total).
function renderBacktestEquityCurve(trades) {
  if (!backtestEqChart) return;
  const useCash = trades.some(t => t.cashPnl != null);
  let cum = 0;
  const labels = ['0'];
  const data = [0];
  trades.forEach((t, i) => {
    cum += useCash ? (Number(t.cashPnl) || 0) : (Number(t.rMultiple) || 0);
    labels.push(String(i + 1));
    data.push(+cum.toFixed(2));
  });
  backtestEqChart.data.labels = labels;
  backtestEqChart.data.datasets[0].data = data;
  backtestEqChart.options.scales.y.ticks.callback = v => useCash ? '₹' + Number(v).toLocaleString('en-IN') : v.toFixed(1) + 'R';
  backtestEqChart.update('none');
}

// ── Market clock ──────────────────────────────────────────────────────
function updateMarketClock() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const h = ist.getHours(), m = ist.getMinutes(), s = ist.getSeconds();
  const timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')} IST`;
  const mins = h * 60 + m;
  const day  = ist.getDay();
  let statusCls = 'mkt-closed', statusStr = 'Closed';
  if (day >= 1 && day <= 5) {
    if (mins >= 495 && mins < 555)       { statusCls = 'mkt-pre';    statusStr = 'Pre-open'; }
    else if (mins >= 555 && mins < 930)  { statusCls = 'mkt-open';   statusStr = 'NSE Open'; }
    else if (mins >= 930 && mins < 960)  { statusCls = 'mkt-closed'; statusStr = 'Post-close'; }
  }
  const clockEl = el('mktClock');
  if (clockEl) clockEl.innerHTML = `<span class="${statusCls}">${statusStr}</span> · ${timeStr}`;
}

function refreshTopBarFromHover() {
  const ind = Indicators.snapshot(State.prices);
  updateTopBarFromState(ind);
}

// ── Securities search dropdown ────────────────────────────────────────
let allSecurities = [];

async function loadSecurities() {
  const searchEl = el('symSearch');
  if (searchEl) { searchEl.placeholder = 'Loading symbols…'; searchEl.disabled = true; }

  try {
    // Load ALL exchanges so switching the filter works without a new fetch
    const res  = await fetch(`${window.CLAUDE_BASE}/api/securities?limit=10000`);
    const data = await res.json();
    allSecurities = data.items || [];
    console.log(`[Securities] Loaded ${allSecurities.length} instruments`);
    populateExchangeFilter();
  } catch (e) {
    console.warn('[Securities] Server unreachable — is npm start running?', e.message);
    allSecurities = [];
  }

  if (searchEl) {
    searchEl.disabled     = false;
    searchEl.placeholder  = allSecurities.length
      ? `Search ${allSecurities.length.toLocaleString()} symbols…`
      : 'Search symbol or name…';
  }
}

function populateExchangeFilter() {
  const exchSel = el('exchFilter');
  if (!exchSel) return;
  // Clear all existing options then rebuild from actual data
  exchSel.innerHTML = '<option value="ALL">All exchanges</option>';
  const exchanges = [...new Set(allSecurities.map(s => s.exchange))].sort();
  exchanges.forEach(ex => {
    const opt = document.createElement('option');
    opt.value = ex; opt.textContent = ex;
    // Default to NSE_EQ
    if (ex === 'NSE_EQ') opt.selected = true;
    exchSel.appendChild(opt);
  });
}

function filterSecurities(q, exchange) {
  let list = allSecurities;
  // Apply exchange filter
  if (exchange && exchange !== 'ALL') list = list.filter(s => s.exchange === exchange);
  // No query → show first 120 alphabetically (lets user browse on focus)
  if (!q || !q.trim()) return list.slice(0, 120);
  const lq = q.trim().toLowerCase();
  // Exact starts-with first, then name contains
  const exact = list.filter(s => s.symbol.toLowerCase().startsWith(lq));
  const fuzzy = list.filter(s => !s.symbol.toLowerCase().startsWith(lq) &&
                                  (s.name || '').toLowerCase().includes(lq));
  return [...exact, ...fuzzy].slice(0, 100);
}

function renderDropdown(items) {
  const dd = el('symbolDropdown');
  if (!dd) return;
  dd.innerHTML = '';

  if (!items.length) {
    dd.innerHTML = '<div style="padding:10px 12px;font-size:11px;color:var(--text3)">No matches found</div>';
    dd.style.display = 'block';
    return;
  }

  // Count label
  const count = document.createElement('div');
  count.style.cssText = 'padding:5px 10px;font-size:9px;color:var(--text3);border-bottom:1px solid var(--border);letter-spacing:.04em;text-transform:uppercase';
  count.textContent = items.length + ' symbols';
  dd.appendChild(count);

  items.forEach(s => {
    const d = document.createElement('div');
    d.className = 'sym-item';
    d.innerHTML = `
      <div>
        <div class="sym-name">${s.symbol}</div>
        <div class="sym-full">${s.name || ''}</div>
      </div>
      <div style="text-align:right">
        <div class="sym-exch">${s.exchange}</div>
        ${s.sector ? `<div class="sym-sector">${s.sector}</div>` : ''}
      </div>`;
    d.addEventListener('mousedown', e => {
      e.preventDefault();   // prevent blur firing before click
      selectSecurity(s);
    });
    dd.appendChild(d);
  });
  dd.style.display = 'block';
}

async function selectSecurity(s) {
  State.selectedSec = s;
  el('symSearch').value          = s.symbol;
  el('selectedSecId').value      = s.secId;
  el('selectedSecId').textContent = s.secId;   // visible text — .value alone doesn't render on a <span>
  el('selectedExch').value       = s.exchange;
  el('selectedName').textContent = s.name || s.symbol;
  el('topSym').textContent       = formatTopSymLabel('SIMULATION');
  el('symbolDropdown').style.display = 'none';
  const exchSel = el('exchFilter');
  if (exchSel) exchSel.value = s.exchange;

  el('btnAddToWatchlist').disabled = false;
  el('btnAddToWatchlist').title = '';

  resetForNewSymbol();
  await seedSimulationForSelectedSymbol();
  // Chart will populate once "Run Backtest" (Step 1) pulls history from Dhan —
  // see runBacktest() -> loadHistoryForChart(). Live ticks also draw on top
  // once Connect is active, since processPrice() always appends to State.candles.
}

function resetForNewSymbol() {
  // Stop any active trade/signal state
  State.activeTrade    = null;
  State.signalCooldown = 0;
  State.lastDir        = null;

  // Clear price/candle buffers
  State.prices         = [];
  State.candles        = [];
  State.currentCandle  = null;
  State.ticksInCandle  = 0;
  State.vwapState      = { sum: 0, vol: 0, price: 0 };

  // Exit backtest review mode — new symbol means old backtest chart no longer applies
  State.chartMode          = 'live';
  State.backtestCandles    = [];
  State.backtestTrades     = [];
  State.highlightedTradeIdx = -1;

  // Clear session trading stats
  State.tradeCount  = 0;
  State.wins        = 0;
  State.losses      = 0;
  State.pnl         = 0;
  State.peakPnl     = 0;
  State.maxDD       = 0;
  State.allTrades   = [];

  // Load this symbol's saved config if one was previously tuned and applied —
  // otherwise falls back to null (= default 2:1 live engine behavior).
  // This is what makes optimizer tuning persist per-stock across switches.
  applySymbolConfigForSelected();

  // If currently connected live, update the badge to reflect the NEW symbol
  // (previously this stayed stuck on whichever symbol was connected first)
  if (State.isLive && State.selectedSec) {
    setConnStatus('live', 'LIVE · ' + State.selectedSec.symbol);
  }

  // Reset backtest/optimizer panel
  lastOptimization = null;
  el('optimizerCard').style.display = 'none';
  setText('btTotal', '—');
  setText('btWinRate', '—');
  setText('btExpectancy', '—');
  setText('btSymbolLabel', State.selectedSec ? State.selectedSec.symbol : 'the selected stock');
  setBtStatus('Symbol changed — run a new backtest for this stock.');
  const optBtn = el('btnRunOptimize');
  if (optBtn) { optBtn.disabled = true; optBtn.title = 'Run a backtest first'; }

  // Reset UI badges/metrics
  setBadge('sbadge', 'SCANNING', 'badge-wait');
  setText('sigStr', 'Waiting for setup');
  setText('sEntry', '—'); setText('sSL', '—'); setText('sTP', '—');
  updateMetrics();

  // Clear LIVE trade log table + equity chart
  const liveTbody = el('liveTradeBody');
  if (liveTbody) liveTbody.innerHTML = '';
  setText('liveLogCount', '0 trades');
  if (liveEqChart) {
    liveEqChart.data.labels = ['0'];
    liveEqChart.data.datasets[0].data = [0];
    liveEqChart.update('none');
  }
  syncLiveTradeMarkers();

  // Clear BACKTEST trade log table + equity chart — a backtest from the
  // previous symbol no longer applies once you've switched stocks
  const backtestTbody = el('backtestTradeBody');
  if (backtestTbody) backtestTbody.innerHTML = '';
  setText('backtestLogCount', '0 trades');
  if (backtestEqChart) {
    backtestEqChart.data.labels = ['0'];
    backtestEqChart.data.datasets[0].data = [0];
    backtestEqChart.update('none');
  }
  updateBacktestScrubberUI();
  setText('backtestRangeText', 'No backtest run yet — set a date range on the right and click Run Backtest.');
  el('btnExportBaseline').style.display = 'none';
  el('btnExportOptimized').style.display = 'none';

  // Clear candlestick chart immediately so old symbol's candles don't linger
  CandleChart.update([], null, []);
  CandleChart.setTradeMarkers([]);
  el('chartMarkerLegend').style.display = 'none';
}

// ── Pull historical candles for the chart (uses backtest date range) ──────
function buildChartCandles(candles) {
  const closes = (candles || []).map(c => c.c);
  return (candles || []).map((c, i) => {
    const slice = closes.slice(0, i + 1);
    const e9  = Indicators.ema(slice, 9);
    const e21 = Indicators.ema(slice, 21);
    const bb  = Indicators.calcBB(slice);
    return { ...c, ema9: e9, ema21: e21, bbu: bb.upper, bbl: bb.lower };
  });
}

function seedLiveBuffersFromCandles(candles) {
  const chartCandles = buildChartCandles(candles);
  const tail = chartCandles.slice(-200);
  State.candles = tail;
  State.prices = tail.map(c => c.c).filter(Number.isFinite).slice(-300);
  State.currentCandle = null;
  State.ticksInCandle = 0;
  State.vwapState = { sum: 0, vol: 0, price: 0 };
  State.prices.forEach(p => {
    State.vwapState.sum += p * 1000;
    State.vwapState.vol += 1000;
  });
  if (State.vwapState.vol > 0) {
    State.vwapState.price = State.vwapState.sum / State.vwapState.vol;
  }
  const last = tail[tail.length - 1];
  if (last && Number.isFinite(last.c)) State.simPrice = last.c;
  return chartCandles;
}

async function seedSimulationForSelectedSymbol() {
  const sec = State.selectedSec;
  if (!sec || State.isLive) return;
  el('topSym').textContent = formatTopSymLabel('SIMULATION');

  try {
    const res = await fetch(`${window.CLAUDE_BASE}/api/backtest/candles/${sec.secId}`);
    if (!res.ok) {
      setConnStatus('sim', `Simulation · ${sec.symbol} (run backtest to seed price)`);
      refreshTopBarFromHover(null);
      return;
    }
    const data = await res.json();
    const candles = data.candles || [];
    if (!candles.length) {
      setConnStatus('sim', `Simulation · ${sec.symbol} (no cached candles)`);
      refreshTopBarFromHover(null);
      return;
    }
    seedLiveBuffersFromCandles(candles);
    State.chartMode = 'live';
    CandleChart.update(State.candles, null, []);
    setConnStatus('sim', `Simulation · ${sec.symbol} seeded from ${data.source || 'cache'}`);
    refreshTopBarFromHover(null);
  } catch (e) {
    setConnStatus('sim', `Simulation · ${sec.symbol} (cache unavailable)`);
    refreshTopBarFromHover(null);
  }
}

async function loadHistoryForChart(sec, range) {
  if (!sec) return;
  const fromDate  = (range && range.fromDate)  || el('btFrom').value;
  const toDate    = (range && range.toDate)    || el('btTo').value;
  const timeframe = (range && range.timeframe) || el('btTimeframe').value;

  try {
    // Pull from the server's cache of the most recent /api/backtest call —
    // NOT a direct browser→Dhan call, since Dhan's API blocks cross-origin
    // requests from the browser (this is why the proxy server exists).
    const res = await fetch(`${window.CLAUDE_BASE}/api/backtest/candles/${sec.secId}`);
    if (!res.ok) {
      setBtStatus(`Chart history not available yet — run Step 1 (Backtest) first.`);
      return;
    }
    const data = await res.json();
    const candles = data.candles || [];
    if (!candles.length) {
      setBtStatus(`No historical candles cached for ${sec.symbol}.`);
      return;
    }

    const chartCandles = seedLiveBuffersFromCandles(candles);

    // Store as a FROZEN backtest snapshot — completely separate from
    // State.candles (the live rolling buffer), so the live poller running
    // in the background can never overwrite what's being reviewed here.
    State.backtestCandles = chartCandles;
    State.chartMode = 'backtest';

    // CRITICAL: hand the chart the FULL candle array, never pre-sliced.
    // Trade markers (entryBar/exitBar from the backtest API) are indices
    // into this full array. Pre-slicing here (e.g. .slice(-200)) was the
    // root cause of markers silently disappearing — every entryBar/exitBar
    // became nonsense once the array they were computed against got
    // truncated before reaching chart.js, which does its own internal
    // slicing for the visible 80-candle window using the correct offsets.
    CandleChart.update(State.backtestCandles, null, []);
    updateBacktestScrubberUI();

    // Update the backtest range banner so it's clear what's being shown
    const rangeLabel = timeframe === 'D' ? 'daily' : `${timeframe}-min`;
    setText('backtestRangeText', `${sec.symbol} · ${fromDate} → ${toDate} · ${rangeLabel} candles · ${candles.length.toLocaleString()} bars loaded`);
  } catch (e) {
    setBtStatus(`Could not load history: ${e.message}`);
  }
}



// ── Connect / Disconnect ──────────────────────────────────────────────
async function connectDhan() {
  const clientId = el('credClientId').value.trim();
  const token    = el('credToken').value.trim();
  const secId    = el('selectedSecId').value.trim();
  const exchange = el('selectedExch').value.trim();

  if (!clientId || !token)  { setConnStatus('error', 'Enter client ID and access token'); return; }
  if (!secId)               { setConnStatus('error', 'Select a security first'); return; }

  State.credentials = { clientId, token };
  DhanAPI.init(clientId, token, window.CLAUDE_BASE);

  setConnStatus('connecting', 'Connecting to Dhan…');
  try {
    const prices = await DhanAPI.getLTP(exchange, [secId]);
    const p      = prices[secId];
    if (!p || p === 0) throw new Error('Price not found — check security ID');
    State.simPrice = p;
    State.isLive   = true;
    stopSim();
    State.livePollTimer = setInterval(pollLTP, 1000);
    setConnStatus('live', 'LIVE · ' + (State.selectedSec?.symbol || secId));
    el('btnConnect').style.display    = 'none';
    el('btnDisconnect').style.display = 'inline-block';
  } catch (e) {
    setConnStatus('error', e.message.length > 60 ? e.message.slice(0, 60) + '…' : e.message);
  }
}

function disconnectDhan() {
  if (State.livePollTimer) { clearInterval(State.livePollTimer); State.livePollTimer = null; }
  State.isLive   = false;
  State.prices   = [];
  State.candles  = [];
  State.currentCandle = null;
  setConnStatus('sim', State.selectedSec ? `Simulation · ${State.selectedSec.symbol}` : 'Simulation mode');
  el('btnConnect').style.display    = 'inline-block';
  el('btnDisconnect').style.display = 'none';
  seedSimulationForSelectedSymbol();
  startSim();
}

function setConnStatus(type, msg) {
  const statusMap = { live: 'badge-live', sim: 'badge-sim', error: 'badge-err', connecting: 'badge-conn' };
  setBadge('connStatus', msg, statusMap[type] || 'badge-sim');
  setText('connMsg', msg);
}

function formatNseFeedTime(value) {
  if (!value) return 'just now';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
}

function setNseFeedPause(paused) {
  State.nseFeedPaused = !!paused;
  const btn = el('btnToggleNewsFeed');
  if (btn) btn.textContent = paused ? 'Resume' : 'Pause';
  const status = el('nseFeedStatus');
  if (status && paused) status.textContent = 'Feed paused';
}

function renderNseFeedPanel(payload = {}) {
  const items = payload.items || [];
  State.nseFeedItems = items;
  if (payload.lastBuildDate) State.nseFeedLastUpdated = payload.lastBuildDate;

  const status = el('nseFeedStatus');
  const updated = el('nseFeedUpdated');
  if (status) {
    status.textContent = payload.warning
      ? `Live feed online · ${payload.warning}`
      : payload.cached
        ? 'Live feed cached'
        : 'Live feed live';
  }
  if (updated) {
    updated.textContent = payload.lastBuildDate ? `Updated ${formatNseFeedTime(payload.lastBuildDate)}` : '—';
  }

  const wrap = el('nseFeedItems');
  if (!wrap) return;
  if (!items.length) {
    wrap.innerHTML = '<div style="font-size:10px;color:var(--text3);padding:8px 0;text-align:center">No NSE announcements found yet.</div>';
    return;
  }

  wrap.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border);font-size:10px;line-height:1.45';
    const title = item.title || 'NSE announcement';
    const desc = item.description || '';
    const link = item.link || '#';
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <a href="${link}" target="_blank" rel="noopener noreferrer" style="color:var(--text);text-decoration:none;font-weight:600;flex:1">${title}</a>
        <a href="${link}" target="_blank" rel="noopener noreferrer" style="font-size:9px;color:var(--blue);white-space:nowrap">Open</a>
      </div>
      <div style="color:var(--text3);margin-top:3px">${desc}</div>
      <div style="color:var(--text3);font-size:9px;margin-top:3px">${formatNseFeedTime(item.pubDate)}</div>`;
    wrap.appendChild(row);
  });
}

async function pollNseFeed() {
  const nfOn = document.getElementById('newsFilter')?.value === '1';
  if (!nfOn || State.nseFeedPaused || State.nseFeedLoading) return;
  State.nseFeedLoading = true;
  try {
    const res = await fetch(`${window.CLAUDE_BASE}/api/news-feed?limit=8&refreshMs=30000`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load NSE feed');

    renderNseFeedPanel(data);

    const latest = (data.items || [])[0];
    if (latest && latest.guid && latest.guid !== State.nseFeedLastGuid) {
      State.nseFeedLastGuid = latest.guid;
      State.newsBlocked = true;
      State.newsTimer = 18;
      setText('ntext', `NSE: ${latest.title}`);
    }

    if (data.warning) console.warn('[NSE Feed]', data.warning);
  } catch (e) {
    const wrap = el('nseFeedItems');
    if (wrap && !State.nseFeedItems.length) {
      wrap.innerHTML = `<div style="font-size:10px;color:var(--text3);padding:8px 0;text-align:center">Could not load NSE feed: ${e.message}</div>`;
    }
    const status = el('nseFeedStatus');
    if (status) status.textContent = 'Feed error';
  } finally {
    State.nseFeedLoading = false;
  }
}

function refreshNseFeedImmediate() {
  pollNseFeed();
}

function formatTopSymLabel(modeLabel) {
  if (!State.selectedSec) return modeLabel || 'SIMULATION';
  const exchLabel = State.selectedSec.exchange === 'NSE_EQ' ? 'NSE' : State.selectedSec.exchange;
  return `${modeLabel || 'SIMULATION'} · ${exchLabel}: ${State.selectedSec.symbol}`;
}

// ── Watchlist ─────────────────────────────────────────────────────────
let watchlist = [];

async function loadWatchlist() {
  try {
    const res  = await fetch(`${window.CLAUDE_BASE}/api/watchlist`);
    const data = await res.json();
    watchlist = data.watchlist || [];
  } catch (e) {
    console.warn('[Watchlist] Could not load:', e.message);
    watchlist = [];
  }
  renderWatchlist();
}

async function addToWatchlist() {
  if (!State.selectedSec) return;
  const { secId, symbol, name, exchange } = State.selectedSec;
  try {
    const res  = await fetch(`${window.CLAUDE_BASE}/api/watchlist`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secId, symbol, name, exchange })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add');
    watchlist = data.watchlist || watchlist;
    renderWatchlist();
    showToast(data.note ? `${symbol} is already in your watchlist.` : `✓ Added ${symbol} to watchlist (${watchlist.length} total).`);
  } catch (e) {
    showToast('Could not add to watchlist: ' + e.message, true);
  }
}

async function removeFromWatchlist(secId) {
  try {
    const res  = await fetch(`${window.CLAUDE_BASE}/api/watchlist/${secId}`, { method: 'DELETE' });
    const data = await res.json();
    watchlist = data.watchlist || [];
    renderWatchlist();
  } catch (e) {
    console.warn('[Watchlist] Remove failed:', e.message);
  }
}

function renderWatchlist() {
  setText('watchlistCount', `${watchlist.length} symbol${watchlist.length === 1 ? '' : 's'}`);
  const wrap = el('watchlistItems');
  if (!watchlist.length) {
    wrap.innerHTML = '<div style="font-size:10px;color:var(--text3);padding:8px 0;text-align:center">No symbols yet — use "+ Add to watchlist" above</div>';
  } else {
    wrap.innerHTML = '';
    watchlist.forEach(s => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;cursor:pointer';
      row.title = `Load ${s.symbol} into the live chart`;
      const hasConfig = State.symbolConfigs[s.secId];
      const tunedTag = hasConfig
        ? `<span style="color:var(--green);font-size:9px;margin-left:5px">✓ ${(hasConfig.tpMultiplier/hasConfig.slMultiplier).toFixed(1)}:1</span>`
        : '';
      row.innerHTML = `
        <span>${s.symbol}${tunedTag}</span>
        <button class="btn-icon" style="padding:2px 6px;font-size:10px;border:none;background:transparent;color:var(--text3);cursor:pointer" title="Remove from watchlist">✕</button>`;
      row.querySelector('button').addEventListener('click', () => removeFromWatchlist(s.secId));
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectSecurity(s);
      });
      wrap.appendChild(row);
    });
  }
  const startBtn = el('btnStartBatch');
  if (startBtn) {
    startBtn.disabled = watchlist.length === 0;
    startBtn.title = watchlist.length === 0 ? 'Add symbols to the watchlist first' : '';
  }
}

// ── Batch backtest + optimize ────────────────────────────────────────
let batchPollTimer = null;

async function startBatch() {
  if (!State.credentials.clientId) { alert('Connect to Dhan first.'); return; }
  if (!watchlist.length)           { alert('Add at least one symbol to the watchlist.'); return; }
  const batchFromEl = el('batchFrom');
  const batchToEl = el('batchTo');
  const batchTimeframeEl = el('batchTimeframe');
  const batchTargetRREl = el('batchTargetRR');
  if (!batchFromEl || !batchToEl || !batchTimeframeEl || !batchTargetRREl) return;

  const fromDate  = batchFromEl.value;
  const toDate    = batchToEl.value;
  const timeframe = batchTimeframeEl.value;
  const targetRR  = parseFloat(batchTargetRREl.value) || 3.0;

  try {
    const res = await fetch(`${window.CLAUDE_BASE}/api/batch/start`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        clientId: State.credentials.clientId,
        token:    State.credentials.token,
        symbols:  watchlist,
        fromDate, toDate, timeframe, targetRR,
        positionSizing: getPositionSizingPayload(),
        autoApply: true   // per your earlier choice: auto-apply best config for every stock
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start batch');

    const startBtn = el('btnStartBatch');
    const cancelBtn = el('btnCancelBatch');
    const progressWrap = el('batchProgressWrap');
    const resultsWrap = el('batchResultsWrap');
    if (startBtn) startBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    if (progressWrap) progressWrap.style.display = 'block';
    if (resultsWrap) resultsWrap.style.display = 'none';

    batchPollTimer = setInterval(pollBatchStatus, 1000);
    pollBatchStatus();
  } catch (e) {
    alert('Could not start batch: ' + e.message);
  }
}

async function cancelBatch() {
  try {
    await fetch(`${window.CLAUDE_BASE}/api/batch/cancel`, { method: 'POST' });
  } catch (e) { /* ignore */ }
}

async function pollBatchStatus() {
  try {
    const res  = await fetch(`${window.CLAUDE_BASE}/api/batch/status`);
    const data = await res.json();
    renderBatchProgress(data);

    if (!data.running) {
      clearInterval(batchPollTimer);
      batchPollTimer = null;
      const startBtn = el('btnStartBatch');
      const cancelBtn = el('btnCancelBatch');
      if (startBtn) startBtn.style.display = 'inline-block';
      if (cancelBtn) cancelBtn.style.display = 'none';
      // Re-sync symbolConfigs from server since the batch run may have
      // auto-applied new configs for several stocks at once.
      await loadSymbolConfigsFromStorage();
      renderWatchlist();
      renderBatchResults(data);
    }
  } catch (e) {
    console.warn('[Batch] Poll error:', e.message);
  }
}

function renderBatchProgress(data) {
  if (!el('batchProgressCount') && !el('batchProgressLabel') && !el('batchProgressBar')) return;
  const pct = data.total ? Math.round((data.completed / data.total) * 100) : 0;
  const progressBar = el('batchProgressBar');
  if (progressBar) progressBar.style.width = pct + '%';
  setText('batchProgressCount', `${data.completed} / ${data.total}`);
  setText('batchProgressLabel', data.running
    ? `Processing ${data.currentSymbol || '…'}…`
    : '✓ Batch complete');
}

function renderBatchResults(data) {
  const wrap = el('batchResultsWrap');
  const tbody = el('batchResultsBody');
  if (!wrap || !tbody) return;
  wrap.style.display = 'block';
  tbody.innerHTML = '';
  data.results.forEach(r => {
    const row = document.createElement('tr');
    if (r.status === 'done') {
      const o = r.optimized;
      const rr = o ? (o.avgWinR / Math.abs(o.avgLossR || 1)).toFixed(1) : '—';
      row.innerHTML = `
        <td>${r.symbol}</td>
        <td><span class="win">✓ ${r.applied ? 'applied' : 'done'}</span></td>
        <td>${o ? o.winRate + '%' : '—'}</td>
        <td>${o ? o.expectancy + 'R' : '—'}</td>
        <td>${rr}:1</td>`;
    } else if (r.status === 'skipped') {
      row.innerHTML = `<td>${r.symbol}</td><td style="color:var(--text3)">skipped</td><td>—</td><td>—</td><td>—</td>`;
    } else {
      row.innerHTML = `<td>${r.symbol}</td><td class="loss">error</td><td colspan="3" style="color:var(--text3);font-size:9px">${r.error || 'unknown'}</td>`;
    }
    tbody.appendChild(row);
  });
}

// ── Backtest + Optimizer feedback loop (two explicit steps) ─────────────
let lastOptimization  = null;
let lastBacktestRange = null;   // { fromDate, toDate, timeframe } — reused by step 2

function getPositionSizingPayload() {
  return {
    acctSize:   parseFloat(el('acctSize').value)   || 100000,
    maxRiskPct: parseFloat(el('maxRiskPct').value) || 1,
    kellyFrac:  parseFloat(el('kellyFrac').value)  || 0.5
  };
}

function getTradingCostPayload() {
  return { includeTradingCost: !!el('chkIncludeTradingCost')?.checked };
}

async function runBacktest() {
  if (!State.credentials.clientId) { alert('Connect to Dhan first to run backtest'); return; }
  if (!State.selectedSec)          { alert('Select a security first'); return; }

  const fromDate  = el('btFrom').value;
  const toDate    = el('btTo').value;
  const timeframe = el('btTimeframe').value;
  lastBacktestRange = { fromDate, toDate, timeframe };
  const includeTradingCost = !!el('chkIncludeTradingCost')?.checked;

  el('optimizerCard').style.display = 'none';
  el('btnExportBaseline').style.display = 'none';
  el('btnExportOptimized').style.display = 'none';
  el('btnRunOptimize').disabled = true;
  el('btnRunBacktest').disabled = true;
  el('btnRunBacktest').textContent = '⏳ Running…';

  const tfLabel = timeframe === 'D' ? 'daily' : `${timeframe}-min`;
  setBtStatus(`Fetching ${State.selectedSec.symbol} ${tfLabel} candles, ${fromDate} → ${toDate}…${includeTradingCost ? ' Exchange charges on.' : ''}`);

  try {
    const res = await fetch(`${window.CLAUDE_BASE}/api/backtest`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        clientId:     State.credentials.clientId,
        token:        State.credentials.token,
        securityId:   State.selectedSec.secId,
        exchange:     State.selectedSec.exchange,
        symbol:       State.selectedSec.symbol,
        positionSizing: getPositionSizingPayload(),
        ...getTradingCostPayload(),
        fromDate, toDate, timeframe,
        autoOptimize: false   // Step 1 only — baseline, no search yet
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Backtest failed');

    if (data.warning) {
      setBtStatus(`⚠ ${data.warning}`);
    } else {
      renderBaseline(data);
      setBtStatus(`✓ Step 1 done — ${data.candles.toLocaleString()} ${tfLabel} candles (${fromDate} → ${toDate}) · ${data.trades} trades at your current 2:1 settings. Click "Run Optimizer" to search for a better config.`);
      el('btnRunOptimize').disabled = false;
      el('btnRunOptimize').title = '';
    }

    // Refresh the chart to show this exact backtest range/timeframe
    await loadHistoryForChart(State.selectedSec, { fromDate, toDate, timeframe });
  } catch (e) {
    setBtStatus('Error: ' + e.message);
  } finally {
    el('btnRunBacktest').disabled = false;
    el('btnRunBacktest').textContent = '▶ 1. Run Backtest';
  }
}

async function runOptimizeStep() {
  if (!lastBacktestRange) { alert('Run a backtest first (Step 1).'); return; }
  if (!State.selectedSec) { alert('Select a security first'); return; }

  const targetRR = parseFloat(el('targetRR').value) || 3.0;
  const includeTradingCost = !!el('chkIncludeTradingCost')?.checked;
  el('btnRunOptimize').disabled = true;
  el('btnRunOptimize').textContent = '⏳ Searching…';
  setBtStatus(`Searching for the best ${targetRR}:1 config…${includeTradingCost ? ' Exchange charges on.' : ''}`);

  try {
    const res = await fetch(`${window.CLAUDE_BASE}/api/optimize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        securityId: State.selectedSec.secId,
        symbol:     State.selectedSec.symbol,
        positionSizing: getPositionSizingPayload(),
        timeframe: lastBacktestRange.timeframe,
        ...getTradingCostPayload(),
        targetRR,
        minTrades: 10
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Optimize failed');

    renderOptimization({
      targetRR,
      searchTimeMs:   data.searchTimeMs,
      combosSearched: data.searched,
      qualified:      data.qualified,
      baseline:       JSON.parse(el('btTotal').dataset.summary || '{}'),
      best:           data.best,
      leaderboard:    data.leaderboard
    }, targetRR);

    setBtStatus(`✓ Step 2 done — searched ${data.searched.toLocaleString()} configs in ${data.searchTimeMs}ms.`);
  } catch (e) {
    setBtStatus('Error: ' + e.message);
  } finally {
    el('btnRunOptimize').disabled = false;
    el('btnRunOptimize').textContent = '⚙ 2. Run Optimizer';
  }
}

function renderBaseline(data) {
  const s = data.summary;
  setText('btTotal',      s.total || 0);
  setText('btWinRate',    (s.winRate ?? 0) + '%');
  setText('btExpectancy', (s.expectancy ?? 0) + 'R');
  el('btTotal').dataset.summary = JSON.stringify(s);

  if (data.tradeList && data.tradeList.length) {
    renderBacktestTradeLog(data.tradeList, 'Backtest (2:1 baseline)');
    const exportLink = el('btnExportBaseline');
    if (exportLink && State.selectedSec) {
      exportLink.href = `${window.CLAUDE_BASE}/api/backtest/export/${State.selectedSec.secId}`;
      exportLink.style.display = 'flex';
    }
  }
}

// Renders backtest/optimizer trades into the dedicated BACKTEST Trade Log
// table (separate from the LIVE trade log — addTradeRow — which only fires
// from the running signal engine) and plots entry/exit markers on the chart.
// Clicking a row highlights that specific trade's markers on the chart.
function renderBacktestTradeLog(trades, sourceLabel) {
  const tbody = el('backtestTradeBody');
  if (!tbody) { console.error('[Backtest] #backtestTradeBody not found in DOM — check index.html / browser cache (hard-refresh with Ctrl+Shift+R)'); return; }
  tbody.innerHTML = '';

  State.backtestTrades = trades;
  State.highlightedTradeIdx = -1;

  // Most recent first. Each row is wrapped in try/catch so one malformed
  // trade can't silently zero out the whole table — any failure is logged
  // to the console instead of failing invisibly.
  const ordered = [...trades].reverse();
  let rendered = 0;
  ordered.forEach((t, idx) => {
    try {
      const tradeIdx = trades.length - 1 - idx;
      const n = trades.length - idx;
      const row = document.createElement('tr');
      row.dataset.tradeIdx = tradeIdx;
      row.style.cursor = 'pointer';
      row.title = 'Click to highlight this trade on the chart';
      const timeLabel = t.entryTs ? formatBacktestTs(t.entryTs) : `#${n}`;
      const rMult = Number(t.rMultiple) || 0;
      const cashPnl = Number(t.cashPnl) || 0;
      row.innerHTML = `
        <td>${n}</td>
        <td><span class="badge ${t.dir === 'LONG' ? 'badge-long' : 'badge-short'}" style="font-size:9px">${t.dir === 'LONG' ? '↑ L' : '↓ S'}</span></td>
        <td>${fmtPrice(t.entry)}</td>
        <td>${fmtPrice(t.exit)}</td>
        <td class="${t.result === 'WIN' ? 'win' : 'loss'}">${rMult > 0 ? '+' : ''}${rMult.toFixed(1)}R</td>
        <td class="${t.result === 'WIN' ? 'win' : 'loss'}">${t.result}</td>
        <td>${t.score}/8</td>
        <td class="${cashPnl >= 0 ? 'win' : 'loss'}">${(cashPnl >= 0 ? '+' : '') + '₹' + Math.round(cashPnl).toLocaleString('en-IN')}</td>
        <td style="color:var(--text3)">${timeLabel}</td>`;
      row.addEventListener('click', () => highlightTrade(tradeIdx));
      tbody.appendChild(row);
      rendered++;
    } catch (e) {
      console.error('[Backtest] Failed to render trade row', idx, t, e);
    }
  });

  setText('backtestLogCount', `${rendered} trades`);
  setText('backtestLogSource', sourceLabel);
  setText('backtestEqSource', sourceLabel);

  try {
    CandleChart.setTradeMarkers(trades.map((t, i) => ({
      entryBar: t.entryBar, exitBar: t.exitBar,
      dir: t.dir, entry: t.entry, exit: t.exit, result: t.result,
      tradeIdx: i
    })));
    el('chartMarkerLegend').style.display = 'flex';
  } catch (e) {
    console.error('[Backtest] Failed to set chart markers', e);
  }

  // Drive the top metrics row from this trade set too, so "Session P&L",
  // "Win rate", "Avg R:R" etc. reflect the backtest result instead of
  // staying blank (those previously only updated from the live engine).
  try {
    renderBacktestTopMetrics(trades);
  } catch (e) {
    console.error('[Backtest] Failed to update top metrics', e);
  }

  try {
    renderBacktestEquityCurve(trades);
  } catch (e) {
    console.error('[Backtest] Failed to render equity curve', e);
  }
}

// Populates the top metrics row (Session P&L, Win rate, Avg R:R, Trades,
// Max drawdown, Expectancy) from a backtest/optimizer trade list. In LIVE
// mode this row is driven by updateMetrics() instead — this function is
// only called while reviewing backtest/optimizer results.
function renderBacktestTopMetrics(trades) {
  const total = trades.length;
  if (!total) {
    setText('mPnl', '₹0'); setText('mWr', '—'); setText('mRR', '2.0:1');
    setText('mTrades', '0'); setText('mDD', '0.0R'); setText('mExp', '—');
    return;
  }
  const wins = trades.filter(t => t.result === 'WIN').length;
  const winRate = (wins / total) * 100;
  const pnlR = trades.reduce((s, t) => s + (Number(t.rMultiple) || 0), 0);
  const expectancy = pnlR / total;

  let peak = 0, cum = 0, maxDD = 0;
  trades.forEach(t => {
    cum += Number(t.rMultiple) || 0;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  });

  const avgWinR  = wins ? trades.filter(t => t.result === 'WIN').reduce((s, t) => s + (Number(t.rMultiple) || 0), 0) / wins : 0;
  const hasCash = trades.some(t => t.cashPnl != null);
  const cashPnl = trades.reduce((s, t) => s + (Number(t.cashPnl) || 0), 0);
  const cashExpectancy = hasCash ? cashPnl / total : null;
  let cashPeak = 0, cashCum = 0, cashMaxDD = 0;
  trades.forEach(t => {
    cashCum += Number(t.cashPnl) || 0;
    if (cashCum > cashPeak) cashPeak = cashCum;
    const dd = cashPeak - cashCum;
    if (dd > cashMaxDD) cashMaxDD = dd;
  });

  setText('mPnl',    hasCash ? ((cashPnl >= 0 ? '+' : '') + '₹' + Math.round(cashPnl).toLocaleString('en-IN')) : ((pnlR >= 0 ? '+' : '') + pnlR.toFixed(2) + 'R'));
  el('mPnl').className = 'metric-value ' + ((hasCash ? cashPnl : pnlR) >= 0 ? 'up' : 'dn');
  setText('mWr',      winRate.toFixed(1) + '%');
  setText('mRR',      avgWinR > 0 ? avgWinR.toFixed(1) + ':1' : '2.0:1');
  setText('mTrades',  total);
  setText('mDD',      hasCash ? '₹' + Math.round(cashMaxDD).toLocaleString('en-IN') : maxDD.toFixed(1) + 'R');
  setText('mExp',     hasCash ? '₹' + Math.round(cashExpectancy || 0).toLocaleString('en-IN') : expectancy.toFixed(2) + 'R');
}

// Highlights one specific trade's markers on the chart (called by clicking a
// trade-log row) and visually marks that row as selected. Clicking the same
// row again clears the highlight.
function highlightTrade(tradeIdx) {
  const tbody = el('backtestTradeBody');
  const alreadySelected = State.highlightedTradeIdx === tradeIdx;
  State.highlightedTradeIdx = alreadySelected ? -1 : tradeIdx;

  // Update row styling
  [...tbody.rows].forEach(row => {
    const isSelected = !alreadySelected && parseInt(row.dataset.tradeIdx, 10) === tradeIdx;
    row.style.background = isSelected ? 'var(--bg4)' : '';
    row.style.outline    = isSelected ? '1px solid var(--blue)' : 'none';
  });

  CandleChart.setHighlightedTrade(alreadySelected ? -1 : tradeIdx);

  // If the trade isn't in the currently visible 80-candle window, jump the
  // chart's visible slice so it scrolls into view.
  if (!alreadySelected) {
    const trade = State.backtestTrades[tradeIdx];
    if (trade) CandleChart.scrollToBar(trade.entryBar);
  }
}

function formatBacktestTs(ts) {
  if (!ts) return '—';
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d  = new Date(ms);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderOptimization(opt, targetRR) {
  if (!opt.best) {
    setBtStatus(`Optimizer found no config with enough trades at ${targetRR}:1 — try a wider date range.`);
    return;
  }
  lastOptimization = opt;

  const card = el('optimizerCard');
  card.style.display = 'block';

  setText('optTargetRRLabel', targetRR.toFixed(0) + ':1');
  setText('optComboCount', opt.combosSearched.toLocaleString());
  setText('optSymbolApplyLabel', State.selectedSec ? State.selectedSec.symbol : 'this stock');

  const best = opt.best;
  const scoreText = formatOptimizerScore(best);
  setText('optSearchInfo', `${opt.combosSearched.toLocaleString()} configs · ${opt.searchTimeMs}ms · score ${scoreText}`);
  setText('optTotal',      best.summary.total);
  setText('optWinRate',    best.summary.winRate + '%');
  setText('optExpectancy', best.summary.expectancy + 'R');
  setText('optPF',         best.summary.profitFactor);
  setText('optMaxDD',      best.summary.maxDD + 'R');
  setText('optScore',     scoreText);

  const baseExp = opt.baseline.expectancy || 0;
  const bestExp = best.summary.expectancy || 0;
  const deltaPct = baseExp !== 0 ? (((bestExp - baseExp) / Math.abs(baseExp)) * 100).toFixed(0) : '—';
  const deltaEl = el('optDelta');
  deltaEl.textContent = (bestExp >= baseExp ? '+' : '') + deltaPct + '%';
  deltaEl.className = 'bt-cell-value ' + (bestExp >= baseExp ? 'up' : 'dn');

  // Human-readable config summary
  const c = best.config;
  const thr = c.thresholds || {};
  const params = c.params || {};
  const thrChanges = Object.keys(thr).filter(k => k !== 'minScore')
    .map(k => `${k}: ${thr[k]}`).join(', ') || 'defaults';
  const paramChanges = Object.keys(params).map(k => `${k}: ${params[k]}`).join(', ') || 'defaults';

  el('optConfigDetail').innerHTML = `
    <div><b>Robust score:</b> ${scoreText}</div>
    <div><b>Stop loss:</b> ${c.slMultiplier}× ATR &nbsp; <b>Target:</b> ${c.tpMultiplier}× ATR (= ${(c.tpMultiplier/c.slMultiplier).toFixed(1)}:1)</div>
    <div><b>Min indicators:</b> ${thr.minScore || 6}/8 must agree</div>
    <div><b>Threshold tweaks:</b> ${thrChanges}</div>
    <div><b>Period tweaks:</b> ${paramChanges}</div>`;

  // Leaderboard
  const tbody = el('optLeaderboardBody');
  tbody.innerHTML = '';
  opt.leaderboard.slice(0, 5).forEach(r => {
    const row = document.createElement('tr');
    const rowScore = formatOptimizerScore(r);
    row.innerHTML = `
      <td>${r.config.slMultiplier}</td>
      <td>${r.config.tpMultiplier}</td>
      <td>${r.config.thresholds.minScore}/8</td>
      <td class="up">${r.summary.winRate}%</td>
      <td>${r.summary.expectancy}R</td>
      <td>${r.summary.total}</td>
      <td>${rowScore}</td>`;
    tbody.appendChild(row);
  });

  // Show the OPTIMIZED trade list in the main trade log + chart markers
  // (replaces the baseline trade list, since this is the more relevant view)
  if (best.trades && best.trades.length) {
    renderBacktestTradeLog(best.trades, `Optimizer (${targetRR}:1 best config)`);
    const exportLink = el('btnExportOptimized');
    if (exportLink && State.selectedSec) {
      exportLink.href = `${window.CLAUDE_BASE}/api/optimize/export/${State.selectedSec.secId}`;
      exportLink.style.display = 'flex';
    }
  }
}

function formatOptimizerScore(result) {
  const raw = result?.displayScore ?? result?.robustScore ?? result?.objective;
  return Number.isFinite(raw) ? Number(raw).toFixed(2) : '—';
}

async function applyOptimizedConfig() {
  if (!lastOptimization || !lastOptimization.best) { alert('Run a backtest first.'); return; }
  if (!State.selectedSec) { alert('Select a security first.'); return; }
  const c = lastOptimization.best.config;

  const tunedConfig = {
    slMultiplier: c.slMultiplier,
    tpMultiplier: c.tpMultiplier,
    minScore:     c.thresholds.minScore || 6,
    thresholds:   c.thresholds,
    params:       c.params,
    targetRR:     lastOptimization.targetRR,
    symbol:       State.selectedSec.symbol
  };

  el('btnApplyOptimized').textContent = '⏳ Saving…';
  el('btnApplyOptimized').disabled = true;

  try {
    // Saved on the server (data/symbol-configs.json) keyed by secId — persists
    // per-stock across symbol switches, browser changes, and machine restarts.
    const saved = await saveSymbolConfigToServer(State.selectedSec.secId, tunedConfig);

    // Activate immediately since we're still on this symbol
    State.liveConfig = saved;
    updateLiveConfigBadge();

    setBtStatus(`✓ Saved for ${State.selectedSec.symbol}: SL ${c.slMultiplier}× / TP ${c.tpMultiplier}× ATR, min ${c.thresholds.minScore || 6}/8 indicators. Stored on disk — persists across browsers and restarts.`);
    el('btnApplyOptimized').textContent = '✓ Saved for ' + State.selectedSec.symbol;
    el('btnApplyOptimized').classList.add('active');
    setTimeout(() => {
      el('btnApplyOptimized').textContent = '✓ Apply this config to live engine';
      el('btnApplyOptimized').classList.remove('active');
      el('btnApplyOptimized').disabled = false;
    }, 2500);
  } catch (e) {
    setBtStatus('Error saving config: ' + e.message);
    el('btnApplyOptimized').textContent = '✓ Apply this config to live engine';
    el('btnApplyOptimized').disabled = false;
  }
}

async function resetSymbolConfig() {
  if (!State.selectedSec) return;
  await deleteSymbolConfigFromServer(State.selectedSec.secId);
  State.liveConfig = null;
  updateLiveConfigBadge();
  setBtStatus(`Reset ${State.selectedSec.symbol} to default 2:1 settings.`);
}

function setBtStatus(msg) { setText('btStatus', msg); }

function updateBacktestScrubberUI() {
  const wrap = el('backtestScrubberWrap');
  const slider = el('backtestScrubber');
  const label = el('backtestScrubberLabel');
  if (!wrap || !slider || !label) return;

  const backtestMode = State.chartMode === 'backtest' && State.backtestCandles.length > 0;
  wrap.style.display = backtestMode ? 'block' : 'none';
  if (!backtestMode) return;

  const vp = CandleChart.getViewportState ? CandleChart.getViewportState() : null;
  if (!vp) return;

  slider.max = String(Math.max(0, vp.maxScroll));
  slider.value = String(Math.max(0, vp.scrollOffset || 0));
  const start = vp.start + 1;
  const end = vp.end;
  label.textContent = `${start.toLocaleString('en-IN')} → ${end.toLocaleString('en-IN')} of ${vp.total.toLocaleString('en-IN')}`;
}

function syncBacktestScrubberFromChart() {
  const slider = el('backtestScrubber');
  if (!slider) return;
  const vp = CandleChart.getViewportState ? CandleChart.getViewportState() : null;
  if (!vp) return;
  slider.max = String(Math.max(0, vp.maxScroll));
  slider.value = String(Math.max(0, vp.scrollOffset || 0));
  updateBacktestScrubberUI();
}

// ── CSV Export ────────────────────────────────────────────────────────
function exportCSV() {
  if (!State.allTrades.length) { alert('No trades to export yet.'); return; }
  const h    = '#,Symbol,Dir,Entry,Exit,R,Result,Indicators,₹ P&L,Time\n';
  const rows = State.allTrades.map(t =>
    `${t.n},${State.selectedSec?.symbol || 'SIM'},${t.dir},${t.entry.toFixed(2)},${t.exit.toFixed(2)},${t.rMult.toFixed(1)},${t.won ? 'WIN' : 'LOSS'},${t.score}/8,${t.won ? '+' : '-'}${Math.abs(t.dPnl).toFixed(0)},${t.ts}`
  ).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([h + rows], { type: 'text/csv' }));
  a.download = `trades_${State.selectedSec?.symbol || 'SIM'}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ── Simulation control ────────────────────────────────────────────────
function startSim() {
  if (State.simInterval) return;
  const delay = { '1': 450, '3': 600, '5': 800 };
  State.simInterval = setInterval(simTick, delay[document.getElementById('tfSel')?.value] || 450);
}
function stopSim() { if (State.simInterval) { clearInterval(State.simInterval); State.simInterval = null; } }

// ── Boot ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  CandleChart.init(el('candleChart'), 250);
  CandleChart.setHoverHandler(refreshTopBarFromHover);
  CandleChart.setViewportHandler(updateBacktestScrubberUI);
  const scrubber = el('backtestScrubber');
  if (scrubber) {
    scrubber.addEventListener('input', function () {
      const vp = CandleChart.getViewportState ? CandleChart.getViewportState() : null;
      if (!vp) return;
      CandleChart.scrollToBar((vp.total || 0) - 80 - parseInt(this.value, 10));
    });
  }
  initEqChart();
  initBacktestEqChart();
  updateMarketClock();
  setInterval(updateMarketClock, 1000);
  loadSecurities();
  autoLoadCredentials();
  loadSymbolConfigsFromStorage();
  loadWatchlist();
  refreshNseFeedImmediate();
  setInterval(refreshNseFeedImmediate, 30000);

  // Pre-warm sim
  for (let i = 0; i < 60; i++) {
    const v = State.simPrice * 0.0007;
    State.simPrice = Math.max(State.simPrice * 0.9, Math.min(State.simPrice * 1.1, State.simPrice + rnd(-v, v * 1.1) + rnd(-v * 0.5, v * 0.5)));
    State.prices.push(State.simPrice);
    State.vwapState.sum += State.simPrice * 1000;
    State.vwapState.vol += 1000;
  }
  startSim();

  // Symbol search — show on focus, filter on type, refresh on exchange change
  el('symSearch').addEventListener('focus', function () {
    renderDropdown(filterSecurities(this.value.trim(), el('exchFilter').value));
  });
  el('symSearch').addEventListener('input', function () {
    renderDropdown(filterSecurities(this.value.trim(), el('exchFilter').value));
  });
  el('exchFilter').addEventListener('change', function () {
    const q = el('symSearch').value.trim();
    renderDropdown(filterSecurities(q, this.value));
    el('symSearch').focus();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#symSearchWrap')) el('symbolDropdown').style.display = 'none';
  });

  // Buttons
  el('btnConnect').addEventListener('click', connectDhan);
  el('btnDisconnect').addEventListener('click', disconnectDhan);
  el('btnPause').addEventListener('click', () => {
    State.running = !State.running;
    el('btnPause').textContent = State.running ? '⏸ Pause' : '▶ Resume';
  });
  el('btnExportCSV').addEventListener('click', exportCSV);
  el('btnRunBacktest').addEventListener('click', runBacktest);
  el('btnRunOptimize').addEventListener('click', runOptimizeStep);
  el('btnApplyOptimized').addEventListener('click', applyOptimizedConfig);
  el('btnMaximizeLeft').addEventListener('click', () => togglePanelMaximize('left'));
  el('btnMaximizeCenter').addEventListener('click', () => togglePanelMaximize('center'));
  el('btnMaximizeRight').addEventListener('click', () => togglePanelMaximize('right'));
  el('indicatorsCardHeader').addEventListener('click', toggleIndicatorsPanel);
  el('btnResetConfig').addEventListener('click', resetSymbolConfig);
  el('btnAddToWatchlist').addEventListener('click', addToWatchlist);
  if (el('btnStartBatch')) el('btnStartBatch').addEventListener('click', startBatch);
  if (el('btnCancelBatch')) el('btnCancelBatch').addEventListener('click', cancelBatch);
  if (el('btnToggleNewsFeed')) el('btnToggleNewsFeed').addEventListener('click', () => {
    setNseFeedPause(!State.nseFeedPaused);
    if (!State.nseFeedPaused) refreshNseFeedImmediate();
  });
  el('btTimeframe').addEventListener('change', function () {
    el('btTfHint').style.display = this.value === 'D' ? 'block' : 'none';
  });
  el('tfSel').addEventListener('change', () => { stopSim(); if (!State.isLive && State.running) startSim(); });

  // Top-bar mode toggle — LIVE vs BACKTEST & OPTIMIZE
  el('btnModeLive').addEventListener('click', () => setAppMode('live'));
  el('btnModeBacktest').addEventListener('click', () => setAppMode('backtest'));

  // Chart type toggle (candlestick / line) + volume checkbox
  el('btnChartCandle').addEventListener('click', () => setChartType('candle'));
  el('btnChartLine').addEventListener('click', () => setChartType('line'));
  el('chkShowVolume').addEventListener('change', e => setShowVolume(e.target.checked));
  [10, 20, 50, 200].forEach(p => {
    el('chkDma' + p).addEventListener('change', e => CandleChart.setShowDma(p, e.target.checked));
  });

  // Initialize mode to 'live' on boot (matches the default active button in HTML)
  document.body.setAttribute('data-mode', 'live');

  // Default backtest dates
  const today = new Date();
  el('btTo').value   = today.toISOString().slice(0, 10);
  today.setDate(today.getDate() - 30);
  el('btFrom').value = today.toISOString().slice(0, 10);
});
