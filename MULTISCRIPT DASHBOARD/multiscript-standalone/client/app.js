const state = {
  search: '',
  snapshot: null,
  connected: false,
  modeBusy: false,
  rangeBusy: false,
  runnerBusy: false,
  inventoryBusy: false,
  inventoryPlan: null,
  pnlMode: 'ALL',       // 'ALL' or 'INTRADAY'
  tradeLogOpen: true
};

const tfLabels = ['15'];

function byId(id) {
  return document.getElementById(id);
}

async function fetchSnapshot() {
  const res = await fetch('/api/multiscript/status');
  return res.json();
}

async function fetchInventoryPlan() {
  const res = await fetch('/api/multiscript/inventory');
  if (!res.ok) throw new Error('Inventory load failed');
  return res.json();
}

function getMode(snapshot) {
  return String(snapshot?.mode || 'LIVE').toUpperCase();
}

function toLocalInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function formatRangeValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function setRangeStatus(message, type = '') {
  const el = byId('rangeStatus');
  el.textContent = message;
  el.classList.toggle('ok', type === 'ok');
  el.classList.toggle('error', type === 'error');
}

function syncModeUI(snapshot) {
  const mode = getMode(snapshot);
  const toggle = byId('modeToggle');
  byId('modeState').textContent = mode;
  toggle.classList.toggle('replay', mode === 'REPLAY');
  toggle.classList.toggle('live', mode !== 'REPLAY');
  toggle.setAttribute('aria-pressed', String(mode === 'REPLAY'));
  toggle.disabled = Boolean(state.modeBusy);
  // Bug 4: hide range panel when not in REPLAY mode
  document.querySelector('.range-panel').classList.toggle('hidden', mode !== 'REPLAY');
}

function syncRangeUI(snapshot) {
  const range = snapshot?.replayRange || {};
  const fromInput = byId('replayFrom');
  const toInput = byId('replayTo');
  if (document.activeElement !== fromInput) {
    fromInput.value = toLocalInputValue(range.from);
  }
  if (document.activeElement !== toInput) {
    toInput.value = toLocalInputValue(range.to);
  }
  byId('applyRangeBtn').disabled = Boolean(state.rangeBusy);
  if (range.from || range.to) {
    setRangeStatus(`Applied ${formatRangeValue(range.from) || 'start'} to ${formatRangeValue(range.to) || 'end'}`, 'ok');
  } else {
    setRangeStatus('No replay range applied');
  }
}

function syncRunnerUI() {
  const busy = Boolean(state.runnerBusy);
  byId('startBtn').disabled = busy;
  byId('pauseBtn').disabled = busy;
  byId('resetBtn').disabled = busy;
}

const INTRADAY_FRAMES = new Set(['15']);

function renderSummary(snapshot) {
  const grid = byId('summaryGrid');
  const enabledLegs = snapshot.legs.filter((leg) => leg.enabled);
  const active = enabledLegs.length;
  const longCount = enabledLegs.filter((leg) => leg.signal === 'LONG').length;
  const shortCount = enabledLegs.filter((leg) => leg.signal === 'SHORT').length;
  const waitCount = enabledLegs.filter((leg) => leg.signal === 'WAIT').length;

  const pnlLegs = state.pnlMode === 'INTRADAY'
    ? snapshot.legs.filter((leg) => INTRADAY_FRAMES.has(leg.frame))
    : snapshot.legs;

  const realized = pnlLegs.reduce((sum, leg) => sum + (leg.realizedPnl || 0), 0);

  const unrealized = pnlLegs.reduce((sum, leg) => {
    const trade = leg.activeTrade;
    if (!trade || !leg.ltp) return sum;
    const dir = trade.side === 'LONG' ? 1 : -1;
    return sum + (leg.ltp - trade.entryPrice) * trade.quantity * dir;
  }, 0);

  const rClass = realized > 0 ? 'good' : realized < 0 ? 'bad' : '';
  const uClass = unrealized > 0 ? 'good' : unrealized < 0 ? 'bad' : '';

  grid.innerHTML = `
    ${[['Active Legs', active], ['Long', longCount], ['Short', shortCount], ['Waiting', waitCount]].map(([label, value]) => `
      <div class="summary-card">
        <span>${label}</span>
        <strong>${value}</strong>
      </div>`).join('')}
    <div class="summary-card pnl-card">
      <div class="pnl-label-row">
        <span>Realized PnL</span>
        <div class="pnl-toggle">
          <button class="${state.pnlMode === 'ALL' ? 'active' : ''}" data-pnl="ALL">All</button>
          <button class="${state.pnlMode === 'INTRADAY' ? 'active' : ''}" data-pnl="INTRADAY">Intraday</button>
        </div>
      </div>
      <strong class="${rClass}">Rs ${realized.toFixed(2)}</strong>
    </div>
    <div class="summary-card">
      <span>Unrealized PnL</span>
      <strong class="${uClass}">Rs ${unrealized.toFixed(2)}</strong>
    </div>`;
}

function actionClass(action) {
  return String(action || 'WAIT').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function setInventorySettings(settings = {}) {
  const map = {
    invTotalCapital: 'totalCapital',
    invMinStocks: 'minStocks',
    invMaxStocks: 'maxStocks',
    invIntradayCost: 'intradayCostPct',
    invDeliveryCost: 'deliveryCostPct',
    invScalpTarget: 'scalpTargetPct',
    invBuyDecline: 'buyDeclinePct',
    invMaxBuild: 'maxBuildPct'
  };
  for (const [id, key] of Object.entries(map)) {
    const el = byId(id);
    if (el && document.activeElement !== el) el.value = settings[key] ?? '';
  }
}

function readInventorySettings() {
  return {
    totalCapital: Number(byId('invTotalCapital').value) || 0,
    minStocks: Number(byId('invMinStocks').value) || 5,
    maxStocks: Number(byId('invMaxStocks').value) || 25,
    intradayCostPct: Number(byId('invIntradayCost').value) || 0,
    deliveryCostPct: Number(byId('invDeliveryCost').value) || 0,
    scalpTargetPct: Number(byId('invScalpTarget').value) || 0,
    buyDeclinePct: Number(byId('invBuyDecline').value) || 0,
    maxBuildPct: Number(byId('invMaxBuild').value) || 100
  };
}

function renderInventory(plan) {
  state.inventoryPlan = plan;
  setInventorySettings(plan.settings);
  const summary = byId('inventorySummary');
  const wrap = byId('inventoryWrap');
  const totals = plan.totals || {};
  const clock = plan.clock || {};
  const rows = plan.rows || [];

  summary.innerHTML = `
    <div><span>IST</span><strong>${clock.ist || '--:--'}</strong></div>
    <div><span>Stocks</span><strong>${totals.stockCount || 0}</strong></div>
    <div><span>Per Stock</span><strong>Rs ${Number(totals.perStockCapital || 0).toFixed(0)}</strong></div>
    <div><span>Deployed</span><strong>Rs ${Number(totals.deployed || 0).toFixed(0)}</strong></div>
    <div><span>Cash Left</span><strong>Rs ${Number(totals.cashRemaining || 0).toFixed(0)}</strong></div>
    <div><span>Paper PnL</span><strong class="${Number(totals.realizedPaperPnl) >= 0 ? 'good' : 'bad'}">Rs ${Number(totals.realizedPaperPnl || 0).toFixed(0)}</strong></div>
  `;

  if (!rows.length) {
    wrap.innerHTML = '<div class="trades-empty">No inventory symbols available.</div>';
    return;
  }

  wrap.innerHTML = `
    <div class="inventory-scroll">
      <table class="inventory-table">
        <thead>
          <tr>
            <th>Stock</th><th>LTP</th><th>Qty</th><th>Avg</th><th>Value</th>
            <th>Capacity</th><th>Bid</th><th>Ask</th><th>Edge</th><th>Action</th><th>Paper</th><th>Reason</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td><strong>${row.symbol}</strong><small>${row.signal}</small></td>
              <td>Rs ${Number(row.ltp || 0).toFixed(2)}</td>
              <td><input class="inv-qty" data-symbol="${row.symbol}" type="number" min="0" step="1" value="${row.quantity || 0}" /></td>
              <td><input class="inv-avg" data-symbol="${row.symbol}" type="number" min="0" step="0.05" value="${row.avgPrice || 0}" /></td>
              <td>Rs ${Number(row.positionValue || 0).toFixed(0)}</td>
              <td>Rs ${Number(row.capacityValue || 0).toFixed(0)}<small>Add ${row.addQty || 0}</small></td>
              <td>Rs ${Number(row.bid || 0).toFixed(2)}</td>
              <td>Rs ${Number(row.ask || 0).toFixed(2)}</td>
              <td class="${Number(row.scalpEdgePct) >= 0 ? 'good' : 'bad'}">${Number(row.scalpEdgePct || 0).toFixed(2)}%</td>
              <td><span class="action-chip ${actionClass(row.action)}">${row.action}</span></td>
              <td>
                ${row.paperSide ? `<button class="paper-fill-btn" data-symbol="${row.symbol}" data-side="${row.paperSide}" data-qty="${row.paperQty || 0}" data-price="${row.paperPrice || 0}" data-reason="${row.action}: ${row.reason || ''}">${row.paperSide} ${row.paperQty || 0}</button><small>@ Rs ${Number(row.paperPrice || 0).toFixed(2)}</small>` : '<span class="paper-muted">--</span>'}
              </td>
              <td>${row.reason || ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  renderPaperLedger(plan.paperTrades || []);
  wrap.querySelectorAll('.paper-fill-btn').forEach((button) => {
    button.addEventListener('click', () => executePaperFill(button));
  });
}

function renderPaperLedger(trades = []) {
  const wrap = byId('paperLedgerWrap');
  if (!trades.length) {
    wrap.innerHTML = '<div class="paper-ledger-empty">No paper inventory fills yet.</div>';
    return;
  }
  const recent = trades.slice(0, 12);
  wrap.innerHTML = `
    <div class="paper-ledger-title">
      <h3>Paper Inventory Fills</h3>
      <span>${trades.length} fill${trades.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="inventory-scroll">
      <table class="inventory-table paper-ledger-table">
        <thead><tr><th>Time</th><th>Stock</th><th>Side</th><th>Qty</th><th>Price</th><th>Costs</th><th>Realized</th><th>Reason</th></tr></thead>
        <tbody>
          ${recent.map((trade) => `
            <tr>
              <td>${new Date(trade.time).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}</td>
              <td><strong>${trade.symbol}</strong></td>
              <td><span class="action-chip ${trade.side === 'BUY' ? 'bid' : 'ask'}">${trade.side}</span></td>
              <td>${trade.quantity}</td>
              <td>Rs ${Number(trade.price || 0).toFixed(2)}</td>
              <td>Rs ${Number(trade.costs || 0).toFixed(2)}</td>
              <td class="${Number(trade.realizedPnl) >= 0 ? 'good' : 'bad'}">Rs ${Number(trade.realizedPnl || 0).toFixed(2)}</td>
              <td>${trade.reason || ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function refreshInventory() {
  const wrap = byId('inventoryWrap');
  if (!state.inventoryPlan) wrap.innerHTML = '<div class="trades-empty">Loading inventory plan...</div>';
  try {
    renderInventory(await fetchInventoryPlan());
  } catch (err) {
    wrap.innerHTML = `<div class="trades-empty error">Failed to load inventory: ${err.message}</div>`;
  }
}

async function saveInventory() {
  if (state.inventoryBusy || !state.inventoryPlan) return;
  state.inventoryBusy = true;
  byId('saveInventoryBtn').disabled = true;
  const positions = Array.from(document.querySelectorAll('.inv-qty')).map((qtyInput) => {
    const symbol = qtyInput.dataset.symbol;
    const avgInput = document.querySelector(`.inv-avg[data-symbol="${symbol}"]`);
    return {
      symbol,
      quantity: Number(qtyInput.value) || 0,
      avgPrice: Number(avgInput?.value) || 0
    };
  });
  try {
    const res = await fetch('/api/multiscript/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: readInventorySettings(), positions })
    });
    if (!res.ok) throw new Error('Inventory save failed');
    renderInventory(await res.json());
  } catch (err) {
    byId('inventoryWrap').insertAdjacentHTML('afterbegin', `<div class="trades-empty error">Failed to save inventory: ${err.message}</div>`);
  } finally {
    state.inventoryBusy = false;
    byId('saveInventoryBtn').disabled = false;
  }
}

async function executePaperFill(button) {
  if (state.inventoryBusy) return;
  const payload = {
    symbol: button.dataset.symbol,
    side: button.dataset.side,
    quantity: Number(button.dataset.qty) || 0,
    price: Number(button.dataset.price) || 0,
    reason: button.dataset.reason || 'Paper inventory fill'
  };
  if (!payload.quantity || !payload.price) return;
  state.inventoryBusy = true;
  button.disabled = true;
  try {
    const res = await fetch('/api/multiscript/inventory/paper-trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.message || 'Paper fill failed');
    }
    renderInventory(await res.json());
  } catch (err) {
    byId('inventoryWrap').insertAdjacentHTML('afterbegin', `<div class="trades-empty error">Paper fill failed: ${err.message}</div>`);
  } finally {
    state.inventoryBusy = false;
    button.disabled = false;
  }
}

function renderCards(snapshot) {
  const wrap = byId('cards');
  const query = state.search.trim().toUpperCase();
  const rows = snapshot.symbols
    .filter((row) => {
      if (!query) return true;
      return row.symbol.toUpperCase().includes(query) || row.name.toUpperCase().includes(query);
    })
    .sort((a, b) => {
      const aActive = (a.activeTimeframes?.length || 0) > 0;
      const bActive = (b.activeTimeframes?.length || 0) > 0;
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return a.symbol.localeCompare(b.symbol);
    });

  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state">No symbols found${query ? ` matching "<strong>${query}</strong>"` : ''}.</div>`;
    return;
  }

  // Build map: "SYMBOL:FRAME" → activeTrade for quick lookup
  const tradeMap = new Map();
  for (const leg of snapshot.legs || []) {
    if (leg.activeTrade) tradeMap.set(`${leg.symbol}:${leg.frame}`, leg.activeTrade);
  }

  wrap.innerHTML = rows.map((row) => {
    const enabled = row.enabledFrames || {};
    const activeText = row.activeTimeframes?.length ? row.activeTimeframes.join(', ') : 'No legs selected';

    const checks = tfLabels.map((label) => {
      const checked = Boolean(enabled[label]);
      const trade = tradeMap.get(`${row.symbol}:${label}`);
      const tradeClass = trade
        ? (trade.side === 'LONG' ? 'trade-long' : 'trade-short')
        : (checked ? 'active' : '');
      const tradeLabel = trade ? trade.side : '';
      return `
        <label class="leg-pill ${tradeClass}">
          <input type="checkbox" data-symbol="${row.symbol}" data-frame="${label}" ${checked ? 'checked' : ''} />
          <span>${label}</span>
          <small>${tradeLabel || (label === 'D' ? 'Daily' : label + 'm')}</small>
        </label>
      `;
    }).join('');

    return `
      <article class="card">
        <div class="card-head">
          <div>
            <h3>${row.symbol}</h3>
            <div class="meta">${row.name}</div>
          </div>
        </div>
        <div class="prices">
          <div>
            <div class="meta">LTP</div>
            <div class="big">Rs ${Number(row.ltp || 0).toFixed(2)}</div>
          </div>
          <div>
            <div class="meta">Primary</div>
            <div class="big">${row.primaryTimeframe || '15'}</div>
          </div>
        </div>
        <div class="legs">${checks}</div>
        <div class="footer">
          <span>${activeText}</span>
          <span>RR ${row.rr || 3}:1</span>
        </div>
      </article>
    `;
  }).join('');

  wrap.querySelectorAll('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', async () => {
      const symbol = input.dataset.symbol;
      const frame = input.dataset.frame;
      const symbolRow = snapshot.symbols.find((item) => item.symbol === symbol);
      const next = new Set(symbolRow.enabledFramesList || []);
      if (input.checked) next.add(frame);
      else next.delete(frame);
      await fetch('/api/multiscript/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          enabledFrames: Array.from(next)
        })
      });
      await refresh();
    });
  });
}

// Bug 1: ALL DOM work is deferred to a single rAF per batch of SSE events.
// The SSE handler only stashes the latest snapshot and schedules one frame —
// no matter how many events arrive per second, the DOM is updated at most once
// per animation frame (~60fps), keeping the main thread free between frames.
let _renderPending = false;
let _pendingSnapshot = null;

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  syncModeUI(snapshot);
  syncRangeUI(snapshot);
  byId('feedState').textContent = snapshot.connectionState;
  byId('runnerState').textContent = snapshot.runnerState;
  byId('activeLegs').textContent = snapshot.legs.filter((leg) => leg.enabled).length;
  syncRunnerUI();
  renderSummary(snapshot);
  renderCards(snapshot);
}

function scheduleRender(snapshot) {
  _pendingSnapshot = snapshot;
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(() => {
    _renderPending = false;
    applySnapshot(_pendingSnapshot);
  });
}

async function refresh() {
  const snapshot = await fetchSnapshot();
  applySnapshot(snapshot);
}

function setupEvents() {
  const source = new EventSource('/api/multiscript/events');
  source.addEventListener('status', (event) => {
    // Only JSON.parse here — zero DOM work; all rendering deferred to rAF
    scheduleRender(JSON.parse(event.data));
  });
  source.addEventListener('ping', () => {
    state.connected = true;
  });
  source.onerror = () => {
    state.connected = false;
  };
}

async function wireControls() {
  byId('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.snapshot) renderCards(state.snapshot);
  });

  byId('modeToggle').addEventListener('click', async () => {
    if (state.modeBusy || !state.snapshot) return;
    state.modeBusy = true;
    syncModeUI(state.snapshot);
    const nextMode = getMode(state.snapshot) === 'REPLAY' ? 'LIVE' : 'REPLAY';
    try {
      const response = await fetch('/api/multiscript/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: nextMode,
          replayRange: {
            from: fromLocalInputValue(byId('replayFrom').value),
            to: fromLocalInputValue(byId('replayTo').value)
          }
        })
      });
      if (!response.ok) throw new Error('Mode switch failed');
      await refresh();
    } catch (err) {
      setRangeStatus(err.message || 'Mode switch failed', 'error');
    } finally {
      state.modeBusy = false;
      syncModeUI(state.snapshot || { mode: nextMode });
    }
  });

  byId('applyRangeBtn').addEventListener('click', async () => {
    if (state.rangeBusy || !state.snapshot) return;
    const replayRange = {
      from: fromLocalInputValue(byId('replayFrom').value),
      to: fromLocalInputValue(byId('replayTo').value)
    };
    state.rangeBusy = true;
    byId('applyRangeBtn').disabled = true;
    setRangeStatus('Applying replay range...');
    try {
      const response = await fetch('/api/multiscript/range', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replayRange })
      });
      if (!response.ok) throw new Error('Apply Range failed');
      await refresh();
      setRangeStatus(`Applied ${formatRangeValue(state.snapshot?.replayRange?.from) || 'start'} to ${formatRangeValue(state.snapshot?.replayRange?.to) || 'end'}`, 'ok');
    } catch (err) {
      setRangeStatus(err.message || 'Apply Range failed', 'error');
    } finally {
      state.rangeBusy = false;
      syncRangeUI(state.snapshot || {});
    }
  });

  // Bug 6: disable Start/Pause/Reset during inflight requests
  byId('startBtn').addEventListener('click', async () => {
    if (state.runnerBusy) return;
    state.runnerBusy = true;
    syncRunnerUI();
    const activeFrames = ['15'];
    const tradeModeEl = document.querySelector('input[name="tradeMode"]:checked');
    const tradeMode = tradeModeEl ? tradeModeEl.value : 'INTRADAY';
    try {
      await fetch('/api/multiscript/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeFrames, tradeMode })
      });
      await refresh();
    } finally {
      state.runnerBusy = false;
      syncRunnerUI();
    }
  });

  byId('pauseBtn').addEventListener('click', async () => {
    if (state.runnerBusy) return;
    state.runnerBusy = true;
    syncRunnerUI();
    try {
      await fetch('/api/multiscript/pause', { method: 'POST' });
      await refresh();
    } finally {
      state.runnerBusy = false;
      syncRunnerUI();
    }
  });

  byId('resetBtn').addEventListener('click', async () => {
    if (state.runnerBusy) return;
    state.runnerBusy = true;
    syncRunnerUI();
    try {
      await fetch('/api/multiscript/reset', { method: 'POST' });
      await refresh();
    } finally {
      state.runnerBusy = false;
      syncRunnerUI();
    }
  });
}

async function loadTrades() {
  const from = byId('tradeFrom').value;
  const to = byId('tradeTo').value;
  const tf = byId('tradeTf').value;
  const wrap = byId('tradesWrap');
  wrap.innerHTML = '<div class="trades-empty">Loading…</div>';

  const params = new URLSearchParams();
  if (from) params.set('from', new Date(from).toISOString());
  if (to) params.set('to', new Date(to).toISOString());
  if (tf && tf !== 'all') params.set('timeframe', tf);

  try {
    const res = await fetch('/api/multiscript/trades?' + params.toString());
    const { rows, total } = await res.json();
    if (!rows.length) {
      wrap.innerHTML = '<div class="trades-empty">No trades found for the selected filters.</div>';
      return;
    }
    const cols = ['EntryTime','ExitTime','Symbol','Timeframe','Side','EntryPrice','ExitPrice','Quantity','GrossPnL','NetPnL','Outcome','Notes'];
    wrap.innerHTML = `
      <div class="trades-count">${total} trade${total !== 1 ? 's' : ''}</div>
      <div class="trades-scroll">
        <table class="trades-table">
          <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(r => `<tr class="${r.Outcome === 'OPEN' ? 'row-open' : r.NetPnL < 0 ? 'row-loss' : 'row-win'}">
            ${cols.map(c => {
              let v = r[c] ?? '';
              if (c === 'GrossPnL' || c === 'NetPnL') v = v !== '' ? Number(v).toFixed(2) : '';
              if (c === 'EntryPrice' || c === 'ExitPrice') v = v !== '' ? Number(v).toFixed(2) : '';
              return `<td>${v}</td>`;
            }).join('')}
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="trades-empty error">Failed to load trades: ${e.message}</div>`;
  }
}

async function init() {
  await refresh();
  setupEvents();
  await wireControls();
  byId('loadTradesBtn').addEventListener('click', loadTrades);

  // PnL toggle — delegated on the grid so it survives re-renders
  byId('summaryGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pnl]');
    if (!btn) return;
    state.pnlMode = btn.dataset.pnl;
    if (state.snapshot) renderSummary(state.snapshot);
  });

  byId('tradeLogToggle').addEventListener('click', () => {
    state.tradeLogOpen = !state.tradeLogOpen;
    const body = byId('tradeLogBody');
    const icon = byId('tradeLogToggle');
    body.classList.toggle('collapsed', !state.tradeLogOpen);
    icon.textContent = state.tradeLogOpen ? '▲' : '▼';
  });
  // Pre-fill From with today 9:00 AM local time
  const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  byId('tradeFrom').value = todayIST.toISOString().slice(0, 10) + 'T09:00';
}

init().catch((err) => {
  console.error(err);
  alert('Unable to load dashboard. Check backend startup.');
});
