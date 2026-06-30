const fs = require('node:fs');
const path = require('node:path');
const timeframeConfig = require('../config/timeframe.config');
const { evaluateLeg, USE_SCALPER } = require('./strategy.engine');
const { createLegState, isDueForRefresh } = require('./timeframe.engine');

// Intraday execution rules (mirrors scripts/backtest/engine.js so REPLAY mode
// matches the standalone backtest model). LIVE mode enforces square-off via
// the real-wall-clock eodTimer instead (see startLoops); these constants are
// only consulted for REPLAY, which has no wall clock to anchor a timer to.
const REPLAY_INTRADAY_FRAMES = new Set(['1', '5', '15']);
const REPLAY_LAST_ENTRY_MINUTE = 15 * 60 + 15; // no new entries after 15:15 IST
const REPLAY_SQUARE_OFF_MINUTE = 15 * 60 + 25; // force flat from 15:25 IST

// Re-entry discipline matching scripts/backtest/engine.js's `simulate` model:
// after any exit, wait COOLDOWN_BARS closed candles before considering a new
// entry, and even after cooldown, require the score to genuinely flip
// direction (a WAIT bar resets the requirement) rather than re-firing the
// same direction every bar it remains qualifying. Without this the backtested
// edge doesn't transfer — confirmed via a same-config comparison: 158 trades
// in the standalone engine for April 2026 vs 424 in the dashboard before this
// fix, the same ~2.7x overtrading pattern across every symbol. Only applied
// when the validated scalper strategy is active (SCALPER_ENGINE=1) — the
// legacy signal engine's behaviour is untouched.
const COOLDOWN_BARS = 8;

function istMinuteOfDayMs(tsMs) {
  const ist = new Date(tsMs + 5.5 * 60 * 60 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function istDateKeyMs(tsMs) {
  const ist = new Date(tsMs + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

function createRunner({
  env,
  stateStore,
  cacheStore,
  selectionService,
  candleService,
  feedService,
  tradeService,
  onModeChange
}) {
  let activeLegs = [];
  // Bumped every time rebuildLegs() replaces activeLegs with fresh leg
  // objects (all lastCandleTimestamp=0 again). An in-flight refreshDueCandles
  // batch captures the generation at its start and aborts mid-batch if it no
  // longer matches — otherwise a rebuild during a slow REPLAY batch (e.g. a
  // mode/range/reset/start sequence fired in quick succession) leaves the old
  // batch still holding references to orphaned leg objects, which it keeps
  // walking and trading from scratch alongside the new generation: confirmed
  // root cause of duplicate trades (two distinct TradeIds, identical entry/
  // exit time and price, for the same historical bar).
  let legsGeneration = 0;
  let selectedSymbolMap = new Map();
  let catalog = selectionService.loadOptimizedCatalog();
  let overrides = selectionService.loadSymbolOverrides();
  let watchlist = selectionService.loadWatchlist();
  let refreshTimer = null;
  let snapshotTimer = null;
  let eodTimer = null;
  let refreshBusy = false;
  let activeFrameFilter = null;
  let tradeMode = 'INTRADAY'; // 'INTRADAY' | 'CARRY_FORWARD'

  const persistFile = path.join(env.dataDir, 'active-trades.json');

  function getISTHHMM() {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCHours() * 100 + ist.getUTCMinutes();
  }

  function persistActiveTrades() {
    try {
      const snapshot = activeLegs
        .filter((leg) => leg.activeTrade)
        .map((leg) => ({
          symbol: leg.symbol,
          frame: leg.frame,
          activeTrade: leg.activeTrade,
          lastCandleTimestamp: leg.lastCandleTimestamp,
          realizedPnl: leg.realizedPnl
        }));
      fs.writeFileSync(persistFile, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (err) {
      console.error('[runner] Failed to persist trades:', err.message);
    }
  }

  function restoreActiveTrades() {
    try {
      if (!fs.existsSync(persistFile)) return;
      const saved = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
      for (const entry of saved) {
        const leg = activeLegs.find((l) => l.symbol === entry.symbol && l.frame === entry.frame);
        if (leg) {
          leg.activeTrade = entry.activeTrade;
          leg.lastCandleTimestamp = entry.lastCandleTimestamp || 0;
          leg.realizedPnl = entry.realizedPnl || 0;
        }
      }
      fs.unlinkSync(persistFile);
      console.log(`[runner] Restored ${saved.length} carry-forward trade(s).`);
    } catch (err) {
      console.error('[runner] Failed to restore trades:', err.message);
    }
  }

  function closeAllAtEOD() {
    let closed = 0;
    for (const leg of activeLegs) {
      if (!leg.activeTrade || !leg.ltp) continue;
      const exitPrice = leg.ltp;
      const trade = leg.activeTrade;
      const grossPnl = (exitPrice - trade.entryPrice) * trade.quantity * (trade.side === 'SHORT' ? -1 : 1);
      const costs = Math.abs(exitPrice * trade.quantity) * 0.0005;
      leg.realizedPnl += grossPnl - costs;
      tradeService.closeTrade(leg, exitPrice, 'EOD');
      closed++;
    }
    console.log(`[runner] EOD close: ${closed} position(s) closed.`);
    emitState();
  }

  function getReplayRange() {
    const state = stateStore.getState();
    return state.replayRange || null;
  }

  function buildSelectionMap(selection = watchlist) {
    selectedSymbolMap = new Map((selection.symbols || []).map((row) => [
      row.symbol,
      {
        ...row,
        enabledFrames: Array.from(new Set(row.enabledFrames || []))
      }
    ]));
  }

  function refreshCatalog() {
    catalog = selectionService.loadOptimizedCatalog();
    overrides = selectionService.loadSymbolOverrides();
    watchlist = selectionService.loadWatchlist();
    buildSelectionMap(watchlist);
    rebuildLegs();
  }

  function rebuildLegs() {
    const symbols = watchlist.symbols || [];
    activeLegs = [];
    legsGeneration += 1;

    for (const row of symbols.slice(0, env.maxSymbols)) {
      for (const frame of timeframeConfig.map((item) => item.key)) {
        const inWatchlist = (row.enabledFrames || []).includes(frame);
        const enabled = inWatchlist && (activeFrameFilter ? activeFrameFilter.has(frame) : true);
        const resolved = selectionService.resolveFrameConfig(row, frame, catalog, overrides);
        const leg = createLegState({
          symbol: row.symbol,
          name: row.name,
          exchangeSegment: row.exchange || 'NSE_EQ',
          securityId: row.secId,
          frame,
          config: resolved.config,
          enabled,
          usingDefault: resolved.usingDefault
        });
        leg.primary = frame === (row.primaryTimeframe || '15');
        leg.configKey = resolved.configKey;
        leg.primaryTimeframe = row.primaryTimeframe || '15';
        activeLegs.push(leg);
      }
    }

    emitState();
  }

  async function setMode(mode) {
    const nextMode = String(mode || 'LIVE').toUpperCase();
    const currentMode = String(stateStore.getState().mode || 'LIVE').toUpperCase();
    if (currentMode === nextMode) return getStatus();

    const wasRunning = stateStore.getState().runnerState === 'RUNNING';
    if (wasRunning) {
      feedService.stop();
      if (refreshTimer) clearInterval(refreshTimer);
      if (snapshotTimer) clearInterval(snapshotTimer);
      refreshTimer = null;
      snapshotTimer = null;
      stateStore.patch({ runnerState: 'IDLE' });
    }

    stateStore.patch({
      mode: nextMode,
      replayRange: nextMode === 'REPLAY' ? (stateStore.getState().replayRange || getReplayRange() || null) : stateStore.getState().replayRange || null,
      connectionState: nextMode === 'REPLAY' ? 'REPLAY_READY' : 'DISCONNECTED'
    });

    if (typeof onModeChange === 'function') {
      await onModeChange(nextMode, {
        watchlist: selectionService.loadWatchlist(),
        wasRunning
      });
    } else if (typeof feedService.setMode === 'function') {
      feedService.setMode(nextMode);
    }

    refreshCatalog();
    emitState();
    return getStatus();
  }

  function getLegBySymbolFrame(symbol, frame) {
    return activeLegs.find((leg) => leg.symbol === symbol && leg.frame === frame);
  }

  function subscribeFeed() {
    const instruments = [];
    for (const leg of activeLegs) {
      if (leg.enabled && leg.securityId) {
        instruments.push({
          symbol: leg.symbol,
          name: leg.name,
          exchangeSegment: leg.exchangeSegment,
          securityId: leg.securityId
        });
      }
    }
    if (instruments.length) {
      feedService.start(instruments);
    }
  }

  function handlePacket(packet) {
    // REPLAY drives ticks at extreme speed (a year of 1-minute ticks in
    // minutes of wall time). Recomputing the full indicator/signal score on
    // every single tick (O(candle history) each) is what made long replays
    // take many minutes and balloon memory. Trade decisions only ever happen
    // on candle close (refreshDueCandles below), so in REPLAY mode we just
    // update price/cache here and let the candle-close walk-forward own the
    // signal evaluation. LIVE mode keeps the full per-tick display eval.
    const isReplay = String(stateStore.getState().mode || 'LIVE').toUpperCase() === 'REPLAY';
    const legMatches = activeLegs.filter((leg) => leg.enabled && String(leg.securityId) === String(packet.securityId));
    for (const leg of legMatches) {
      leg.ltp = Number(packet.ltp || packet.close || leg.ltp || 0);
      leg.lastTickAt = Date.now();
      leg.source = isReplay ? 'REPLAY' : 'WS';
      leg.status = 'LIVE';
      cacheStore.setQuote(`${leg.symbol}:${leg.frame}`, packet);

      if (!isReplay) {
        // Display only: evaluate signal with live price merged into forming candle.
        // Trade decisions are made only on candle close inside refreshDueCandles.
        const candles = cacheStore.getCandles(`${leg.symbol}:${leg.frame}`) || leg.candles || [];
        const evaluated = evaluateLeg({
          leg,
          livePrice: leg.ltp,
          candles,
          config: leg.config,
          primary: leg.primary
        });
        Object.assign(leg, evaluated);
      }
    }
    if (!isReplay) emitState();
  }

  function onFeedState(next) {
    if (next === 'REPLAY_ENDED') {
      if (refreshTimer) clearInterval(refreshTimer);
      if (snapshotTimer) clearInterval(snapshotTimer);
      refreshTimer = null;
      snapshotTimer = null;
      stateStore.patch({ runnerState: 'IDLE', connectionState: next });
      // One final, forced catch-up pass: the wall-clock refresh interval may
      // not have fired again between the last batch of ticks and this event
      // (and some legs may not be technically "due" yet by mere milliseconds),
      // so the tail end of the replay range could otherwise never get evaluated.
      refreshDueCandles(true)
        .catch((err) => console.error('[runner] final replay catch-up failed:', err.message))
        .finally(() => emitState());
      return;
    }
    stateStore.patch({ connectionState: next });
    emitState();
  }

  async function setReplayRange(range = {}) {
    const normalized = {
      from: range?.from || null,
      to: range?.to || null
    };
    stateStore.patch({ replayRange: normalized });
    if (typeof selectionService.saveRuntimeConfig === 'function') {
      selectionService.saveRuntimeConfig({ replayRange: normalized });
    }
    if (typeof feedService.setReplayRange === 'function') {
      feedService.setReplayRange(normalized);
    }
    if (stateStore.getState().mode === 'REPLAY' && stateStore.getState().runnerState === 'RUNNING') {
      feedService.stop();
      subscribeFeed();
    }
    emitState();
    return getStatus();
  }

  async function refreshLeg(leg, isReplay) {
    const candles = await candleService.refreshDueLeg(leg);
    leg.candles = candles;
    leg.lastRefreshAt = Date.now();
    leg.status = leg.status === 'DISABLED' ? 'WAIT' : leg.status;

    // Display evaluation: merge live price into the forming candle for UI
    const evaluated = evaluateLeg({
      leg,
      livePrice: leg.ltp || (candles[candles.length - 1] ? candles[candles.length - 1].close : 0),
      candles,
      config: leg.config,
      primary: leg.primary
    });
    Object.assign(leg, evaluated);

    // Walk forward through every newly-closed candle in chronological order so
    // no candle-close decision is skipped — matters when several bars close
    // between refresh polls (fast REPLAY mode, or LIVE catching up after
    // downtime). In LIVE mode, the leg's very first-ever evaluation has no
    // prior reference point, so jump straight to the latest candle only
    // (avoids flooding startup with trade decisions across the whole lookback
    // window). REPLAY mode always walks from the true start (lastCandleTimestamp
    // defaults to 0) — a leg's "first call" can land arbitrarily late in a fast
    // replay, so skipping ahead there would silently throw away the whole walk.
    if (candles.length) {
      const isReplayIntraday = isReplay && REPLAY_INTRADAY_FRAMES.has(leg.frame);
      // Candle data includes a pre-range warm-up buffer so indicators are
      // properly converged by the time the user's requested range starts
      // (see replay.repository.js's getClosedSeries/WARMUP_DAYS). Bars before
      // that true start are walked for state continuity (cooldown, lastDir,
      // open positions) but never logged — only entries from this point on
      // count as "the replay".
      const userRangeFromMs = isReplay ? (() => {
        const r = getReplayRange();
        const ms = r && r.from ? Date.parse(r.from) : NaN;
        return Number.isFinite(ms) ? ms : null;
      })() : null;
      let startIdx;
      if (!isReplay && !leg.lastCandleTimestamp) {
        startIdx = candles.length - 1;
      } else {
        const idx = candles.findIndex((c) => c.timestamp > leg.lastCandleTimestamp);
        startIdx = idx === -1 ? candles.length : idx;
      }
      for (let i = startIdx; i < candles.length; i += 1) {
        const closedSlice = candles.slice(0, i + 1);
        const closeCandle = closedSlice[closedSlice.length - 1];
        leg.lastCandleTimestamp = closeCandle.timestamp;
        const isWarmup = userRangeFromMs !== null && closeCandle.timestamp < userRangeFromMs;

        if (leg.activeTrade) {
          if (USE_SCALPER) {
            // Holding: exit ONLY via EOD square-off, stop, or target — never
            // by re-checking the signal. Matches scripts/backtest/engine.js,
            // which ignores the score entirely while a position is open
            // (confirmed: it was the dominant source of overtrading — the
            // old WAIT/flip-driven exit path below kept closing and
            // reopening positions every time the score moved, producing
            // ~4x the backtest's trade count for the same period). REPLAY
            // has no real-wall-clock eodTimer, so square-off is enforced
            // here against the simulated candle time; LIVE mode's own
            // eodTimer (see startLoops) covers that case instead.
            let exited = false;
            if (isReplayIntraday) {
              const minuteOfDay = istMinuteOfDayMs(closeCandle.timestamp);
              if (minuteOfDay >= REPLAY_SQUARE_OFF_MINUTE) {
                tradeService.closeTrade(leg, closeCandle.close, 'EOD', closeCandle.timestamp);
                leg.cooldownRemaining = COOLDOWN_BARS;
                exited = true;
              } else if (istDateKeyMs(closeCandle.timestamp) !== leg.activeTrade.entryTime.slice(0, 10)) {
                // Fallback for when no candle ever fell in the >=15:25 IST
                // window on the entry day (illiquid stock, data gap) — the
                // square-off check above never fires, and without this the
                // position silently carries forever, blocking every future
                // signal for this leg. Matches the backtest's NOCARRY rule:
                // force flat at this bar's open once the calendar day has
                // changed. Confirmed root cause via direct trace: BHARATFORG
                // opened once on 2026-04-15 and (absent this fix) never
                // closed again through 2026-06-30.
                tradeService.closeTrade(leg, closeCandle.open, 'NOCARRY', closeCandle.timestamp);
                leg.cooldownRemaining = COOLDOWN_BARS;
                exited = true;
              }
            }
            if (!exited) {
              const t = leg.activeTrade;
              const hitTp = t.side === 'LONG' ? closeCandle.high >= t.targetPrice : closeCandle.low <= t.targetPrice;
              const hitSl = t.side === 'LONG' ? closeCandle.low <= t.stopPrice : closeCandle.high >= t.stopPrice;
              if (hitTp || hitSl) {
                // Conservative: if both were touched within the same closed
                // candle, assume the stop hit first (matches the backtest's
                // SL_AND_TP_SAME_CANDLE_ASSUME_SL rule).
                const exitPrice = hitSl ? t.stopPrice : t.targetPrice;
                tradeService.closeTrade(leg, exitPrice, hitSl ? 'SL' : 'TARGET', closeCandle.timestamp);
                leg.cooldownRemaining = COOLDOWN_BARS;
              }
            }
          } else {
            // Legacy engine: unchanged signal-driven exit/flip behaviour.
            const tradeEval = evaluateLeg({
              leg,
              livePrice: closeCandle.close,
              candles: closedSlice,
              config: leg.config,
              primary: leg.primary
            });
            tradeService.maybeRollTrade(leg, tradeEval, closeCandle.timestamp);
          }
          continue; // never evaluate a fresh entry on the same bar we held/exited on
        }

        // Flat. Cooldown only ticks down while flat (mirrors the backtest,
        // where cooldown is checked only once the "holding" branch is ruled
        // out).
        if (USE_SCALPER && leg.cooldownRemaining > 0) {
          leg.cooldownRemaining -= 1;
          continue;
        }

        const tradeEval = evaluateLeg({
          leg,
          livePrice: closeCandle.close,
          candles: closedSlice,
          config: leg.config,
          primary: leg.primary
        });

        // Re-entry discipline: require the score to genuinely flip direction
        // before opening — a WAIT bar resets the requirement. Matches the
        // backtest's lastDir tracking.
        if (USE_SCALPER) {
          if (tradeEval.signal === 'WAIT') { leg.lastSignalDir = null; continue; }
          if (tradeEval.signal === leg.lastSignalDir) continue;
        }

        // No new intraday entries late in the day during replay (matches
        // the backtest's no-entry-after-15:15 / square-off-by-15:25 model).
        if (isReplayIntraday && tradeEval.signal !== 'WAIT') {
          const minuteOfDay = istMinuteOfDayMs(closeCandle.timestamp);
          if (minuteOfDay > REPLAY_LAST_ENTRY_MINUTE) {
            // Backtest still updates lastDir even when the entry is blocked
            // by the time gate, so a still-qualifying signal doesn't
            // re-trigger this same check on every remaining bar of the day.
            if (USE_SCALPER) leg.lastSignalDir = tradeEval.signal;
            continue;
          }
        }

        if (USE_SCALPER) leg.lastSignalDir = tradeEval.signal;
        tradeService.maybeRollTrade(leg, tradeEval, closeCandle.timestamp, isWarmup);
      }
    }
  }

  async function refreshDueCandles(force = false) {
    if (refreshBusy) return;
    refreshBusy = true;
    const now = Date.now();
    const isReplay = String(stateStore.getState().mode || 'LIVE').toUpperCase() === 'REPLAY';
    const due = activeLegs.filter((leg) => leg.enabled && (force || isDueForRefresh(leg, now)));
    if (!due.length) {
      refreshBusy = false;
      return;
    }
    // LIVE mode: process one leg per interval (spreads out real Dhan API calls).
    // REPLAY mode: no external API involved, and the simulated clock can race
    // far ahead of this wall-clock interval, so service every due leg each
    // tick — otherwise most legs would never get a single refresh before the
    // replay ends.
    const legsToProcess = isReplay
      ? due
      : [due.sort((a, b) => (a.lastRefreshAt || 0) - (b.lastRefreshAt || 0))[0]];
    const generationAtStart = legsGeneration;
    for (const leg of legsToProcess) {
      // A rebuildLegs() call landed mid-batch (e.g. a mode/range/reset/start
      // sequence fired while a slow REPLAY batch was still in flight) — the
      // remaining legs in this batch are now orphaned duplicates of the
      // fresh generation, which will process them from scratch on its own.
      // Abort rather than double-trade the same historical bars.
      if (legsGeneration !== generationAtStart) break;
      try {
        await refreshLeg(leg, isReplay);
      } catch (err) {
        leg.lastError = err.message;
        leg.status = 'STALE';
      }
    }
    emitState();
    refreshBusy = false;
  }

  function refreshSnapshot() {
    const snapshotLegs = activeLegs.map((leg) => ({
      id: leg.id,
      symbol: leg.symbol,
      name: leg.name,
      frame: leg.frame,
      enabled: leg.enabled,
      signal: leg.signal,
      bull: leg.bull,
      bear: leg.bear,
      ltp: leg.ltp,
      entry: leg.entry,
      stop: leg.stop,
      target: leg.target,
      rr: leg.rr,
      usingDefault: leg.usingDefault,
      realizedPnl: leg.realizedPnl,
      activeTrade: leg.activeTrade,
      status: leg.status,
      lastError: leg.lastError,
      primary: leg.primary,
      primaryTimeframe: leg.primaryTimeframe,
      configKey: leg.configKey,
      exchangeSegment: leg.exchangeSegment,
      securityId: leg.securityId
    }));

    const symbolMap = new Map();
    for (const leg of snapshotLegs) {
      if (!symbolMap.has(leg.symbol)) {
        symbolMap.set(leg.symbol, {
          symbol: leg.symbol,
          name: leg.name,
          exchange: leg.exchangeSegment,
          secId: leg.securityId,
          ltp: leg.ltp,
          signal: leg.signal,
          rr: leg.rr,
          activeTimeframes: [],
          enabledFrames: {},
          enabledFramesList: [],
          primaryTimeframe: leg.primaryTimeframe,
          primarySignal: 'WAIT'
        });
      }
      const row = symbolMap.get(leg.symbol);
      row.activeTimeframes = row.activeTimeframes || [];
      row.enabledFrames[leg.frame] = leg.enabled;
      row.enabledFramesList = row.enabledFramesList || [];
      row.primaryTimeframe = leg.primaryTimeframe;
      if (leg.enabled && Number(leg.ltp) > 0 && (!Number(row.ltp) || leg.primary)) {
        row.ltp = leg.ltp;
      }
      if (leg.primary) row.primarySignal = leg.signal;
      if (leg.enabled) {
        row.activeTimeframes.push(leg.frame);
        row.enabledFramesList.push(leg.frame);
      }
      row.signal = row.primarySignal || 'WAIT';
      row.rr = leg.primary ? leg.rr : row.rr;
    }

    return {
      mode: stateStore.getState().mode || 'LIVE',
      replayRange: stateStore.getState().replayRange || { from: null, to: null },
      runnerState: stateStore.getState().runnerState,
      connectionState: stateStore.getState().connectionState,
      startedAt: stateStore.getState().startedAt,
      lastUpdatedAt: stateStore.getState().lastUpdatedAt,
      symbols: Array.from(symbolMap.values()).sort((a, b) => a.symbol.localeCompare(b.symbol)),
      legs: snapshotLegs
    };
  }

  function emitState() {
    const snapshot = refreshSnapshot();
    stateStore.patch(snapshot);
    if (events) events.emit('status', snapshot);
  }

  async function start(options = {}) {
    if (stateStore.getState().runnerState === 'RUNNING') return getStatus();
    const isPaused = stateStore.getState().runnerState === 'PAUSED';

    if (!isPaused && options.activeFrames && options.activeFrames.length) {
      activeFrameFilter = new Set(options.activeFrames);
    } else if (!isPaused) {
      activeFrameFilter = null;
    }

    if (!isPaused && options.tradeMode) {
      tradeMode = options.tradeMode;
    }

    if (!isPaused) {
      watchlist = selectionService.loadWatchlist();
      if (!watchlist.symbols.length) {
        const defaultWatchlist = selectionService.buildDefaultWatchlist(catalog);
        selectionService.saveWatchlist(defaultWatchlist);
        watchlist = defaultWatchlist;
      }
      if (options.watchlist) {
        watchlist = options.watchlist;
        selectionService.saveWatchlist(watchlist);
      }
      buildSelectionMap(watchlist);
      rebuildLegs();
      if (tradeMode === 'CARRY_FORWARD') restoreActiveTrades();
    }

    stateStore.patch({ runnerState: 'RUNNING', startedAt: stateStore.getState().startedAt || Date.now() });

    if (isPaused && typeof feedService.resume === 'function') {
      feedService.resume();
    } else {
      subscribeFeed();
    }

    startLoops();
    emitState();
    return getStatus();
  }

  function startLoops() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (eodTimer) clearInterval(eodTimer);

    refreshTimer = setInterval(() => {
      refreshDueCandles().catch((err) => console.error(err));
    }, env.candleRefreshMs);

    // Bug 7: in REPLAY mode every tick already calls emitState, so the snapshot
    // timer would only add redundant SSE events and worsen the render flood
    if (stateStore.getState().mode !== 'REPLAY') {
      snapshotTimer = setInterval(() => {
        emitState();
      }, Math.max(1000, env.liveRefreshMs));

      // EOD handler — fires once between 15:30–16:00 IST
      let eodFired = false;
      eodTimer = setInterval(() => {
        const hhmm = getISTHHMM();
        if (hhmm >= 1528 && hhmm < 1600 && !eodFired) {
          eodFired = true;
          if (tradeMode === 'INTRADAY') {
            closeAllAtEOD();
          } else if (tradeMode === 'CARRY_FORWARD') {
            persistActiveTrades();
            console.log('[runner] Carry-forward trades saved for tomorrow.');
          }
        }
        if (hhmm >= 1600) eodFired = false;
      }, 60 * 1000);
    }
  }

  function pause() {
    stateStore.patch({ runnerState: 'PAUSED' });
    if (refreshTimer) clearInterval(refreshTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (eodTimer) clearInterval(eodTimer);
    refreshTimer = null;
    snapshotTimer = null;
    eodTimer = null;
    // Bug 5: use feedService.pause() to preserve the client and playback index
    if (typeof feedService.pause === 'function') {
      feedService.pause();
    } else {
      feedService.stop();
    }
    emitState();
    return getStatus();
  }

  function reset() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (snapshotTimer) clearInterval(snapshotTimer);
    if (eodTimer) clearInterval(eodTimer);
    refreshTimer = null;
    snapshotTimer = null;
    eodTimer = null;
    feedService.stop(); // fires onFeedState synchronously first
    // Bug 3: re-apply correct connectionState after feedService.stop() may have
    // overridden it with 'REPLAY_STOPPED' via the 'close' event callback
    const mode = stateStore.getState().mode;
    stateStore.patch({
      runnerState: 'IDLE',
      startedAt: null,
      connectionState: mode === 'REPLAY' ? 'REPLAY_READY' : 'DISCONNECTED'
    });
    rebuildLegs();
    emitState();
    return getStatus();
  }

  function updateSelection({ symbol, enabledFrames = [], primaryTimeframe }) {
    const current = selectionService.loadWatchlist();
    const row = current.symbols.find((item) => item.symbol === symbol);
    if (!row) return getStatus();
    row.enabledFrames = Array.from(new Set(enabledFrames));
    if (primaryTimeframe) row.primaryTimeframe = primaryTimeframe;
    selectionService.saveWatchlist(current);
    refreshCatalog();
    if (stateStore.getState().runnerState === 'RUNNING') {
      feedService.stop();
      subscribeFeed();
    }
    emitState();
    return getStatus();
  }

  function getStatus() {
    return refreshSnapshot();
  }

  const events = {
    _listeners: new Map(),
    on(event, handler) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(handler);
    },
    off(event, handler) {
      this._listeners.get(event)?.delete(handler);
    },
    emit(event, payload) {
      for (const handler of this._listeners.get(event) || []) handler(payload);
    }
  };

  return {
    setMode,
    setReplayRange,
    start,
    pause,
    reset,
    updateSelection,
    getStatus,
    emitState,
    on: events.on.bind(events),
    off: events.off.bind(events),
    handlePacket,
    onFeedState,
    refreshCatalog,
    getLegBySymbolFrame
  };
}

module.exports = { createRunner };
