// ── CLAUDE Scalping — Chart Renderer (candlestick/line + volume) ─────────────
'use strict';

const CandleChart = (() => {
  const COLORS = {
    bullBody:   'rgba(29,158,117,0.25)',
    bullBorder: '#1D9E75',
    bearBody:   'rgba(226,75,74,0.25)',
    bearBorder: '#E24B4A',
    ema9:       '#1D9E75',
    ema21:      '#D85A30',
    bb:         'rgba(136,135,128,0.5)',
    grid:       'rgba(255,255,255,0.04)',
    axisText:   '#565d6a',
    crosshair:  'rgba(255,255,255,0.2)',
    lineClose:  '#378ADD',
    volUp:      'rgba(29,158,117,0.35)',
    volDown:    'rgba(226,75,74,0.30)',
    dma10:      '#E0C341',
    dma20:      '#D4537E',
    dma50:      '#7F77DD',
    dma200:     '#3DBFC4'
  };

  let canvas, ctx, dpr;
  let candles      = [];        // FULL candle array, never pre-sliced by callers
  let liveCandle    = null;
  let signals       = [];       // [{dir, entry, sl, tp}] - ACTIVE live signal zone (one at a time)
  let tradeMarkers  = [];       // [{entryBar, exitBar, dir, entry, exit, result, tradeIdx}] - ALWAYS indices into the FULL `candles` array above
  let highlightedTradeIdx = -1;
  let scrollOffset  = 0;        // candles back from the most recent, for scrollToBar()
  let chartType     = 'candle'; // 'candle' | 'line'
  let showVolume    = true;
  let showDma       = { dma10: false, dma20: false, dma50: false, dma200: false };
  let W = 600, H = 240;
  let rightPad = 60, botPad = 22;
  let mouseX = -1, mouseY = -1;
  let lastVis = [];
  let lastN = 0, lastCw = 1;
  let lastCandleOffset = 0;     // index of first visible candle within the FULL `candles` array
  let hoveredCandle = null;
  let hoverHandler = null;
  let viewportHandler = null;

  function init(canvasEl, height = 240) {
    canvas = canvasEl;
    H      = height;
    dpr    = window.devicePixelRatio || 1;
    resize();
    canvas.addEventListener('mousemove', onMouse);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mouseleave', () => { mouseX = -1; hoveredCandle = null; if (hoverHandler) hoverHandler(null); draw(); });
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas) return;
    W = canvas.parentElement ? canvas.parentElement.offsetWidth : 640;
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    draw();
  }

  function setHeight(newHeight) {
    H = newHeight;
    resize();
  }

  // `newCandles` must ALWAYS be the full, untruncated candle history for the
  // current view (live rolling buffer OR full backtest result) — never a
  // pre-sliced subset. This chart slices internally for display; doing it
  // twice is what caused trade markers to disappear (entryBar indices were
  // computed by the server against the full array, but getting handed a
  // truncated array here made every index map to nonsense).
  function update(newCandles, newLive, newSignals = []) {
    candles    = newCandles   || candles;
    liveCandle = newLive      !== undefined ? newLive : liveCandle;
    signals    = newSignals   || signals;
    scrollOffset = 0;
    draw();
  }

  function setChartType(type) {
    chartType = type === 'line' ? 'line' : 'candle';
    draw();
  }

  function setShowVolume(show) {
    showVolume = !!show;
    draw();
  }

  // Toggle individual DMA lines on/off. `period` is 10|20|50|200.
  function setShowDma(period, show) {
    const key = 'dma' + period;
    if (key in showDma) showDma[key] = !!show;
    draw();
  }

  // markers: [{entryBar, exitBar, dir, entry, exit, result, tradeIdx}]
  // entryBar/exitBar MUST be indices into the same `candles` array passed to update().
  function setTradeMarkers(markers) {
    tradeMarkers = markers || [];
    draw();
  }

  function setHighlightedTrade(tradeIdx) {
    highlightedTradeIdx = tradeIdx;
    draw();
  }

  function scrollToBar(barIndex) {
    const target = Math.max(0, barIndex - 40);
    scrollOffset = clampScroll(candles.length - 80 - target);
    if (viewportHandler) viewportHandler(getViewportState());
    draw();
  }

  function scrollByBars(deltaBars) {
    scrollOffset = clampScroll(scrollOffset + deltaBars);
    if (viewportHandler) viewportHandler(getViewportState());
    draw();
  }

  function clampScroll(value) {
    const maxScroll = Math.max(0, candles.length - 80);
    return Math.max(0, Math.min(maxScroll, value));
  }

  function onMouse(e) {
    const rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
    hoveredCandle = getHoveredCandle();
    if (hoverHandler) hoverHandler(hoveredCandle);
    draw();
  }

  function onWheel(e) {
    if (!candles.length) return;
    if (typeof State !== 'undefined' && State.chartMode !== 'backtest') return;
    e.preventDefault();
    const step = e.shiftKey ? 20 : 6;
    // Wheel down moves forward in time (toward the latest bars).
    scrollByBars(e.deltaY > 0 ? step : -step);
  }

  function draw() {
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, W, H);

    const chartW = W - rightPad;
    const fullH  = H - botPad;
    const volH   = showVolume ? fullH * 0.16 : 0;
    const chartH = fullH - volH;

    const visCount  = Math.min(80, candles.length);
    const sliceEnd  = scrollOffset > 0 ? candles.length - scrollOffset : candles.length;
    lastCandleOffset = Math.max(0, sliceEnd - 80);
    const vis = [...candles.slice(Math.max(0, sliceEnd - 80), sliceEnd)];
    if (scrollOffset === 0 && liveCandle) vis.push({ ...liveCandle, isLive: true });
    if (vis.length < 2) { drawEmpty(chartH); ctx.restore(); return; }

    let minP = Infinity, maxP = -Infinity;
    for (const c of vis) {
      minP = Math.min(minP, c.l, c.bbl || Infinity);
      maxP = Math.max(maxP, c.h, c.bbu || -Infinity);
    }
    for (const s of signals) {
      minP = Math.min(minP, s.sl);
      maxP = Math.max(maxP, s.tp);
    }
    [10, 20, 50, 200].forEach(period => {
      const key = 'dma' + period;
      if (!showDma[key]) return;
      for (const c of vis) {
        if (c[key] != null) { minP = Math.min(minP, c[key]); maxP = Math.max(maxP, c[key]); }
      }
    });
    const hasMarkers = tradeMarkers.length > 0;
    const pad = (maxP - minP) * (hasMarkers ? 0.14 : 0.08) || maxP * 0.005 || 1;
    const lo = minP - pad, hi = maxP + pad;

    const N   = vis.length;
    const cw  = Math.max(2, Math.floor(chartW / N) - 1);
    const toY = p => chartH - ((p - lo) / (hi - lo)) * chartH;
    const toX = i => Math.floor((i / N) * chartW) + cw / 2;
    lastVis = vis;
    lastN   = N;
    lastCw  = cw;
    hoveredCandle = getHoveredCandle();

    const isDark = matchMedia && matchMedia('(prefers-color-scheme:dark)').matches;

    // Grid
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth   = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = chartH * (i / 5);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(chartW, y); ctx.stroke();
    }

    // Signal zone (active live trade S/L & T/P band)
    for (const s of signals) {
      const bull = s.dir === 'LONG';
      ctx.fillStyle = bull ? 'rgba(29,158,117,0.06)' : 'rgba(226,75,74,0.06)';
      ctx.fillRect(0, toY(s.tp), chartW, toY(s.entry) - toY(s.tp));
      ctx.fillStyle = bull ? 'rgba(226,75,74,0.06)' : 'rgba(29,158,117,0.06)';
      ctx.fillRect(0, toY(s.entry), chartW, toY(s.sl) - toY(s.entry));
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth   = 0.7;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(0, toY(s.entry)); ctx.lineTo(chartW, toY(s.entry)); ctx.stroke();
      ctx.strokeStyle = bull ? 'rgba(29,158,117,0.6)' : 'rgba(226,75,74,0.6)';
      ctx.beginPath(); ctx.moveTo(0, toY(s.tp)); ctx.lineTo(chartW, toY(s.tp)); ctx.stroke();
      ctx.strokeStyle = bull ? 'rgba(226,75,74,0.6)' : 'rgba(29,158,117,0.6)';
      ctx.beginPath(); ctx.moveTo(0, toY(s.sl)); ctx.lineTo(chartW, toY(s.sl)); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Bollinger Bands
    if (vis[0] && vis[0].bbu) {
      ctx.strokeStyle = COLORS.bb;
      ctx.lineWidth   = 0.8;
      ctx.setLineDash([2, 3]);
      ['bbu', 'bbl'].forEach(key => {
        ctx.beginPath();
        let f = true;
        vis.forEach((c, i) => { if (c[key]) { f ? ctx.moveTo(toX(i), toY(c[key])) : ctx.lineTo(toX(i), toY(c[key])); f = false; } });
        ctx.stroke();
      });
      ctx.fillStyle = 'rgba(136,135,128,0.03)';
      ctx.beginPath();
      vis.forEach((c, i) => { if (c.bbu) { i === 0 ? ctx.moveTo(toX(i), toY(c.bbu)) : ctx.lineTo(toX(i), toY(c.bbu)); } });
      for (let i = vis.length - 1; i >= 0; i--) { if (vis[i].bbl) ctx.lineTo(toX(i), toY(vis[i].bbl)); }
      ctx.closePath(); ctx.fill();
      ctx.setLineDash([]);
    }

    // EMA 21 / EMA 9
    ctx.strokeStyle = COLORS.ema21; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
    ctx.beginPath();
    let f21 = true;
    vis.forEach((c, i) => { if (c.ema21) { f21 ? ctx.moveTo(toX(i), toY(c.ema21)) : ctx.lineTo(toX(i), toY(c.ema21)); f21 = false; } });
    ctx.stroke(); ctx.setLineDash([]);

    ctx.strokeStyle = COLORS.ema9; ctx.lineWidth = 1;
    ctx.beginPath();
    let f9 = true;
    vis.forEach((c, i) => { if (c.ema9) { f9 ? ctx.moveTo(toX(i), toY(c.ema9)) : ctx.lineTo(toX(i), toY(c.ema9)); f9 = false; } });
    ctx.stroke();

    // ── DMA overlays (10/20/50/200) — only drawn for periods the caller
    // has toggled on via setShowDma(). Each candle carries dmaN fields
    // computed server-side (server/lib/indicators.js computeDmaSeries).
    [10, 20, 50, 200].forEach(period => {
      const key = 'dma' + period;
      if (!showDma[key]) return;
      ctx.strokeStyle = COLORS[key];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let first = true;
      vis.forEach((c, i) => {
        if (c[key] != null) {
          first ? ctx.moveTo(toX(i), toY(c[key])) : ctx.lineTo(toX(i), toY(c[key]));
          first = false;
        }
      });
      ctx.stroke();
    });

    // ── Price: candlesticks OR line ──────────────────────────────────────────
    if (chartType === 'line') {
      ctx.strokeStyle = COLORS.lineClose;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      vis.forEach((c, i) => { i === 0 ? ctx.moveTo(toX(i), toY(c.c)) : ctx.lineTo(toX(i), toY(c.c)); });
      ctx.stroke();
      // Soft fill under the line
      ctx.lineTo(toX(vis.length - 1), chartH);
      ctx.lineTo(toX(0), chartH);
      ctx.closePath();
      ctx.fillStyle = 'rgba(55,138,221,0.06)';
      ctx.fill();
    } else {
      vis.forEach((c, i) => {
        const x    = toX(i);
        const bull = c.c >= c.o;
        ctx.strokeStyle = bull ? COLORS.bullBorder : COLORS.bearBorder;
        ctx.fillStyle   = bull ? COLORS.bullBody   : COLORS.bearBody;
        ctx.lineWidth   = c.isLive ? 0.6 : 0.8;
        if (c.isLive) ctx.setLineDash([1, 2]);
        ctx.beginPath();
        ctx.moveTo(x, toY(c.h));
        ctx.lineTo(x, toY(c.l));
        ctx.stroke();
        const y1 = toY(Math.max(c.o, c.c));
        const y2 = toY(Math.min(c.o, c.c));
        const bh = Math.max(1, y2 - y1);
        ctx.fillRect(x - cw / 2, y1, cw, bh);
        ctx.strokeRect(x - cw / 2, y1, cw, bh);
        if (c.isLive) ctx.setLineDash([]);
      });
    }

    // ── Trade markers ─────────────────────────────────────────────────────────
    // entryBar/exitBar are indices into the FULL `candles` array (never
    // pre-sliced), so lastCandleOffset (computed above from that same full
    // array) correctly maps them onto the visible window.
    const hasHighlight = highlightedTradeIdx >= 0;
    for (const m of tradeMarkers) {
      const entryVisIdx = m.entryBar - lastCandleOffset;
      const exitVisIdx  = m.exitBar  - lastCandleOffset;
      const entryVisible = entryVisIdx >= 0 && entryVisIdx < visCount;
      const exitVisible  = exitVisIdx  >= 0 && exitVisIdx  < visCount;
      if (!entryVisible && !exitVisible) continue;

      const won = m.result === 'WIN';
      const exitColor = won ? '#1D9E75' : '#E24B4A';
      const isHighlighted = hasHighlight && m.tradeIdx === highlightedTradeIdx;
      const dimmed = hasHighlight && !isHighlighted;
      ctx.globalAlpha = dimmed ? 0.22 : 1;

      if (isHighlighted && entryVisible) {
        const ex = toX(entryVisIdx), ey = toY(m.entry);
        ctx.beginPath(); ctx.arc(ex, ey, 11, 0, Math.PI * 2);
        ctx.strokeStyle = '#378ADD'; ctx.lineWidth = 2; ctx.stroke();
      }
      if (entryVisible) {
        const ex = toX(entryVisIdx), ey = toY(m.entry);
        ctx.fillStyle = m.dir === 'LONG' ? '#378ADD' : '#D4537E';
        ctx.beginPath();
        if (m.dir === 'LONG') { ctx.moveTo(ex, ey + 9); ctx.lineTo(ex - 4, ey + 16); ctx.lineTo(ex + 4, ey + 16); }
        else { ctx.moveTo(ex, ey - 9); ctx.lineTo(ex - 4, ey - 16); ctx.lineTo(ex + 4, ey - 16); }
        ctx.closePath(); ctx.fill();
      }
      if (isHighlighted && exitVisible) {
        const xx = toX(exitVisIdx), xy = toY(m.exit);
        ctx.beginPath(); ctx.arc(xx, xy, 9, 0, Math.PI * 2);
        ctx.strokeStyle = exitColor; ctx.lineWidth = 2; ctx.stroke();
      }
      if (exitVisible) {
        const xx = toX(exitVisIdx), xy = toY(m.exit);
        ctx.fillStyle = exitColor;
        ctx.beginPath(); ctx.arc(xx, xy, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0d0f11'; ctx.lineWidth = 1; ctx.stroke();
      }
      if (entryVisible && exitVisible) {
        ctx.strokeStyle = exitColor;
        ctx.globalAlpha  = dimmed ? 0.15 : 0.5;
        ctx.lineWidth    = isHighlighted ? 1.5 : 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(toX(entryVisIdx), toY(m.entry));
        ctx.lineTo(toX(exitVisIdx),  toY(m.exit));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }

    // Price axis labels
    ctx.fillStyle = isDark ? 'rgba(136,135,128,0.8)' : COLORS.axisText;
    ctx.font = '10px monospace'; ctx.textAlign = 'left';
    for (let i = 0; i <= 5; i++) {
      const p = lo + (hi - lo) * (1 - i / 5);
      const y = chartH * (i / 5) + (i === 0 ? 3 : i === 5 ? -1 : 3);
      ctx.fillText(p.toFixed(p > 100 ? 1 : 4), chartW + 3, y);
    }

    // ── Volume bars (in-canvas, below price area) ────────────────────────────
    if (showVolume && volH > 4) {
      const maxVol = Math.max(...vis.map(c => c.v || 0), 1);
      const volTop = chartH + 4;
      vis.forEach((c, i) => {
        if (!c.v) return;
        const bh = Math.max(1, (c.v / maxVol) * (volH - 6));
        const bull = c.c >= c.o;
        ctx.fillStyle = bull ? COLORS.volUp : COLORS.volDown;
        ctx.fillRect(toX(i) - cw / 2, volTop + (volH - 6) - bh, cw, bh);
      });
      ctx.fillStyle = isDark ? 'rgba(136,135,128,0.6)' : COLORS.axisText;
      ctx.font = '9px monospace';
      ctx.fillText('Vol', chartW + 3, volTop + 8);
    }

    // Crosshair
    if (mouseX >= 0 && mouseX <= chartW) {
      ctx.strokeStyle = COLORS.crosshair;
      ctx.lineWidth   = 0.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(mouseX, 0); ctx.lineTo(mouseX, chartH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, mouseY); ctx.lineTo(chartW, mouseY); ctx.stroke();
      ctx.setLineDash([]);

      if (mouseY <= chartH) {
        const hoverPrice = lo + (hi - lo) * (1 - mouseY / chartH);
        ctx.fillStyle   = 'rgba(55,138,221,0.9)';
        ctx.fillRect(chartW + 1, mouseY - 8, rightPad - 2, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(hoverPrice.toFixed(hoverPrice > 100 ? 1 : 4), chartW + 3, mouseY + 4);
      }

      if (lastN > 0) {
        const idx = Math.min(lastN - 1, Math.max(0, Math.round((mouseX / chartW) * lastN - 0.5)));
        const cnd = lastVis[idx];
        if (cnd && cnd.ts) {
          const dateLabel = formatTs(cnd.ts);
          ctx.font = '10px monospace';
          const labelW = ctx.measureText(dateLabel).width + 10;
          let boxX = mouseX - labelW / 2;
          boxX = Math.max(0, Math.min(chartW - labelW, boxX));
          ctx.fillStyle = 'rgba(55,138,221,0.9)';
          ctx.fillRect(boxX, fullH + 2, labelW, 16);
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.fillText(dateLabel, boxX + labelW / 2, fullH + 14);
          ctx.textAlign = 'left';
        }
      }
    }

    ctx.restore();
  }

  function formatTs(ts) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    const d  = new Date(ms);
    const datePart = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
    const timePart = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata', hour12: false });
    return `${datePart} ${timePart}`;
  }

  function drawEmpty(chartH) {
    ctx.fillStyle = COLORS.axisText;
    ctx.font      = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for price data…', W / 2, (chartH || H) / 2);
  }

  function getHoveredCandle() {
    if (mouseX < 0 || mouseX > (W - rightPad) || lastN <= 0) return null;
    const chartW = W - rightPad;
    const idx = Math.min(lastN - 1, Math.max(0, Math.round((mouseX / chartW) * lastN - 0.5)));
    const candle = lastVis[idx];
    if (!candle) return null;
    return { ...candle, visibleIndex: idx, barIndex: lastCandleOffset + idx };
  }

  function setHoverHandler(fn) {
    hoverHandler = typeof fn === 'function' ? fn : null;
  }

  function getHoverCandle() {
    return hoveredCandle;
  }

  function getViewportState() {
    const maxScroll = Math.max(0, candles.length - 80);
    const start = Math.max(0, candles.length - 80 - scrollOffset);
    const end = Math.min(candles.length, start + 80);
    return {
      start,
      end,
      total: candles.length,
      maxScroll,
      scrollOffset
    };
  }

  function setViewportHandler(fn) {
    viewportHandler = typeof fn === 'function' ? fn : null;
  }

  return {
    init, update, resize, setHeight,
    setChartType, setShowVolume, setShowDma,
    setTradeMarkers, setHighlightedTrade, scrollToBar,
    setHoverHandler, getHoverCandle, scrollByBars,
    getViewportState, setViewportHandler
  };
})();
