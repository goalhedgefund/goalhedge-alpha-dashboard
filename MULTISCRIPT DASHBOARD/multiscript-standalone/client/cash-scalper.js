const cashState = {
  snapshot: null,
  busy: false
};

function $(id) {
  return document.getElementById(id);
}

async function api(path, options = {}) {
  const res = await fetch(`/api/cash-scalper${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed: ${res.status}`);
  return data;
}

function money(value, digits = 0) {
  return `Rs ${Number(value || 0).toFixed(digits)}`;
}

function setSettings(settings = {}) {
  for (const key of ['inventoryLimit', 'carryForwardPct', 'dailyTargetPct', 'tradeSizePct', 'intradayCostPct', 'deliveryCostPct', 'scalpTargetPct', 'buyDeclinePct', 'sessionStart', 'squareOff']) {
    const input = $(key);
    if (input && document.activeElement !== input) input.value = settings[key] ?? '';
  }
}

function readSettings() {
  return {
    inventoryLimit: Number($('inventoryLimit').value) || 0,
    carryForwardPct: Number($('carryForwardPct').value) || 0,
    dailyTargetPct: Number($('dailyTargetPct').value) || 0,
    tradeSizePct: Number($('tradeSizePct').value) || 10,
    intradayCostPct: Number($('intradayCostPct').value) || 0,
    deliveryCostPct: Number($('deliveryCostPct').value) || 0,
    scalpTargetPct: Number($('scalpTargetPct').value) || 0,
    buyDeclinePct: Number($('buyDeclinePct').value) || 0,
    sessionStart: $('sessionStart').value || '09:15',
    squareOff: $('squareOff').value || '15:20'
  };
}

function actionClass(action) {
  return String(action || 'WAIT').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function render(snapshot) {
  cashState.snapshot = snapshot;
  setSettings(snapshot.settings || {});
  const totals = snapshot.totals || {};
  $('feedState').textContent = snapshot.connectionState || 'DISCONNECTED';
  $('symbolCount').textContent = totals.symbolCount || 0;
  $('dailyTarget').textContent = money(totals.dailyTarget);
  $('paperPnl').textContent = money(totals.realizedPnl);
  $('paperPnl').classList.toggle('good', Number(totals.realizedPnl) >= 0);
  $('paperPnl').classList.toggle('bad', Number(totals.realizedPnl) < 0);

  $('cashSummary').innerHTML = `
    <div><span>IST</span><strong>${snapshot.clock?.ist || '--:--'}</strong></div>
    <div><span>Carry Cap</span><strong>${money(totals.carryForwardCap)}</strong></div>
    <div><span>Long Inventory</span><strong>${money(totals.longInventory)}</strong></div>
    <div><span>Short Exposure</span><strong>${money(totals.shortExposure)}</strong></div>
    <div><span>Target Progress</span><strong>${Number(totals.targetProgressPct || 0).toFixed(1)}%</strong></div>
  `;

  renderRows(snapshot.rows || []);
  renderLedger(snapshot.trades || []);
}

function renderRows(rows) {
  const wrap = $('cashRows');
  if (!rows.length) {
    wrap.innerHTML = '<div class="trades-empty">Add cash scripts to begin paper scalping.</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="cash-table">
      <thead>
        <tr>
          <th>Script</th><th>LTP</th><th>Long</th><th>Short</th><th>Script Limit</th><th>10% Trade</th>
          <th>Trend</th><th>BB/EMA/RSI</th><th>Bid</th><th>Ask/Breakeven</th><th>Action</th><th>Paper Fill</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td><strong>${row.symbol}</strong><small>${row.securityId} &middot; ${row.exchangeSegment}</small></td>
            <td>${money(row.ltp, 2)}</td>
            <td>${row.longQty}<small>@ ${money(row.longAvg, 2)}</small></td>
            <td>${row.shortQty}<small>@ ${money(row.shortAvg, 2)}</small></td>
            <td>${money(row.scriptLimit)}<small>Left ${money(row.remainingScript)}</small></td>
            <td>${money(row.maxTradeValue)}</td>
            <td><strong>${row.strategy?.weeklyTrend || 'UNKNOWN'} / ${row.strategy?.dailyTrend || 'UNKNOWN'}</strong><small>Score ${row.strategy?.score || 0} &middot; ${row.strategy?.direction || 'NONE'}</small></td>
            <td>RSI ${Number(row.strategy?.rsi || 0).toFixed(1)}<small>EMA ${money(row.strategy?.emaFast, 2)} / ${money(row.strategy?.emaSlow, 2)} &middot; Ext ${Number(row.strategy?.entryExtensionPct || 0).toFixed(2)}%</small></td>
            <td>${money(row.bid, 2)}</td>
            <td>${money(Math.max(row.ask || 0, row.breakEven || 0), 2)}<small>BE ${money(row.breakEven, 2)}</small></td>
            <td><span class="cash-chip ${actionClass(row.action)}">${row.action}</span><small>${row.reason}</small></td>
            <td>
              ${row.paperSide ? `<button class="paper-action" data-symbol="${row.symbol}" data-side="${row.paperSide}" data-qty="${row.paperQty}" data-price="${row.paperPrice}">${row.paperSide} ${row.paperQty}</button><small>@ ${money(row.paperPrice, 2)}</small>` : '<span class="muted-text">No fill</span>'}
              ${row.shortQty > 0 && row.paperSide !== 'COVER' ? `<button class="paper-action muted mini" data-symbol="${row.symbol}" data-side="COVER" data-qty="${row.shortQty}" data-price="${row.ltp}">Cover</button>` : ''}
            </td>
            <td><button class="remove-symbol muted mini" data-symbol="${row.symbol}">Remove</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  wrap.querySelectorAll('.paper-action').forEach((button) => button.addEventListener('click', () => paperTrade(button)));
  wrap.querySelectorAll('.remove-symbol').forEach((button) => button.addEventListener('click', () => removeSymbol(button.dataset.symbol)));
}

function renderLedger(trades) {
  const wrap = $('tradeLedger');
  if (!trades.length) {
    wrap.innerHTML = '<div class="trades-empty">No paper fills yet.</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="cash-table">
      <thead><tr><th>Time</th><th>Script</th><th>Side</th><th>Qty</th><th>Price</th><th>Costs</th><th>Realized PnL</th><th>Reason</th></tr></thead>
      <tbody>
        ${trades.slice(0, 80).map((trade) => `
          <tr>
            <td>${new Date(trade.time).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td><strong>${trade.symbol}</strong></td>
            <td><span class="cash-chip ${trade.side.toLowerCase()}">${trade.side}</span></td>
            <td>${trade.quantity}</td>
            <td>${money(trade.price, 2)}</td>
            <td>${money(trade.costs, 2)}</td>
            <td class="${Number(trade.realizedPnl) >= 0 ? 'good' : 'bad'}">${money(trade.realizedPnl, 2)}</td>
            <td>${trade.reason || ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function refresh() {
  render(await api('/status'));
}

async function saveSettings() {
  render(await api('/settings', { method: 'POST', body: JSON.stringify(readSettings()) }));
}

async function refreshStrategy() {
  render(await api('/strategy/refresh', { method: 'POST', body: JSON.stringify({}) }));
}

async function addSymbol(row = null) {
  const payload = row || {
    symbol: $('symbolInput').value,
    exchangeSegment: 'NSE_EQ',
    scriptLimit: Number($('scriptLimitInput').value) || Number($('inventoryLimit').value) || 0
  };
  if (!payload.scriptLimit) payload.scriptLimit = Number($('scriptLimitInput').value) || Number($('inventoryLimit').value) || 0;
  render(await api('/symbols', { method: 'POST', body: JSON.stringify(payload) }));
  $('symbolInput').value = '';
}

async function removeSymbol(symbol) {
  render(await api(`/symbols/${encodeURIComponent(symbol)}`, { method: 'DELETE' }));
}

async function paperTrade(button) {
  if (cashState.busy) return;
  cashState.busy = true;
  button.disabled = true;
  try {
    render(await api('/paper-trade', {
      method: 'POST',
      body: JSON.stringify({
        symbol: button.dataset.symbol,
        side: button.dataset.side,
        quantity: Number(button.dataset.qty),
        price: Number(button.dataset.price),
        reason: `${button.dataset.side} from Cash Scalper`
      })
    }));
  } catch (err) {
    alert(err.message);
  } finally {
    cashState.busy = false;
    button.disabled = false;
  }
}

async function searchSymbols() {
  const q = $('symbolSearch').value;
  const wrap = $('searchResults');
  let rows = [];
  try {
    ({ rows } = await api(`/symbols/search?q=${encodeURIComponent(q)}`));
  } catch (err) {
    wrap.innerHTML = `<div class="muted-text">${err.message}</div>`;
    return;
  }
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted-text">No known local match. Enter Symbol + Security ID manually.</div>';
    return;
  }
  wrap.innerHTML = rows.map((row) => `
    <button type="button" class="search-result" data-symbol="${row.symbol}" data-security-id="${row.securityId}" data-name="${row.name}" data-exchange="${row.exchangeSegment}">
      <strong>${row.symbol}</strong><span>${row.name}</span>
    </button>
  `).join('');
  wrap.querySelectorAll('.search-result').forEach((button) => {
    button.addEventListener('click', () => {
      $('symbolInput').value = button.dataset.symbol;
      $('symbolSearch').value = button.dataset.symbol;
    });
  });
}

async function refreshMaster() {
  const result = await api('/symbols/refresh-master', { method: 'POST' });
  $('searchResults').innerHTML = `<div class="muted-text">Loaded ${result.count || 0} NSE EQ symbols from Dhan master.</div>`;
}

function setupEvents() {
  const source = new EventSource('/api/cash-scalper/events');
  source.addEventListener('status', (event) => render(JSON.parse(event.data)));
}

async function init() {
  await refresh();
  setupEvents();
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('refreshStrategyBtn').addEventListener('click', refreshStrategy);
  $('connectBtn').addEventListener('click', async () => render(await api('/connect', { method: 'POST' })));
  $('disconnectBtn').addEventListener('click', async () => render(await api('/disconnect', { method: 'POST' })));
  $('addSymbolBtn').addEventListener('click', () => addSymbol());
  $('refreshMasterBtn').addEventListener('click', refreshMaster);
  $('symbolSearch').addEventListener('input', () => {
    clearTimeout(cashState.searchTimer);
    cashState.searchTimer = setTimeout(searchSymbols, 180);
  });
}

init().catch((err) => {
  console.error(err);
  alert(err.message);
});
