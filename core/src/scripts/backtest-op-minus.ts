/**
 * OP(-) backtest harness.
 *
 * Runs the naked short-option strategy over the last N calendar days,
 * preferring the strategy-specific corpus and falling back to other recorded
 * NIFTY corpora when a day is missing. If a day is still missing, an optional
 * fetch command can materialize it before the backtest continues.
 *
 * Usage:
 *   node dist/scripts/backtest-op-minus.js [--days 30] [--end YYYY-MM-DD]
 *     [--fetch-missing]
 *
 * Environment hooks:
 *   DHAN_FETCH_TICKS_CMD   Optional command template used when a day is
 *                          missing. Supports ${DATE}, ${OUT}, and ${ROOT}.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema, type MarketProfile } from '../config/schemas.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { ManualClock } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { FeedMarketData, type OptionSpec } from '../host/feed-market-data.js';
import { PaperHost, type HostRunnerPorts } from '../host/paper-host.js';
import { loadScripMaster, resolveNiftyOptionChain, toInstrument } from '../marketdata/instrument-master.js';
import { OpMinusRunner } from '../mm/op-minus-runner.js';
import { FeatureRegimeProvider } from '../strategy/regime.js';
import { OpMinusAtmShort } from '../strategy/strategies/op-minus-atm-short.js';

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_DIR = join(SCALPER_ROOT, 'config');
// Backtest-only corpus. Live data paths are configured by the live host.
const DEFAULT_DATA_ROOT = 'D:\\Claude\\workstation\\services\\scalper\\core\\data\\dhan';
const DEFAULT_CORPUS_ROOT = join(DEFAULT_DATA_ROOT, 'ticks-op-minus-atm-short');
const FALLBACK_CORPORA = [
  DEFAULT_CORPUS_ROOT,
  join(DEFAULT_DATA_ROOT, 'ticks-allop-atm-mm'),
  join(DEFAULT_DATA_ROOT, 'ticks-s2-vwap-fade'),
  join(DEFAULT_DATA_ROOT, 'ticks'),
];

const IST_OFFSET_MS = 330 * 60_000;

interface BacktestDayResult {
  date: string;
  ticks: number;
  trades: number;
  wins: number;
  losses: number;
  grossPaise: number;
  chargesPaise: number;
  netPaise: number;
  journalDir: string;
  source: string;
  noTradeReasons: string[];
  entrySignals: number;
  strategyEvents: number;
}

interface BacktestResult {
  days: BacktestDayResult[];
  missingDays: string[];
  fetchedDays: string[];
  totalTicks: number;
  totalTrades: number;
  totalGrossPaise: number;
  totalChargesPaise: number;
  totalNetPaise: number;
  reportMdPath: string;
  reportCsvPath: string;
  reportDiagPath: string;
}

function istDate(nowMs = Date.now()): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function addCalendarDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function listLookbackDays(endDate: string, days: number): string[] {
  const out: string[] = [];
  for (let i = Math.max(1, days) - 1; i >= 0; i -= 1) out.push(addCalendarDays(endDate, -i));
  return out;
}

async function loadTicksFromGz(path: string): Promise<Tick[]> {
  const resolved = existsSync(path) && statIsDir(path) ? join(path, 'ticks.jsonl.gz') : path;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    const gz = createReadStream(resolved).pipe(createGunzip());
    gz.on('data', (chunk: Buffer) => chunks.push(chunk));
    gz.on('end', resolve);
    gz.on('error', () => resolve());
  });

  const ticks: Tick[] = [];
  const text = Buffer.concat(chunks).toString('utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      ticks.push(JSON.parse(trimmed) as Tick);
    } catch {
      // tolerate torn tail
    }
  }
  return ticks;
}

function statIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pickSourceDay(date: string): string | undefined {
  for (const root of FALLBACK_CORPORA) {
    const candidate = join(root, date, 'ticks.jsonl.gz');
    if (existsSync(candidate)) {
      if (statIsDir(candidate)) {
        const nested = join(candidate, 'ticks.jsonl.gz');
        if (existsSync(nested)) return nested;
        continue;
      }
      return candidate;
    }
  }
  return undefined;
}

function materializeMissingDay(date: string, outDir: string): string | undefined {
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, 'ticks.jsonl.gz');
  const template = process.env.DHAN_FETCH_TICKS_CMD?.trim();
  const runEnv = {
    ...process.env,
    OP_MINUS_BACKTEST_DATE: date,
    OP_MINUS_BACKTEST_OUT: outDir,
    OP_MINUS_BACKTEST_ROOT: SCALPER_ROOT,
  };
  try {
    if (template) {
      const rendered = template
        .replaceAll('${DATE}', date)
        .replaceAll('${OUT}', outDir)
        .replaceAll('${ROOT}', SCALPER_ROOT);
      execFileSync('powershell.exe', ['-NoProfile', '-Command', rendered], {
        stdio: 'inherit',
        env: runEnv,
      });
    } else {
      const scriptPath = join(SCALPER_ROOT, 'core', 'scripts', 'fetch_dhan_atm4_history.py');
      execFileSync('python', [scriptPath, '--date', date, '--out', outDir, '--profile', 'research'], {
        stdio: 'inherit',
        env: runEnv,
      });
    }
  } catch (err) {
    console.warn(`[fetch-missing] could not backfill ${date}: ${String(err)}`);
    return undefined;
  }
  return existsSync(outFile) ? outFile : undefined;
}

function pickSpotInstrumentId(ticks: readonly Tick[], fallbackInstrumentId: InstrumentId | undefined): InstrumentId {
  if (fallbackInstrumentId !== undefined) return fallbackInstrumentId;
  const counts = new Map<string, number>();
  for (const tick of ticks) counts.set(tick.instrumentId, (counts.get(tick.instrumentId) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted[0]?.[0] === undefined) throw new Error('Could not infer a spot instrument from the tick corpus');
  return sorted[0][0] as InstrumentId;
}

function primeSpot(marketData: FeedMarketData, spotInstrumentId: InstrumentId, spotPaise: number): void {
  const now = Date.now();
  marketData.ingest({
    instrumentId: spotInstrumentId,
    ts: now,
    recvTs: now,
    ltpPaise: spotPaise,
    qty: 0,
    volume: 0,
    bidPaise: 0,
    askPaise: 0,
    bidQty: 0,
    askQty: 0,
  });
}

function marketWithLiveChainFacts(market: MarketProfile, lotSize: number, tickSizePaise: number): MarketProfile {
  return {
    ...market,
    tickSizePaise,
    contract: {
      ...market.contract,
      lotSize,
    },
  };
}

function parseArgs(argv: string[]): { days: number; endDate: string; profile: 'strict' | 'research'; fetchMissing: boolean } {
  const daysIndex = argv.indexOf('--days');
  const endIndex = argv.indexOf('--end');
  const profileIndex = argv.indexOf('--profile');
  const fetchMissing = argv.includes('--fetch-missing');
  const days = daysIndex >= 0 ? Number(argv[daysIndex + 1] ?? '30') : 30;
  const endDate = endIndex >= 0 ? String(argv[endIndex + 1] ?? istDate()) : istDate();
  const profile = profileIndex >= 0 && String(argv[profileIndex + 1] ?? '').toLowerCase() === 'research' ? 'research' : 'strict';
  return { days, endDate, profile, fetchMissing };
}

async function backtestDay(
  date: string,
  ticks: Tick[],
  sourcePath: string,
  runRoot: string,
  profile: 'strict' | 'research',
): Promise<BacktestDayResult> {
  const marketCfg = loadConfig(MarketProfileSchema, join(CONFIG_DIR, 'market', 'allop-nse-options.json'));
  const riskCfg = loadConfig(RiskProfileSchema, join(CONFIG_DIR, 'risk', 'op-minus-paper.json'));
  const strategyCfg = loadConfig(StrategyConfigSchema, join(CONFIG_DIR, 'strategy', 'op-minus-atm-short.json'));
  const masterPath = process.env.DHAN_SCRIP_MASTER_PATH?.trim() || 'D:\\DHAN_LOGIN\\api-scrip-master.csv';

  const scripRows = loadScripMaster(masterPath);

  const spotInstrumentId = pickSpotInstrumentId(
    ticks,
    process.env.DHAN_SPOT_SECURITY_ID?.trim() ? makeInstrumentId('NSE', process.env.DHAN_SPOT_SECURITY_ID.trim()) : undefined,
  );

  const scalpWeekly = resolveNiftyOptionChain(scripRows, date, Math.max(0, Number(strategyCfg.value.params.minDaysToExpiry ?? 1)));
  if (scalpWeekly === undefined) throw new Error(`Could not resolve scalp chain for ${date}`);

  const market = marketWithLiveChainFacts(marketCfg.value, scalpWeekly.lotSize, scalpWeekly.tickSizePaise);
  const firstSpotTick = ticks.find((tick) => tick.instrumentId === spotInstrumentId);
  const firstSpotPaise = firstSpotTick?.ltpPaise ?? 0;
  const strikeBand = profile === 'research'
    ? Math.max(12, Number(strategyCfg.value.params.strikeBand ?? 5))
    : Number(strategyCfg.value.params.strikeBand ?? 5);
  const selectedStrikes = [...scalpWeekly.chain.keys()].sort((a, b) => a - b).filter((strike) =>
    Math.abs(strike - firstSpotPaise) <= strikeBand * market.contract.strikeStepPaise,
  );
  const optionSpecs: OptionSpec[] = [];
  const strikeCount = profile === 'research'
    ? Math.max(1, Number(strategyCfg.value.params.scalpLotsPerRight ?? 2)) + 12
    : Math.max(1, Number(strategyCfg.value.params.scalpLotsPerRight ?? 2)) + 4;
  for (const strike of selectedStrikes.slice(0, strikeCount)) {
    const scalp = scalpWeekly.chain.get(strike);
    for (const row of [scalp?.ce, scalp?.pe]) {
      if (row === undefined) continue;
      const instrument = toInstrument(row);
      optionSpecs.push({
        instrumentId: instrument.id,
        strikePaise: row.strikePaise,
        right: row.optionType === 'CE' || row.optionType === 'PE' ? row.optionType : 'CE',
        expiry: row.expiryDate,
      });
    }
  }

  const journalDir = join(runRoot, date);
  mkdirSync(journalDir, { recursive: true });
  const clock = new ManualClock(ticks[0]!.ts);
  const marketData = new FeedMarketData({
    spotInstrumentId,
    options: optionSpecs,
    strikeStepPaise: market.contract.strikeStepPaise,
  });
  if (firstSpotPaise > 0) primeSpot(marketData, spotInstrumentId, firstSpotPaise);
  const broker = new PaperBroker({
    clock,
    tickSizePaise: market.tickSizePaise,
    slippageTicks: Number(process.env.DHAN_PAPER_SLIPPAGE_TICKS ?? strategyCfg.value.params.paperSlippageTicks ?? 1),
    ackLatencyMs: 0,
    fillLatencyMs: 0,
    restingFills: true,
  });
  const ids = new IdFactory(makeSessionId(date, 'paper'));
  const strategy = new OpMinusAtmShort();
  const host = new PaperHost({
    sessionId: makeSessionId(date, 'paper'),
    date,
    mode: 'paper',
    market,
    riskProfile: riskCfg.value,
    eligibility: {
      entryWindows: profile === 'research'
        ? [{ from: market.session.open, to: '15:29' }]
        : [{ from: market.session.open, to: market.entryCutoff }],
      blackoutDates: new Set(),
      maxSpreadPct: profile === 'research'
        ? Number(process.env.DHAN_MAX_SPREAD_PCT ?? 0.10)
        : Number(process.env.DHAN_MAX_SPREAD_PCT ?? 0.015),
      minOi: profile === 'research'
        ? Number(process.env.DHAN_MIN_OI ?? 0)
        : Number(process.env.DHAN_MIN_OI ?? 100),
      minVolume: profile === 'research'
        ? Number(process.env.DHAN_MIN_VOLUME ?? 0)
        : Number(process.env.DHAN_MIN_VOLUME ?? 100),
      strikeBand,
      strikeStepPaise: market.contract.strikeStepPaise,
    },
    strategy,
    params: strategyCfg.value.params,
    regime: new FeatureRegimeProvider({ view: marketData, clock }),
    cooldownSec: Number(strategyCfg.value.params.cooldownSec ?? 60),
    broker,
    marketData,
    ids,
    clock,
    journalDir,
    configs: [
      { name: 'market', hash: marketCfg.hash, path: marketCfg.path },
      { name: 'risk', hash: riskCfg.hash, path: riskCfg.path },
      { name: 'strategy', hash: strategyCfg.hash, path: strategyCfg.path },
    ],
    resolveChain: () => scalpWeekly,
    preflightLastTickTs: () => marketData.lastSpotTs(),
    feedStaleMs: 30_000,
    autoArm: true,
    autoAckPreflight: true,
    persistence: 'off',
    quoteSink: (instrumentId, quote) => broker.setQuote(instrumentId, quote),
    runnerFactory: (ports: HostRunnerPorts) =>
      new OpMinusRunner({
        sessionId: makeSessionId(date, 'paper'),
        strategyId: strategyCfg.value.strategyId,
        params: strategyCfg.value.params,
        market,
        scalpExpiry: scalpWeekly.expiryDate,
        gate: ports.gate,
        oms: ports.oms,
        escalator: ports.escalator,
        sessionRisk: ports.sessionRisk,
        ids,
        clock: ports.clock,
        view: marketData,
        quoteGates: {
          maxSpreadPct: profile === 'research'
            ? Number(process.env.DHAN_MAX_SPREAD_PCT ?? 0.10)
            : Number(process.env.DHAN_MAX_SPREAD_PCT ?? 0.015),
          minOi: profile === 'research'
            ? Number(process.env.DHAN_MIN_OI ?? 0)
            : Number(process.env.DHAN_MIN_OI ?? 100),
          minVolume: profile === 'research'
            ? Number(process.env.DHAN_MIN_VOLUME ?? 0)
            : Number(process.env.DHAN_MIN_VOLUME ?? 100),
          strikeBand,
        },
        journal: ports.journal,
        journalHealthy: ports.journalHealthy,
      }),
  });

  const start = await host.start();
  if (start.halted) throw new Error(`Backtest host halted on start for ${date}: ${start.reason ?? 'UNKNOWN'}`);

  const timerEveryMs = Number(process.env.DHAN_TIMER_INTERVAL_MS ?? 250);
  let lastTimer = ticks[0]!.ts;
  for (const tick of ticks) {
    clock.set(Math.max(clock.now(), tick.ts));
    await host.ingestTick(tick);
    if (tick.ts - lastTimer >= timerEveryMs) {
      await host.onTimer(tick.ts);
      lastTimer = tick.ts;
    }
  }

  const { report } = await host.squareOffAndReport();
  const s = report.summary;
  const events = [...host.journalEvents()];
  const noTradeReasons = [...new Set(
    events
      .filter((ev) => ev.type === 'strategy.noTrade')
      .map((ev) => String((ev.payload as { reason?: string }).reason ?? 'UNKNOWN')),
  )].sort();
  const entrySignals = events.filter((ev) => ev.type === 'strategy.signal').length;
  const strategyEvents = events.filter((ev) => ev.type === 'strategy.noTrade' || ev.type === 'strategy.signal').length;
  return {
    date,
    ticks: ticks.length,
    trades: s.tradeCount,
    wins: s.wins,
    losses: s.losses,
    grossPaise: s.grossPaise,
    chargesPaise: s.chargesPaise,
    netPaise: s.netPaise,
    journalDir,
    source: sourcePath,
    noTradeReasons,
    entrySignals,
    strategyEvents,
  };
}

async function runBacktest(endDate: string, lookbackDays: number, profile: 'strict' | 'research', fetchMissing: boolean): Promise<BacktestResult> {
  const runRoot = join(SCALPER_ROOT, 'journals', 'op-minus-atm-short', 'backtest', `${endDate}-${lookbackDays}d`);
  mkdirSync(runRoot, { recursive: true });
  const dayResults: BacktestDayResult[] = [];
  const missingDays: string[] = [];
  const fetchedDays: string[] = [];

  for (const date of listLookbackDays(endDate, lookbackDays)) {
    const primary = join(DEFAULT_CORPUS_ROOT, date, 'ticks.jsonl.gz');
    let source = pickSourceDay(date);
    let ticks: Tick[] | undefined;
    if (source === undefined && fetchMissing) {
      const fetchOut = join(DEFAULT_CORPUS_ROOT, date);
      source = materializeMissingDay(date, fetchOut);
      if (source !== undefined) fetchedDays.push(date);
    }
    if (source === undefined) {
      missingDays.push(date);
      continue;
    }
    ticks = await loadTicksFromGz(source);
    if (ticks.length === 0) {
      missingDays.push(date);
      continue;
    }
    const result = await backtestDay(date, ticks, source, runRoot, profile);
    dayResults.push(result);
  }

  const reportPathBase = join(runRoot, `summary-${profile}`);
  const reportCsvPath = `${reportPathBase}.csv`;
  const reportMdPath = `${reportPathBase}.md`;
  const reportDiagPath = `${reportPathBase}-diag.md`;
  writeFileSync(reportCsvPath, renderCsv(endDate, lookbackDays, profile, dayResults, missingDays, fetchedDays), 'utf8');
  writeFileSync(reportMdPath, renderMarkdown(endDate, lookbackDays, profile, dayResults, missingDays, fetchedDays), 'utf8');
  writeFileSync(reportDiagPath, renderDiagnostics(endDate, lookbackDays, profile, dayResults, missingDays, fetchedDays), 'utf8');

  return {
    days: dayResults,
    missingDays,
    fetchedDays,
    totalTicks: dayResults.reduce((sum, d) => sum + d.ticks, 0),
    totalTrades: dayResults.reduce((sum, d) => sum + d.trades, 0),
    totalGrossPaise: dayResults.reduce((sum, d) => sum + d.grossPaise, 0),
    totalChargesPaise: dayResults.reduce((sum, d) => sum + d.chargesPaise, 0),
    totalNetPaise: dayResults.reduce((sum, d) => sum + d.netPaise, 0),
    reportMdPath,
    reportCsvPath,
    reportDiagPath,
  };
}

async function main(): Promise<void> {
  const { days, endDate, profile, fetchMissing } = parseArgs(process.argv.slice(2));

  console.log(`OP(-) Backtest`);
  console.log(`End date: ${endDate}`);
  console.log(`Lookback: ${days} days`);
  console.log(`Primary corpus: ${DEFAULT_CORPUS_ROOT}`);

  const result = await runBacktest(endDate, days, profile, fetchMissing);

  console.log('\nSummary');
  console.log(`  Days processed : ${result.days.length}`);
  console.log(`  Missing days   : ${result.missingDays.length}${result.missingDays.length > 0 ? ` (${result.missingDays.join(', ')})` : ''}`);
  console.log(`  Fetched days   : ${result.fetchedDays.length}${result.fetchedDays.length > 0 ? ` (${result.fetchedDays.join(', ')})` : ''}`);
  console.log(`  Ticks replayed : ${result.totalTicks}`);
  console.log(`  Trades         : ${result.totalTrades}`);
  console.log(`  Gross P&L      : ₹${(result.totalGrossPaise / 100).toFixed(2)}`);
  console.log(`  Charges        : ₹${(result.totalChargesPaise / 100).toFixed(2)}`);
  console.log(`  Net P&L        : ₹${(result.totalNetPaise / 100).toFixed(2)}`);
  console.log(`  Report CSV     : ${result.reportCsvPath}`);
  console.log(`  Report MD      : ${result.reportMdPath}`);
  console.log(`  Report DIAG    : ${result.reportDiagPath}`);
}

void main().catch((err) => {
  console.error('backtest-op-minus failed:', err);
  process.exitCode = 1;
});

function renderCsv(
  endDate: string,
  days: number,
  profile: string,
  results: BacktestDayResult[],
  missingDays: string[],
  fetchedDays: string[],
): string {
  const lines = results.map((d) =>
    [
      d.date,
      d.source,
      String(d.ticks),
      String(d.trades),
      String(d.wins),
      String(d.losses),
      (d.grossPaise / 100).toFixed(2),
      (d.chargesPaise / 100).toFixed(2),
      (d.netPaise / 100).toFixed(2),
      d.journalDir,
    ].join(','),
  );
  return [
    `# endDate=${endDate} profile=${profile} lookbackDays=${days}`,
    `date,source,ticks,trades,wins,losses,gross,charges,net,journalDir`,
    ...lines,
    `# missingDays=${missingDays.join('|')}`,
    `# fetchedDays=${fetchedDays.join('|')}`,
  ].join('\n') + '\n';
}

function renderDiagnostics(
  endDate: string,
  days: number,
  profile: string,
  results: BacktestDayResult[],
  missingDays: string[],
  fetchedDays: string[],
): string {
  const reasonCounts = new Map<string, number>();
  for (const d of results) for (const reason of d.noTradeReasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  const lines = [
    `# OP(-) Backtest Diagnostics`,
    ``,
    `- End date: ${endDate}`,
    `- Lookback: ${days} days`,
    `- Profile: ${profile}`,
    `- Processed days: ${results.length}`,
    `- Missing days: ${missingDays.length}${missingDays.length > 0 ? ` (${missingDays.join(', ')})` : ''}`,
    `- Fetched days: ${fetchedDays.length}${fetchedDays.length > 0 ? ` (${fetchedDays.join(', ')})` : ''}`,
    ``,
    `## Strategy Reasons`,
    '',
    ...(reasonCounts.size > 0
      ? [...reasonCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `- ${reason}: ${count}`)
      : ['- none']),
    ``,
    `## Day-by-Day`,
    '',
    ...results.map((d) =>
      [
        `- ${d.date}: trades=${d.trades}, entrySignals=${d.entrySignals}, strategyEvents=${d.strategyEvents}, noTradeReasons=${d.noTradeReasons.length > 0 ? d.noTradeReasons.join('|') : 'none'}`,
        `  source=${d.source}`,
        `  journal=${d.journalDir}`,
      ].join('\n'),
    ),
    '',
  ];
  return lines.join('\n');
}

function renderMarkdown(
  endDate: string,
  days: number,
  profile: string,
  results: BacktestDayResult[],
  missingDays: string[],
  fetchedDays: string[],
): string {
  const header = [
    `# OP(-) Backtest`,
    ``,
    `- End date: ${endDate}`,
    `- Lookback: ${days} days`,
    `- Profile: ${profile}`,
    `- Days processed: ${results.length}`,
    `- Missing days: ${missingDays.length}${missingDays.length > 0 ? ` (${missingDays.join(', ')})` : ''}`,
    `- Fetched days: ${fetchedDays.length}${fetchedDays.length > 0 ? ` (${fetchedDays.join(', ')})` : ''}`,
    ``,
    `| Date | Source | Ticks | Trades | Wins | Losses | Gross | Charges | Net |`,
    `| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
  ];
  const rows = results.map((d) =>
    `| ${d.date} | ${d.source.replaceAll('|', '\\|')} | ${d.ticks} | ${d.trades} | ${d.wins} | ${d.losses} | ₹${(d.grossPaise / 100).toFixed(2)} | ₹${(d.chargesPaise / 100).toFixed(2)} | ₹${(d.netPaise / 100).toFixed(2)} |`,
  );
  return [...header, ...rows, '', `Missing days: ${missingDays.length > 0 ? missingDays.join(', ') : 'none'}`, `Fetched days: ${fetchedDays.length > 0 ? fetchedDays.join(', ') : 'none'}`, ''].join('\n');
}
