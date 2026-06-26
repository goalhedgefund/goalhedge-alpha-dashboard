// ── CLAUDE Scalping — Excel Export Helper ─────────────────────────────────────
'use strict';

const ExcelJS = require('exceljs');

/**
 * Builds an .xlsx workbook from a trade list and returns it as a Buffer,
 * ready to stream as an HTTP response. One sheet of trade-by-trade detail,
 * one summary sheet with aggregate stats.
 *
 * @param {object} opts
 *   opts.trades   - array of trade objects (dir, entry, exit, result, rMultiple, score, entryTs, exitTs, cashPnl, grossCashPnl, exchangeCost, riskPerTrade, qty, turnover)
 *   opts.symbol   - stock symbol, used in the title and filename
 *   opts.title    - sheet/report title, e.g. "Backtest — Baseline (2:1)" or "Optimizer — Best Config (3:1)"
 *   opts.meta     - optional extra key/value pairs to show in a small info block (date range, timeframe, config, etc.)
 */
async function buildTradeWorkbook({ trades, symbol, title, meta }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CLAUDE Scalping System';
  wb.created = new Date();

  // ── Trade detail sheet ──────────────────────────────────────────────────────
  const sheet = wb.addWorksheet('Trades', { views: [{ state: 'frozen', ySplit: meta ? 4 + Object.keys(meta).length + 1 : 4 }] });

  sheet.mergeCells('A1:O1');
  sheet.getCell('A1').value = `${symbol} — ${title}`;
  sheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1A1A2E' } };
  sheet.getCell('A1').alignment = { horizontal: 'left' };

  sheet.getCell('A2').value = `Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  sheet.getCell('A2').font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  let row = 4;
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      sheet.getCell(`A${row}`).value = k;
      sheet.getCell(`A${row}`).font = { bold: true, size: 10 };
      sheet.getCell(`B${row}`).value = String(v);
      sheet.getCell(`B${row}`).font = { size: 10 };
      row++;
    }
    row++; // blank spacer row
  }

  const headerRow = row;
  const headers = ['#', 'Direction', 'Entry Price', 'Exit Price', 'R Multiple', 'Gross ₹ P&L', 'Exchange Cost', 'Net ₹ P&L', 'Risk / Trade', 'Qty', 'Turnover', 'Result', 'Indicators (/8)', 'Entry Time', 'Exit Time'];
  headers.forEach((h, i) => {
    const cell = sheet.getCell(headerRow, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A2B4C' } };
    cell.alignment = { horizontal: 'center' };
  });

  trades.forEach((t, i) => {
    const r = headerRow + 1 + i;
    const won = t.result === 'WIN';
    const grossCashPnl = Number.isFinite(Number(t.grossCashPnl)) ? Number(t.grossCashPnl) : (Number(t.cashPnl) || 0) + (Number(t.exchangeCost) || 0);
    const exchangeCost = Number(t.exchangeCost) || 0;
    const cashPnl = Number(t.cashPnl) || 0;
    const riskPerTrade = Number(t.riskPerTrade) || 0;
    const qty = Number(t.qty) || 0;
    const turnover = Number(t.turnover) || 0;
    sheet.getCell(r, 1).value = i + 1;
    sheet.getCell(r, 2).value = t.dir;
    sheet.getCell(r, 3).value = +Number(t.entry).toFixed(2);
    sheet.getCell(r, 4).value = +Number(t.exit).toFixed(2);
    sheet.getCell(r, 5).value = +Number(t.rMultiple).toFixed(2);
    sheet.getCell(r, 5).font = { color: { argb: won ? 'FF1D9E75' : 'FFE24B4A' }, bold: true };
    sheet.getCell(r, 6).value = grossCashPnl;
    sheet.getCell(r, 6).numFmt = '₹#,##0.00;[Red]-₹#,##0.00';
    sheet.getCell(r, 6).font = { color: { argb: grossCashPnl >= 0 ? 'FF1D9E75' : 'FFE24B4A' }, bold: true };
    sheet.getCell(r, 7).value = exchangeCost;
    sheet.getCell(r, 7).numFmt = '₹#,##0.00;[Red]-₹#,##0.00';
    sheet.getCell(r, 7).font = { color: { argb: 'FFE24B4A' }, bold: true };
    sheet.getCell(r, 8).value = cashPnl;
    sheet.getCell(r, 8).numFmt = '₹#,##0.00;[Red]-₹#,##0.00';
    sheet.getCell(r, 8).font = { color: { argb: cashPnl >= 0 ? 'FF1D9E75' : 'FFE24B4A' }, bold: true };
    sheet.getCell(r, 9).value = riskPerTrade;
    sheet.getCell(r, 9).numFmt = '₹#,##0.00';
    sheet.getCell(r, 10).value = qty;
    sheet.getCell(r, 11).value = turnover;
    sheet.getCell(r, 11).numFmt = '₹#,##0.00';
    sheet.getCell(r, 12).value = t.result;
    sheet.getCell(r, 12).font = { color: { argb: won ? 'FF1D9E75' : 'FFE24B4A' } };
    sheet.getCell(r, 13).value = t.score != null ? `${t.score}/8` : '—';
    sheet.getCell(r, 14).value = t.entryTs ? formatTs(t.entryTs) : '—';
    sheet.getCell(r, 15).value = t.exitTs ? formatTs(t.exitTs) : '—';
  });

  sheet.columns = [
    { width: 6 }, { width: 11 }, { width: 13 }, { width: 13 },
    { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 },
    { width: 14 }, { width: 9 }, { width: 14 }, { width: 10 },
    { width: 14 }, { width: 20 }, { width: 20 }
  ];

  // ── Summary sheet ────────────────────────────────────────────────────────────
  const sum = wb.addWorksheet('Summary');
  const total = trades.length;
  const wins = trades.filter(t => t.result === 'WIN').length;
  const losses = total - wins;
  const pnlR = trades.reduce((s, t) => s + (Number(t.rMultiple) || 0), 0);
  const expectancy = total ? pnlR / total : 0;
  const totalGrossCashPnl = trades.reduce((s, t) => s + (Number.isFinite(Number(t.grossCashPnl)) ? Number(t.grossCashPnl) : ((Number(t.cashPnl) || 0) + (Number(t.exchangeCost) || 0))), 0);
  const totalExchangeCost = trades.reduce((s, t) => s + (Number(t.exchangeCost) || 0), 0);
  const totalCashPnl = trades.reduce((s, t) => s + (Number(t.cashPnl) || 0), 0);
  const cashExpectancy = total ? totalCashPnl / total : 0;
  const grossCashExpectancy = total ? totalGrossCashPnl / total : 0;
  let peak = 0, cum = 0, maxDD = 0;
  let cashPeak = 0, cashCum = 0, cashMaxDD = 0;
  trades.forEach(t => { cum += Number(t.rMultiple) || 0; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDD) maxDD = dd; });
  trades.forEach(t => { cashCum += Number(t.cashPnl) || 0; if (cashCum > cashPeak) cashPeak = cashCum; const dd = cashPeak - cashCum; if (dd > cashMaxDD) cashMaxDD = dd; });

  const stats = [
    ['Symbol', symbol],
    ['Report', title],
    ['Total trades', total],
    ['Wins', wins],
    ['Losses', losses],
    ['Win rate', total ? (wins / total * 100).toFixed(2) + '%' : '—'],
    ['Total P&L (R)', pnlR.toFixed(2) + 'R'],
    ['Expectancy (R/trade)', expectancy.toFixed(3) + 'R'],
    ['Max drawdown (R)', maxDD.toFixed(2) + 'R'],
    ['Gross P&L (₹)', formatCash(totalGrossCashPnl)],
    ['Exchange cost (₹)', formatCash(totalExchangeCost)],
    ['Net P&L (₹)', formatCash(totalCashPnl)],
    ['Gross expectancy (₹/trade)', formatCash(grossCashExpectancy)],
    ['Net expectancy (₹/trade)', formatCash(cashExpectancy)],
    ['Max drawdown (₹)', formatCash(cashMaxDD)]
  ];
  stats.forEach((row2, i) => {
    sum.getCell(i + 1, 1).value = row2[0];
    sum.getCell(i + 1, 1).font = { bold: true };
    sum.getCell(i + 1, 2).value = row2[1];
  });
  sum.columns = [{ width: 22 }, { width: 28 }];

  return wb.xlsx.writeBuffer();
}

function formatTs(ts) {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatCash(value) {
  const n = Number(value) || 0;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

module.exports = { buildTradeWorkbook };
