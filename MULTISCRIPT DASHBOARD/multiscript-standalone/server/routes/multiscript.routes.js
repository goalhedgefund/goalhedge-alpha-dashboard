const express = require('express');
const fs = require('node:fs');
const ExcelJS = require('exceljs');

function createMultiscriptRoutes({ runner, exportService, inventoryService }) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    try {
      res.json(runner.getStatus());
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/start', async (req, res) => {
    try {
      const result = await runner.start(req.body || {});
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/pause', (req, res) => {
    try {
      res.json(runner.pause());
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/reset', (req, res) => {
    try {
      res.json(runner.reset());
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/mode', async (req, res) => {
    try {
      const mode = req.body?.mode || req.query.mode || 'LIVE';
      if (req.body?.replayRange) {
        await runner.setReplayRange(req.body.replayRange);
      }
      const result = await runner.setMode(mode);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/range', async (req, res) => {
    try {
      const result = await runner.setReplayRange(req.body?.replayRange || req.body || {});
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/selection', (req, res) => {
    try {
      const status = runner.updateSelection(req.body || {});
      res.json(status);
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.get('/inventory', (req, res) => {
    try {
      res.json(inventoryService.getPlan());
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/inventory', (req, res) => {
    try {
      res.json(inventoryService.save(req.body || {}));
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  router.post('/inventory/paper-trade', (req, res) => {
    try {
      res.json(inventoryService.recordPaperTrade(req.body || {}));
    } catch (err) {
      res.status(400).json({ ok: false, message: err.message });
    }
  });

  // Parse IST datetime string from Excel ("2026-06-29 13:33:33") explicitly as IST
  function parseISTString(str) {
    if (!str) return null;
    const ts = new Date(String(str).replace(' ', 'T') + '+05:30').getTime();
    return isNaN(ts) ? null : ts;
  }

  router.get('/trades', async (req, res) => {
    const { from, to, timeframe } = req.query;
    const loggingConfig = exportService.getLoggingConfig ? exportService.getLoggingConfig() : null;
    const tradeFiles = loggingConfig?.tradeFiles || {};
    const keys = timeframe && timeframe !== 'all' ? [timeframe] : Object.keys(tradeFiles);
    const fromTs = from ? new Date(from).getTime() : null;
    const toTs = to ? new Date(to).getTime() : null;
    const rows = [];
    const HEADERS = ['TradeId','Symbol','Timeframe','Side','EntryTime','ExitTime','EntryPrice','ExitPrice','Quantity','GrossPnL','Costs','NetPnL','Outcome','Signal','RR','KellyFraction','Notes'];
    for (const key of keys) {
      const file = tradeFiles[key];
      if (!file || !fs.existsSync(file)) continue;
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(file);
        const sheet = wb.getWorksheet('Trades');
        if (!sheet) continue;
        let headerRow = null;
        sheet.eachRow((row, i) => {
          if (i === 1) { headerRow = row.values.slice(1); return; }
          const vals = row.values.slice(1);
          const obj = {};
          (headerRow || HEADERS).forEach((h, idx) => { obj[h] = vals[idx] ?? ''; });
          const entryTs = parseISTString(obj.EntryTime);
          if (fromTs && entryTs && entryTs < fromTs) return;
          if (toTs && entryTs && entryTs > toTs) return;
          rows.push(obj);
        });
      } catch (e) { /* skip unreadable file */ }
    }
    rows.sort((a, b) => (a.EntryTime > b.EntryTime ? -1 : 1));
    res.json({ rows, total: rows.length });
  });

  router.get('/export', async (req, res) => {
    const frame = req.query.timeframe || '15';
    const filePath = exportService.getExportPath(frame);
    if (fs.existsSync(filePath)) {
      return res.download(filePath);
    }
    res.status(404).json({ ok: false, timeframe: frame, filePath, message: 'Workbook not found yet.' });
  });

  return router;
}

module.exports = { createMultiscriptRoutes };
