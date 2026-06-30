const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { env } = require('./config/env');
const appConfig = require('./config/app.config');
const exchangeConfig = require('./config/exchange.config');
const { createStateStore } = require('./storage/state.store');
const { CacheStore } = require('./storage/cache.store');
const { createSelectionStore } = require('./storage/selection.store');
const { createSelectionService } = require('./services/selection.service');
const { createCandleService } = require('./services/candle.service');
const { createFeedService } = require('./services/feed.service');
const { createTradeService } = require('./services/trade.service');
const { createStatusService } = require('./services/status.service');
const { createExportService } = require('./services/export.service');
const { TradeLogger } = require('./logging/trade.logger');
const { createMultiscriptRoutes } = require('./routes/multiscript.routes');
const { createHealthRoutes } = require('./routes/health.routes');
const { createDhanRestClient } = require('./adapters/dhan/dhan.rest.client');
const { createRunner } = require('./engines/runner.engine');
const { ReplayRepository } = require('./services/replay.repository');
const { getLoggingConfig } = require('./config/logging.config');
const timeframeConfig = require('./config/timeframe.config');

async function createApp() {
  const app = express();
  const stateStore = createStateStore({ mode: env.defaultMode });
  const cacheStore = new CacheStore();
  const selectionService = createSelectionService({ rootDir: env.rootDir, maxPerFrame: appConfig.defaultActivePerFrame });
  const selectionStore = createSelectionStore(selectionService.watchlistFile);
  const runtimeConfig = selectionService.loadRuntimeConfig();
  stateStore.patch({
    replayRange: runtimeConfig.replayRange || { from: null, to: null }
  });
  const restClient = createDhanRestClient(exchangeConfig.dhan);
  const replayRepository = new ReplayRepository({
    sourceDir: env.replaySourceDir,
    cacheDir: env.replayCacheDir,
    lookbackDays: env.replayLookbackDays,
    speedMultiplier: env.replaySpeedMultiplier
  });
  let runner;
  let currentLoggingConfig = getLoggingConfig(stateStore.getState().mode);
  const sessionFile = path.join(env.dataDir, 'session.json');

  function todayIST() {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 10);
  }

  function loadSessionDate() {
    try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')).date || ''; } catch { return ''; }
  }

  function saveSessionDate(date) {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ date }), 'utf8');
  }

  async function resetLiveExcels() {
    const config = getLoggingConfig('LIVE');
    for (const item of timeframeConfig) {
      const file = config.tradeFiles[item.key];
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      const logger = new TradeLogger({ workbookFile: file, timeframe: item.key });
      await logger.init();
    }
    console.log('[session] Live Excel files reset for new day.');
  }

  let currentTradeLoggers = {};
  async function rebuildTradeLoggers(mode) {
    currentLoggingConfig = getLoggingConfig(mode);
    const next = {};
    for (const item of timeframeConfig) {
      next[item.key] = new TradeLogger({
        workbookFile: currentLoggingConfig.tradeFiles[item.key],
        timeframe: item.key
      });
      await next[item.key].init();
    }
    currentTradeLoggers = next;
  }

  await rebuildTradeLoggers(stateStore.getState().mode);

  const feedService = createFeedService({
    exchangeConfig,
    replayRepository,
    getMode: () => stateStore.getState().mode,
    getReplayRange: () => stateStore.getState().replayRange,
    onPacket: (packet) => runner.handlePacket(packet),
    onState: (state) => runner.onFeedState(state)
  });
  const candleService = createCandleService({
    restClient,
    replayRepository,
    cacheStore,
    getMode: () => stateStore.getState().mode,
    getReplayRange: () => stateStore.getState().replayRange,
    getReplayNow: () => feedService.getReplayNow()
  });
  const tradeService = createTradeService({
    capital: env.capital,
    getTradeLogger(timeframe) {
      return currentTradeLoggers[timeframe] || currentTradeLoggers['15'];
    }
  });

  runner = createRunner({
    env,
    stateStore,
    cacheStore,
    selectionService,
    candleService,
    feedService,
    tradeService,
    onModeChange: async (mode) => {
      await rebuildTradeLoggers(mode);
      feedService.setMode(mode);
    }
  });
  runner.refreshCatalog();

  const exportService = createExportService({
    runner,
    getLoggingConfig: () => currentLoggingConfig
  });
  const statusService = createStatusService({ runner });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Auto-reset live Excel files on first Start of each trading day
  // Skip reset if carry-forward trades are pending (they belong to the new day's Excel)
  app.use('/api/multiscript/start', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    const mode = String(stateStore.getState().mode || 'LIVE').toUpperCase();
    const tradeMode = req.body?.tradeMode || 'INTRADAY';
    if (mode === 'LIVE') {
      const today = todayIST();
      const hasCarryForward = fs.existsSync(path.join(env.dataDir, 'active-trades.json'));
      if (loadSessionDate() !== today && !hasCarryForward) {
        await resetLiveExcels();
        await rebuildTradeLoggers('LIVE');
        saveSessionDate(today);
      } else if (loadSessionDate() !== today && hasCarryForward) {
        // New day with carry-forward — reset Excel but keep the carry-forward file for runner to restore
        await resetLiveExcels();
        await rebuildTradeLoggers('LIVE');
        saveSessionDate(today);
        console.log('[session] New day with carry-forward positions — Excel reset, trades will be restored.');
      }
    }
    next();
  });

  app.get('/api/multiscript/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: ping\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const push = (snapshot) => {
      res.write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    runner.on('status', push);
    req.on('close', () => runner.off('status', push));
  });

  app.use('/api/health', createHealthRoutes({ runner }));
  app.use('/api/multiscript', createMultiscriptRoutes({ runner, exportService, statusService }));
  app.use(express.static(env.clientDir));

  app.get('*', (req, res) => {
    res.sendFile(path.join(env.clientDir, 'index.html'));
  });

  return { app, runner, selectionStore, statusService };
}

async function startServer() {
  const { app, runner } = await createApp();
  const server = app.listen(env.port, env.host, () => {
    console.log(`${appConfig.appName} listening at http://${env.host}:${env.port}`);
    if (env.autoStart) {
      runner.start().catch((err) => console.error(err));
    }
  });
  return { app, server, runner };
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp, startServer };
