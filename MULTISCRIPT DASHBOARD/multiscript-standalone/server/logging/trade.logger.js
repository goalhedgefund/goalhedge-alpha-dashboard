const fs = require('node:fs');
const path = require('node:path');
const { loadOrCreateWorkbook, saveWorkbook, ensureDir } = require('./excel.writer');

const HEADERS = [
  'TradeId',
  'Symbol',
  'Timeframe',
  'Side',
  'EntryTime',
  'EntryPrice',
  'ExitTime',
  'ExitPrice',
  'Quantity',
  'GrossPnL',
  'Costs',
  'NetPnL',
  'Outcome',
  'Signal',
  'RR',
  'KellyFraction',
  'Notes'
];

class TradeLogger {
  constructor({ workbookFile, timeframe, defaultSheet = 'Trades' }) {
    this.workbookFile = workbookFile;
    this.timeframe = timeframe;
    this.defaultSheet = defaultSheet;
    this._queue = Promise.resolve();
  }

  async init() {
    await ensureDir(this.workbookFile);
    if (!fs.existsSync(this.workbookFile)) {
      const { workbook, sheet } = await loadOrCreateWorkbook(this.workbookFile, this.defaultSheet);
      sheet.addRow(HEADERS);
      workbook.addWorksheet('Daily Summary').addRow(['Date', 'Trades', 'GrossPnL', 'Costs', 'NetPnL']);
      await saveWorkbook(workbook, this.workbookFile);
    }
  }

  enqueue(task) {
    this._queue = this._queue.then(task).catch((err) => {
      console.error(`Trade logger error for ${this.workbookFile}`, err);
    });
    return this._queue;
  }

  async appendTradeRow(row) {
    await this.init();
    return this.enqueue(async () => {
      const { workbook, sheet } = await loadOrCreateWorkbook(this.workbookFile, this.defaultSheet);
      if (sheet.rowCount === 0) sheet.addRow(HEADERS);
      sheet.addRow([
        row.tradeId,
        row.symbol,
        row.timeframe,
        row.side,
        row.entryTime,
        row.entryPrice,
        row.exitTime || '',
        row.exitPrice || '',
        row.quantity,
        row.grossPnl || 0,
        row.costs || 0,
        row.netPnl || 0,
        row.outcome || 'OPEN',
        row.signal || '',
        row.rr || '',
        row.kellyFraction || '',
        row.notes || ''
      ]);
      await saveWorkbook(workbook, this.workbookFile);
    });
  }

  async updateDailySummary(summary) {
    await this.init();
    return this.enqueue(async () => {
      const { workbook } = await loadOrCreateWorkbook(this.workbookFile, this.defaultSheet);
      let sheet = workbook.getWorksheet('Daily Summary');
      if (!sheet) sheet = workbook.addWorksheet('Daily Summary');
      if (sheet.rowCount === 0) sheet.addRow(['Date', 'Trades', 'GrossPnL', 'Costs', 'NetPnL']);
      sheet.addRow([
        summary.date,
        summary.trades,
        summary.grossPnL,
        summary.costs,
        summary.netPnL
      ]);
      await saveWorkbook(workbook, this.workbookFile);
    });
  }
}

module.exports = { TradeLogger };
