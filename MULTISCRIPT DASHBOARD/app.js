const symbols = [
  { symbol: 'SBIN', base: 825.5 },
  { symbol: 'BANDHANBNK', base: 259.8 },
  { symbol: 'DELHIVERY', base: 438.2 },
  { symbol: 'RELIANCE', base: 1412.6 },
  { symbol: 'HDFCBANK', base: 1810.3 },
  { symbol: 'ICICIBANK', base: 1127.4 },
  { symbol: 'AXISBANK', base: 1159.2 },
  { symbol: 'TCS', base: 4159.7 },
  { symbol: 'INFY', base: 1711.6 },
  { symbol: 'TITAN', base: 3454.9 }
];

const runnerPlan = [
  { time: '00.0s', symbol: 'SBIN', lane: 'A' },
  { time: '00.8s', symbol: 'BANDHANBNK', lane: 'A' },
  { time: '01.6s', symbol: 'DELHIVERY', lane: 'A' },
  { time: '02.4s', symbol: 'RELIANCE', lane: 'A' },
  { time: '03.2s', symbol: 'HDFCBANK', lane: 'A' },
  { time: '04.0s', symbol: 'ICICIBANK', lane: 'B' },
  { time: '04.8s', symbol: 'AXISBANK', lane: 'B' },
  { time: '05.6s', symbol: 'TCS', lane: 'B' },
  { time: '06.4s', symbol: 'INFY', lane: 'B' },
  { time: '07.2s', symbol: 'TITAN', lane: 'B' }
];

const fmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr = (value) => `INR ${fmt.format(value)}`;
const state = {
  selected: 0,
  running: false,
  syncSelected: true,
  timer: null,
  rows: []
};

const el = (id) => document.getElementById(id);

function seedRow(item, idx) {
  const series = [];
  let price = item.base;
  for (let i = 0; i < 42; i++) {
    price = walk(price, idx);
    series.push(candleFromPrice(price));
  }
  return {
    ...item,
    last: price,
    basePrice: item.base,
    series,
    change: 0,
    pnl: 0,
    status: 'Paused',
    latency: 180 + idx * 17,
    lane: idx < 5 ? 'Lane A' : 'Lane B'
  };
}

function candleFromPrice(close, prev = close) {
  const open = prev;
  const hi = Math.max(open, close) + Math.abs(close - open) * 0.35 + Math.random() * 0.75;
  const lo = Math.min(open, close) - Math.abs(close - open) * 0.35 - Math.random() * 0.75;
  return { o: open, h: hi, l: lo, c: close };
}

function walk(price, idx) {
  const drift = (Math.random() - 0.48) * (price * (0.0015 + idx * 0.00003));
  return Math.max(1, price + drift);
}

function init() {
  state.rows = symbols.map(seedRow);
  renderAll();
  bindEvents();
  drawChart();
}

function bindEvents() {
  el('btnStartAll').addEventListener('click', () => {
    state.running = true;
    setMode('RUNNING');
    stopTimer();
    state.timer = setInterval(tick, 900);
    tick();
  });
  el('btnPauseAll').addEventListener('click', () => {
    state.running = false;
    setMode('PAUSED');
    stopTimer();
    renderAll();
  });
  el('btnResetAll').addEventListener('click', () => {
    stopTimer();
    state.running = false;
    state.selected = 0;
    state.rows = symbols.map(seedRow);
    setMode('IDLE');
    renderAll();
    drawChart();
  });
  el('syncSelected').addEventListener('change', (e) => {
    state.syncSelected = e.target.checked;
  });
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function setMode(mode) {
  el('engineMode').textContent = mode;
}

function tick() {
  state.rows = state.rows.map((row, idx) => {
    const next = walk(row.last, idx);
    const prev = row.last;
    const change = ((next - row.basePrice) / row.basePrice) * 100;
    const candle = candleFromPrice(next, prev);
    const series = row.series.concat(candle).slice(-64);
    let status = 'Running';
    if (Math.abs(change) > 1.65) status = 'Triggered';
    if (idx !== state.selected && Math.abs(change) < 0.25 && state.running) status = 'Running';
    return {
      ...row,
      last: next,
      change,
      pnl: (next - row.basePrice) * 4,
      series,
      status,
      latency: Math.max(110, row.latency + Math.round((Math.random() - 0.45) * 34))
    };
  });

  if (state.syncSelected) {
    state.selected = Math.min(state.selected, state.rows.length - 1);
  }

  renderAll();
  drawChart();
}

function renderAll() {
  renderTopStats();
  renderQueueHealth();
  renderWatchlist();
  renderChartFooter();
  renderSimCards();
  renderRunnerPlan();
}

function renderTopStats() {
  const rows = state.rows;
  const active = rows.length;
  const totalPnl = rows.reduce((sum, r) => sum + r.pnl, 0);
  const best = rows.reduce((a, b) => (a.change > b.change ? a : b), rows[0]);
  const worst = rows.reduce((a, b) => (a.change < b.change ? a : b), rows[0]);
  const selected = rows[state.selected];

  el('topStats').innerHTML = `
    <div class="stat"><div class="label">Active</div><div class="value">${active}</div><div class="sub">scripts tracked</div></div>
    <div class="stat"><div class="label">Combined P&L</div><div class="value" style="color:${totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${totalPnl >= 0 ? '+' : ''}${inr(totalPnl)}</div><div class="sub">synthetic demo values</div></div>
    <div class="stat"><div class="label">Best</div><div class="value" style="color:var(--green)">${best.symbol}</div><div class="sub">${best.change.toFixed(2)}%</div></div>
    <div class="stat"><div class="label">Worst</div><div class="value" style="color:var(--red)">${worst.symbol}</div><div class="sub">${worst.change.toFixed(2)}%</div></div>
    <div class="stat"><div class="label">Selected</div><div class="value" style="color:var(--cyan)">${selected.symbol}</div><div class="sub">${selected.status}</div></div>
  `;
}

function renderQueueHealth() {
  const avgLatency = Math.round(state.rows.reduce((sum, row) => sum + row.latency, 0) / state.rows.length);
  const target = state.running ? 'active queue' : 'dry preview';
  el('queueHealth').innerHTML = `
    <span class="queue-chip good">batch size 1</span>
    <span class="queue-chip good">delay 800 ms</span>
    <span class="queue-chip ${avgLatency > 320 ? 'warn' : 'good'}">avg ${avgLatency} ms</span>
    <span class="queue-chip ${state.syncSelected ? 'good' : 'warn'}">${target}</span>
  `;
}

function renderWatchlist() {
  const wrap = el('watchlist');
  wrap.innerHTML = state.rows.map((row, idx) => {
    const active = idx === state.selected ? 'active' : '';
    const up = row.change >= 0;
    return `
      <div class="watch-item ${active}" data-idx="${idx}">
        <div class="left">
          <div class="dot" style="color:${up ? 'var(--green)' : 'var(--red)'}"></div>
          <div>
            <div class="name">${row.symbol}</div>
            <div class="meta">${row.lane} / ${row.status}</div>
          </div>
        </div>
        <div class="price">
          <div>${fmt.format(row.last)}</div>
          <div class="chg ${up ? 'up' : 'down'}">${up ? '+' : ''}${row.change.toFixed(2)}%</div>
        </div>
      </div>
    `;
  }).join('');

  wrap.querySelectorAll('.watch-item').forEach(node => {
    node.addEventListener('click', () => {
      state.selected = Number(node.dataset.idx);
      renderAll();
      drawChart();
    });
  });
}

function renderChartFooter() {
  const row = state.rows[state.selected];
  const high = Math.max(...row.series.map(c => c.h));
  const low = Math.min(...row.series.map(c => c.l));
  const closes = row.series.map(c => c.c);
  const momentum = closes[closes.length - 1] - closes[Math.max(0, closes.length - 12)];
  const range = ((high - low) / row.last) * 100;

  el('selectedTitle').textContent = row.symbol;
  el('chartMeta').textContent = `${row.lane} / ${row.latency} ms / ${row.status}`;
  el('chartFooter').innerHTML = `
    <div class="footer-cell"><strong>${inr(row.last)}</strong>Last traded preview</div>
    <div class="footer-cell"><strong>${range.toFixed(2)}%</strong>Rolling range</div>
    <div class="footer-cell"><strong class="${momentum >= 0 ? 'up' : 'down'}">${momentum >= 0 ? '+' : ''}${fmt.format(momentum)}</strong>12-bar momentum</div>
    <div class="footer-cell"><strong>${row.lane}</strong>Stagger lane</div>
  `;
}

function renderSimCards() {
  const wrap = el('simList');
  wrap.innerHTML = state.rows.slice(0, 8).map((row, idx) => {
    const active = idx === state.selected ? 'active' : '';
    const tagClass = state.running ? (row.status === 'Triggered' ? 'triggered' : 'running') : 'paused';
    return `
      <div class="sim-card ${active}">
        <div class="row">
          <div class="sym">${row.symbol}</div>
          <div class="tag ${tagClass}">${state.running ? row.status : 'Paused'}</div>
        </div>
        <div class="price">${inr(row.last)}</div>
        <div class="subrow">
          <span>${row.change >= 0 ? '+' : ''}${row.change.toFixed(2)}%</span>
          <span>${idx === state.selected ? 'Focused' : 'Tracking'}</span>
        </div>
        ${sparkline(row.series)}
      </div>
    `;
  }).join('');
}

function renderRunnerPlan() {
  el('runnerGrid').innerHTML = runnerPlan.map(step => `
    <div class="runner-step">
      <div class="time">T+${step.time}</div>
      <div class="name">${step.symbol}</div>
      <div class="detail">Lane ${step.lane} / one request / retry on 429</div>
    </div>
  `).join('');
}

function sparkline(series) {
  const pts = series.map((p, i) => `${(i / Math.max(series.length - 1, 1)) * 100},${24 - normalize(p, series) * 24}`).join(' ');
  return `
    <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke="rgba(79,195,255,.45)" stroke-width="1.5" points="${pts}"></polyline>
    </svg>
  `;
}

function normalize(value, series) {
  const min = Math.min(...series);
  const max = Math.max(...series);
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

function drawChart() {
  const canvas = el('mainChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, cssW, cssH);
  paintGrid(ctx, cssW, cssH);

  const row = state.rows[state.selected];
  const candles = row.series;
  const pad = { l: 54, r: 18, t: 18, b: 26 };
  const plotW = cssW - pad.l - pad.r;
  const plotH = cssH - pad.t - pad.b;
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const scaleY = (v) => pad.t + ((max - v) / Math.max(max - min, 1e-6)) * plotH;
  const step = plotW / Math.max(candles.length, 1);
  const bodyW = Math.max(4, step * 0.48);

  ctx.fillStyle = '#cbd8f2';
  ctx.font = '12px Segoe UI';
  ctx.fillText(`Selected: ${row.symbol}`, 16, 22);
  ctx.fillText(`Last: ${inr(row.last)}`, 16, 42);

  candles.forEach((c, i) => {
    const x = pad.l + i * step + step / 2;
    const up = c.c >= c.o;
    const color = up ? '#31d18b' : '#ff6666';
    const yO = scaleY(c.o);
    const yC = scaleY(c.c);
    const yH = scaleY(c.h);
    const yL = scaleY(c.l);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yH);
    ctx.lineTo(x, yL);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)));
  });

  const last = candles[candles.length - 1];
  if (last) {
    ctx.strokeStyle = 'rgba(79,195,255,.35)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(pad.l, scaleY(last.c));
    ctx.lineTo(cssW - pad.r, scaleY(last.c));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function paintGrid(ctx, w, h) {
  ctx.fillStyle = 'rgba(255,255,255,.03)';
  for (let x = 0; x < w; x += 70) ctx.fillRect(x, 0, 1, h);
  for (let y = 0; y < h; y += 70) ctx.fillRect(0, y, w, 1);
}

init();
window.addEventListener('resize', drawChart);
