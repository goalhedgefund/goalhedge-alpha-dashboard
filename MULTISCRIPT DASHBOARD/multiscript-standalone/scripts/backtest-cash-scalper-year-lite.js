const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const runner = path.join(__dirname, 'backtest-cash-scalper.js');

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function splitYear(start, end, chunkDays = 92) {
  const ranges = [];
  let cursor = new Date(`${start}T00:00:00+05:30`);
  const finish = new Date(`${end}T23:59:59+05:30`);
  while (cursor <= finish) {
    const chunkEnd = new Date(Math.min(addDays(cursor, chunkDays - 1).getTime(), finish.getTime()));
    ranges.push({ from: toIso(cursor), to: toIso(chunkEnd) });
    cursor = addDays(chunkEnd, 1);
  }
  return ranges;
}

function runChunk(from, to) {
  const result = spawnSync(process.execPath, [runner, '--from', from, '--to', to], {
    cwd: rootDir,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    throw new Error(`Chunk ${from}..${to} failed:\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  return result.stdout;
}

function chunkFile(from, to) {
  return path.join(dataDir, `cash-scalper-backtest-${from}-to-${to}.json`);
}

function mergeSymbols(target, source) {
  for (const [symbol, row] of Object.entries(source.symbols || {})) {
    target.symbols[symbol] = row;
  }
  for (const [symbol, report] of Object.entries(source.reports || {})) {
    const current = target.reports[symbol] || {
      pnl: 0,
      realized: 0,
      unrealized: 0,
      trades: 0,
      wins: 0,
      maxDrawdown: 0,
      months: [],
      chunks: []
    };
    if (report.best) {
      current.pnl += Number(report.best.pnl || 0);
      current.realized += Number(report.best.realized || 0);
      current.unrealized += Number(report.best.unrealized || 0);
      current.trades += Number(report.best.trades || 0);
      current.wins += Math.round((Number(report.best.winRate || 0) / 100) * Number(report.best.trades || 0));
      current.maxDrawdown = Math.min(current.maxDrawdown, Number(report.best.maxDrawdown || 0));
      current.months.push(...(report.best.monthly || []));
    }
    current.chunks.push({ from: report.from, to: report.to, best: report.best || null });
    target.reports[symbol] = current;
  }
}

function main() {
  const start = '2025-07-04';
  const end = '2026-07-04';
  const chunks = splitYear(start, end, 92);
  const output = {
    generatedAt: new Date().toISOString(),
    range: { from: start, to: end },
    chunks,
    symbols: {},
    reports: {}
  };

  for (const chunk of chunks) {
    process.stdout.write(`[year-lite] running ${chunk.from}..${chunk.to}\n`);
    const stdout = runChunk(chunk.from, chunk.to);
    process.stdout.write(stdout);
    const file = chunkFile(chunk.from, chunk.to);
    if (fs.existsSync(file)) {
      mergeSymbols(output, readJson(file));
    }
  }

  const outFile = path.join(dataDir, 'cash-scalper-backtest-12m-lite-results.json');
  writeJson(outFile, output);
  console.log(`Saved year-lite results: ${outFile}`);
}

main();
