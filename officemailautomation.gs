const CONFIG = {
  spreadsheetId: '1ErMVhtWcoCpDjMhIqwKIMRfq-qY_p6x5T7N1rMxnouI',
  senderQuery: 'from:("RAJESH PAUL") has:attachment newer_than:7d',

  cashFileName: 'PARESH CASH.xlsx',
  rawSheetName: 'RAW',
  dashboardSheetName: 'DASHBOARD',
  accountCode: '3094',
  accountCodeColumnNumber: 1,
  stockQtyColumnNumber: 5,

  foFileNameContains: 'PARESH OP',
  foSheetName: 'FO SUMMARY',
  foStartText: '3094 - VISHAL',
  foEndText: 'For OptionBuyer, Profit is relavent',
  netBalanceText: 'Net Balance (IM+MTM/Prem) amount Due to Us',

  cashSummarySheetName: 'PS',
  nameHeader: 'A/C Name',
  clientPlHeader: 'Client P/L (Total)',
  tradeAmountHeader: 'Trade Amt at Closing Rate',
};

function runDailyImportsAtNight() {
  importPareshCashToRaw();
  importPareshCashToDashboard();
  importPareshOpSummary();
  importCashPositionSummary();
}

function importPareshCashToRaw() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = getOrCreateSheet_(ss, CONFIG.rawSheetName);
  const attachment = getLatestAttachment_(CONFIG.senderQuery + ' filename:"PARESH CASH.xlsx"', CONFIG.cashFileName, false);

  if (!attachment) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue('PARESH CASH.xlsx not found.');
    return;
  }

  const values = readXlsxValues_(attachment);
  const header = values[0] || [];
  if (!header.length) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue('No header row found in PARESH CASH.xlsx.');
    return;
  }

  const rows = values
    .slice(1)
    .filter(row => String(row[CONFIG.accountCodeColumnNumber - 1]).trim() === CONFIG.accountCode)
    .map(row => {
      const outputRow = [...row];
      const stockQtyIndex = CONFIG.stockQtyColumnNumber - 1;
      const stockQty = Number(outputRow[stockQtyIndex]);
      if (!isNaN(stockQty)) outputRow[stockQtyIndex] = stockQty * -1;
      return outputRow;
    });

  sheet.clearContents();

  writeValues_(sheet, [header, ...rows]);
}

function importPareshCashToDashboard() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = getOrCreateSheet_(ss, CONFIG.dashboardSheetName);
  const attachment = getLatestAttachment_(CONFIG.senderQuery + ' filename:"PARESH CASH.xlsx"', CONFIG.cashFileName, false);

  if (!attachment) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue('PARESH CASH.xlsx not found.');
    return;
  }

  const values = readXlsxValues_(attachment);
  const header = buildDashboardHeader_(values[0] || []);
  if (!header.length) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue('No header row found in PARESH CASH.xlsx.');
    return;
  }

  const rows = values
    .slice(1)
    .filter(row => String(row[CONFIG.accountCodeColumnNumber - 1]).trim() === CONFIG.accountCode)
    .filter(row => isDashboardDataRow_(row))
    .map((row, index) => buildDashboardRow_(row, index + 2));
  const calcTotals = getDashboardCalcTotals_(rows);

  sheet.clearContents();

  writeValues_(sheet, [header.map((value, index) => {
    if (index === 6) return `Calc1 ${formatAmount_(calcTotals.calc1)}`;
    if (index === 7) return `Calc2 ${formatAmount_(calcTotals.calc2)}`;
    return value;
  }), ...(rows.length ? rows : [new Array(header.length).fill('')])]);
}

function importPareshOpSummary() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = getOrCreateSheet_(ss, CONFIG.foSheetName);
  const attachment = getLatestAttachment_(CONFIG.senderQuery, CONFIG.foFileNameContains, true);

  if (!attachment) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue(`Attachment containing "${CONFIG.foFileNameContains}" not found.`);
    return;
  }

  const text = attachment.getDataAsString();
  const sectionText = extractFoSection_(text);
  const summary = summarizeFoPositions_(sectionText);
  const netBalance = parseNetBalance_(sectionText);
  const result = buildFoOutput_(summary.futureRows, summary.optionRows, netBalance);

  sheet.clearContents();

  if (!result.output.length) {
    sheet.getRange(1, 1).setValue('No F&O data found.');
    return;
  }

  writeValues_(sheet, result.output);

  sheet.getRange(1, 1, sheet.getMaxRows(), 6).setFontWeight('normal');
  sheet.getRange(1, 1, 1, 6).setFontWeight('bold');

  if (result.totalExposureRow) sheet.getRange(result.totalExposureRow, 6).setFontWeight('bold');
  if (result.netPremiumRow) sheet.getRange(result.netPremiumRow, 6).setFontWeight('bold');
  if (result.netBalanceRow) sheet.getRange(result.netBalanceRow, 4, 1, 3).setFontWeight('bold');
}

function importCashPositionSummary() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = getOrCreateSheet_(ss, CONFIG.cashSummarySheetName);
  const attachment = getLatestAttachment_(CONFIG.senderQuery + ' filename:"PARESH CASH.xlsx"', CONFIG.cashFileName, false);

  if (!attachment) {
    sheet.clearContents();
    sheet.getRange(1, 1).setValue('PARESH CASH.xlsx not found.');
    return;
  }

  const values = readXlsxValues_(attachment);
  const output = buildCashSummary_(values);

  sheet.clearContents();

  if (!output.length) {
    sheet.getRange(1, 1).setValue('No cash summary data found.');
    return;
  }

  writeValues_(sheet, output);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  sheet.getRange(output.length, 1, 1, 3).setFontWeight('bold');
  sheet.autoResizeColumns(1, 3);
}

function getLatestAttachment_(gmailQuery, attachmentName, useContains) {
  const threads = GmailApp.search(gmailQuery, 0, 10);
  if (!threads.length) return null;

  const latestMessage = getLatestMessage_(threads);
  const target = attachmentName.toLowerCase();

  return latestMessage.getAttachments().find(file => {
    const name = file.getName().trim().toLowerCase();
    return useContains ? name.includes(target) : name === target;
  });
}

function getLatestMessage_(threads) {
  let latestMessage = null;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      if (!latestMessage || message.getDate() > latestMessage.getDate()) {
        latestMessage = message;
      }
    });
  });

  return latestMessage;
}

function readXlsxValues_(blob) {
  const tempFile = Drive.Files.create(
    {
      name: blob.getName(),
      mimeType: MimeType.GOOGLE_SHEETS,
    },
    blob,
    {
      convert: true,
    }
  );

  const tempSpreadsheet = SpreadsheetApp.openById(tempFile.id);
  const values = tempSpreadsheet.getSheets()[0].getDataRange().getValues();

  DriveApp.getFileById(tempFile.id).setTrashed(true);
  return values;
}

function extractFoSection_(text) {
  const startIndex = text.indexOf(CONFIG.foStartText);
  if (startIndex === -1) throw new Error(`Could not find: ${CONFIG.foStartText}`);

  const endIndex = text.indexOf(CONFIG.foEndText, startIndex);
  if (endIndex === -1) throw new Error(`Could not find: ${CONFIG.foEndText}`);

  return text.substring(startIndex, endIndex);
}

function summarizeFoPositions_(sectionText) {
  const futureRows = [];
  const optionRows = [];
  const columnPositions = getFoColumnPositions_(sectionText);

  sectionText.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();

    if (trimmed.startsWith('SF ')) {
      const row = parseFutureLine_(line, columnPositions);
      if (row) futureRows.push(row);
    }

    if (/^(SO|IO)\s+/.test(trimmed)) {
      const row = parseOptionLine_(line, columnPositions);
      if (row) optionRows.push(row);
    }
  });

  return { futureRows, optionRows };
}

function parseFutureLine_(line, columnPositions) {
  const match = line.trim().match(/^SF\s+([A-Z0-9-]+?)(\d{2}[A-Z]{3}FUT)\s+\d{2}\/[A-Za-z]{3}/);
  if (!match) return null;

  const scrip = match[1];
  const qty = parseFoSignedQuantity_(line, columnPositions);
  if (!qty) return null;

  const close = parseFoSeriesClose_(line);
  const value = qty * close;

  return [qty, scrip, close, value];
}

function parseOptionLine_(line, columnPositions) {
  const match = line.trim().match(/^(SO|IO)\s+([A-Z0-9-]+?)(\d{2}[A-Z]{3})(PE|CE)\s+(PE|CE)\s+\d{2}\/[A-Za-z]{3}/);
  if (!match) return null;

  const baseScrip = match[2];
  const optionType = match[4];
  const qty = parseFoSignedQuantity_(line, columnPositions);
  if (!qty) return null;

  const close = parseFoSeriesClose_(line);
  const strike = parseFoStrike_(line);
  const scrip = `${baseScrip} ${strike}${optionType}`;
  const value = qty * close;

  return [qty, scrip, close, value];
}

function getFoColumnPositions_(sectionText) {
  const headerLine = sectionText.split(/\r?\n/).find(line => line.includes('Bought') && line.includes('Sold') && line.includes('Net'));
  if (!headerLine) return null;

  return {
    boughtStart: headerLine.indexOf('Bought'),
    soldStart: headerLine.indexOf('Sold'),
    netStart: headerLine.indexOf('Net'),
  };
}

function parseFoSignedQuantity_(line, columnPositions) {
  if (columnPositions && columnPositions.boughtStart !== -1 && columnPositions.soldStart !== -1 && columnPositions.netStart !== -1) {
    const boughtQty = parseFoQuantityCell_(line.slice(columnPositions.boughtStart, columnPositions.soldStart));
    const soldQty = parseFoQuantityCell_(line.slice(columnPositions.soldStart, columnPositions.netStart));

    if (boughtQty) return boughtQty * -1;
    if (soldQty) return soldQty;
  }

  const dateMatch = line.match(/\d{2}\/[A-Za-z]{3}/);
  const tail = dateMatch ? line.slice(dateMatch.index + dateMatch[0].length) : line;
  return parseFoQuantityCell_(tail);
}

function parseFoQuantityCell_(value) {
  const match = String(value || '').match(/[\d,]+/);
  return match ? parseNumber_(match[0]) : 0;
}

function parseFoSeriesClose_(line) {
  const numbers = getFoNumbersAfterDate_(line);
  return Math.round(parseNumber_(numbers[3] || 0));
}

function parseFoStrike_(line) {
  const numbers = getFoNumbersAfterDate_(line);
  return numbers[4] || '';
}

function getFoNumbersAfterDate_(line) {
  const dateMatch = line.match(/\d{2}\/[A-Za-z]{3}/);
  const tail = dateMatch ? line.slice(dateMatch.index + dateMatch[0].length) : line;
  return tail.match(/[\d,.]+/g) || [];
}

function buildFoOutput_(futureRows, optionRows, netBalance) {
  const output = [['Qty', 'Sold', 'Qnet', 'SCRIP', 'CLOSE', 'LTP']];

  futureRows.forEach(row => output.push(buildFoOutputRow_(row, output.length + 1)));

  const totalExposure = futureRows.reduce((total, row) => total + Number(row[3] || 0), 0);
  output.push(['', '', '', '', '', totalExposure]);
  const totalExposureRow = output.length;

  output.push(['', '', '', '', '', '']);

  optionRows.forEach(row => output.push(buildFoOutputRow_(row, output.length + 1)));

  const netPremium = optionRows.reduce((total, row) => total + Number(row[3] || 0), 0);
  output.push(['', '', '', '', '', netPremium]);
  const netPremiumRow = output.length;

  let netBalanceRow = null;

  if (netBalance) {
    output.push(['', '', '', '', '', '']);
    output.push([
      '',
      '',
      '',
      'Net Balance (IM+MTM/Prem)',
      '',
      netBalance.isDebit ? `(${formatAmount_(netBalance.amount)})` : formatAmount_(netBalance.amount),
    ]);
    netBalanceRow = output.length;
  }

  return { output, totalExposureRow, netPremiumRow, netBalanceRow };
}

function buildFoOutputRow_(row, rowNumber) {
  const qty = Number(row[0] || 0);
  const sold = 0;
  const qnet = `=A${rowNumber}-B${rowNumber}`;
  return [qty, sold, qnet, row[1], row[2], row[3]];
}

function buildDashboardHeader_(headerRow) {
  const outputRow = [];
  outputRow.push('Qty');
  outputRow.push('B/S');
  outputRow.push('QNet');
  outputRow.push('SCRIPT');
  outputRow.push('CLOSE');
  outputRow.push('LTP');
  outputRow.push('Calc1');
  outputRow.push('Calc2');
  return outputRow;
}

function buildDashboardRow_(row, rowNumber) {
  const outputRow = [...row];
  const stockQtyIndex = CONFIG.stockQtyColumnNumber - 1;
  const stockQty = Number(outputRow[stockQtyIndex]);
  const qty = isNaN(stockQty) ? parseNumber_(outputRow[stockQtyIndex]) : Math.abs(stockQty);
  const bs = 0;
  const qnet = qty - bs;
  const script = outputRow[1] || '';
  const close = parseNumber_(outputRow[2]);
  const ltp = parseNumber_(outputRow[3]);
  const calc1 = qnet * (ltp - close);
  const calc2 = qnet * close;

  return [qty, bs, qnet, script, close, ltp, calc1, calc2];
}

function isDashboardDataRow_(row) {
  const scriptValue = normalizeHeader_(row[1]);
  const qtyValue = parseNumber_(row[CONFIG.stockQtyColumnNumber - 1]);
  const closeValue = parseNumber_(row[2]);
  const ltpValue = parseNumber_(row[3]);

  if (!scriptValue) return false;
  if (scriptValue === 'scrip name' || scriptValue === 'script name') return false;
  if (scriptValue === 'script') return false;
  if (qtyValue === 0) return false;
  if (!closeValue && !ltpValue) return false;
  return true;
}

function getDashboardCalcTotals_(rows) {
  return rows.reduce((totals, row) => {
    totals.calc1 += parseNumber_(row[6]);
    totals.calc2 += parseNumber_(row[7]);
    return totals;
  }, { calc1: 0, calc2: 0 });
}

function columnNumberToLetter_(columnNumber) {
  let letter = '';
  let remaining = columnNumber;

  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return letter;
}

function parseNetBalance_(sectionText) {
  const lines = sectionText.split(/\r?\n/);
  const headerLine = lines.find(line => line.includes('--Debit Amt.') && line.includes('--Credit Amt.--'));
  const balanceLine = lines.find(line => line.includes(CONFIG.netBalanceText));

  if (!balanceLine) return null;

  const amountMatch = balanceLine.match(/[\d,]+\.\d{2}/);
  if (!amountMatch) return null;

  const amount = parseNumber_(amountMatch[0]);
  let isDebit = true;

  if (headerLine) {
    const creditColumn = headerLine.indexOf('--Credit Amt.--');
    const amountColumn = balanceLine.indexOf(amountMatch[0]);
    if (creditColumn !== -1 && amountColumn >= creditColumn) isDebit = false;
  }

  return { amount, isDebit };
}

function buildCashSummary_(values) {
  const headerRowIndex = findCashHeaderRow_(values);
  if (headerRowIndex === -1) throw new Error('Could not find cash summary headers.');

  const headers = values[headerRowIndex];
  const nameIndex = findColumn_(headers, CONFIG.nameHeader);
  const clientPlIndex = findColumn_(headers, CONFIG.clientPlHeader);
  const tradeAmountIndex = findColumn_(headers, CONFIG.tradeAmountHeader);

  const summary = {};

  values.slice(headerRowIndex + 1).forEach(row => {
    const name = String(row[nameIndex] || '').trim();
    if (!name) return;

    if (!summary[name]) summary[name] = { clientPl: 0, tradeAmount: 0 };

    summary[name].clientPl += parseNumber_(row[clientPlIndex]);
    summary[name].tradeAmount += parseNumber_(row[tradeAmountIndex]);
  });

  const output = [['Row Labels', 'Sum of Client P/L (Total)', 'Sum of Trade Amt at Closing Rate']];

  Object.keys(summary).sort().forEach(name => {
    output.push([name, summary[name].clientPl, summary[name].tradeAmount]);
  });

  output.push([
    'Grand Total',
    Object.values(summary).reduce((total, row) => total + row.clientPl, 0),
    Object.values(summary).reduce((total, row) => total + row.tradeAmount, 0),
  ]);

  return output;
}

function findCashHeaderRow_(values) {
  return values.findIndex(row => {
    const normalized = row.map(normalizeHeader_);
    return normalized.includes(normalizeHeader_(CONFIG.nameHeader)) &&
      normalized.includes(normalizeHeader_(CONFIG.clientPlHeader)) &&
      normalized.includes(normalizeHeader_(CONFIG.tradeAmountHeader));
  });
}

function findColumn_(headers, headerName) {
  const index = headers.findIndex(header => normalizeHeader_(header) === normalizeHeader_(headerName));
  if (index === -1) throw new Error(`Could not find column: ${headerName}`);
  return index;
}

function normalizeHeader_(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseNumber_(value) {
  if (value === null || value === '') return 0;

  const text = String(value).replace(/,/g, '').trim();
  const number = Number(text.replace(/[()]/g, ''));

  if (isNaN(number)) return 0;
  return text.includes('(') && text.includes(')') ? number * -1 : number;
}

function formatAmount_(value) {
  return Number(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getOrCreateSheet_(ss, sheetName) {
  return ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
}

function writeValues_(sheet, values) {
  ensureSheetSize_(sheet, values.length, values[0].length);
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
}

function ensureSheetSize_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  }

  if (sheet.getMaxColumns() < columns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
  }
}
