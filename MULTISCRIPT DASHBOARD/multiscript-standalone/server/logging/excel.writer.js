const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

async function ensureDir(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

async function loadOrCreateWorkbook(filePath, sheetName = 'Trades') {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(filePath)) {
    await workbook.xlsx.readFile(filePath);
  } else {
    const sheet = workbook.addWorksheet(sheetName);
    return { workbook, sheet };
  }
  let sheet = workbook.getWorksheet(sheetName);
  if (!sheet) sheet = workbook.addWorksheet(sheetName);
  return { workbook, sheet };
}

async function saveWorkbook(workbook, filePath) {
  await ensureDir(filePath);
  await workbook.xlsx.writeFile(filePath);
}

module.exports = {
  loadOrCreateWorkbook,
  saveWorkbook,
  ensureDir
};
