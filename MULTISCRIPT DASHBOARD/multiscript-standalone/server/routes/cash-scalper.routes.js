const express = require('express');

function createCashScalperRoutes({ cashScalperService }) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    try {
      res.json(cashScalperService.getState());
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const push = (state) => {
      res.write(`event: status\ndata: ${JSON.stringify(state)}\n\n`);
    };
    push(cashScalperService.getState());
    cashScalperService.on('status', push);
    req.on('close', () => cashScalperService.off('status', push));
  });

  router.get('/symbols/search', (req, res) => {
    try {
      res.json({ rows: cashScalperService.searchSymbols(req.query.q || '') });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/symbols/refresh-master', (req, res) => {
    try {
      const rows = cashScalperService.buildSymbolMasterFromCsv();
      res.json({ ok: true, count: rows.length });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/settings', (req, res) => {
    try {
      res.json(cashScalperService.updateSettings(req.body || {}));
    } catch (err) {
      res.status(400).json({ ok: false, message: err.message });
    }
  });

  router.post('/symbols', (req, res) => {
    try {
      res.json(cashScalperService.upsertSymbol(req.body || {}));
    } catch (err) {
      res.status(400).json({ ok: false, message: err.message });
    }
  });

  router.delete('/symbols/:symbol', (req, res) => {
    try {
      res.json(cashScalperService.removeSymbol(req.params.symbol));
    } catch (err) {
      res.status(400).json({ ok: false, message: err.message });
    }
  });

  router.post('/paper-trade', (req, res) => {
    try {
      res.json(cashScalperService.recordPaperTrade(req.body || {}));
    } catch (err) {
      res.status(400).json({ ok: false, message: err.message });
    }
  });

  router.post('/strategy/refresh', async (req, res) => {
    try {
      res.json(await cashScalperService.refreshStrategies(req.body?.symbols || null));
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/connect', (req, res) => {
    try {
      res.json(cashScalperService.startLive());
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/disconnect', (req, res) => {
    try {
      res.json(cashScalperService.stopLive());
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  return router;
}

module.exports = { createCashScalperRoutes };
