/**
 * Replay harness for S2 VWAP-Fade.
 *
 * Loads one day of tick data from the recorded corpus and drives it through
 * a fresh PaperHost with ManualClock, then prints the session result.
 *
 * ManualClock is critical: without it, formatHHMMIst(nowMs) uses the wall
 * clock which falls outside 09:15–15:00 and blocks all entries via ENTRY_WINDOW.
 *
 * Usage:
 *   node dist/scripts/replay-s2.js [--date YYYY-MM-DD]
 */

import { createReadStream, mkdirSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema } from '../config/schemas.js';
import { makeInstrumentId, makeSessionId, IdFactory } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { ManualClock } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { FeedMarketData, type OptionSpec } from '../host/feed-market-data.js';
import { PaperHost } from '../host/paper-host.js';
import { S2VwapFade } from '../strategy/strategies/s2-vwap-fade.js';
import { FeatureRegimeProvider } from '../strategy/regime.js';
import type { StrategyParams } from '../strategy/types.js';
import { discoverPlainRecording, loadTicksFromGz, resolveScripMasterPath } from './backtest-recording.js';

// ─── paths ────────────────────────────────────────────────────────────────────

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_DIR = join(SCALPER_ROOT, 'config');
// Backtest-only corpus. Live data paths are configured by the live host.
const TICK_ROOT = join(SCALPER_ROOT, 'data', 'dhan', 'ticks-s2-vwap-fade');

// ─── known instruments for S2 Jul 22 replay ──────────────────────────────────

// Spot feed: NIFTY Jul 2026 futures (NSE:61093).
// Futures carry real volume so VWAP computes correctly; IDX_I spot sends qty=0.
// All NIFTY options from the Jul 22 session (expiry 2026-08-04, strikes 24000–24500).
// Derived from the Jul 22 tick corpus — Dhan's next weekly after the Jul 21 roll-off.
const OPTION_SPECS: OptionSpec[] = [
  { instrumentId: makeInstrumentId('NSE', '65693'), strikePaise: 2400000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65694'), strikePaise: 2400000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65695'), strikePaise: 2405000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65696'), strikePaise: 2405000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65697'), strikePaise: 2410000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65698'), strikePaise: 2410000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65699'), strikePaise: 2415000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65700'), strikePaise: 2415000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65774'), strikePaise: 2420000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65776'), strikePaise: 2420000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65806'), strikePaise: 2425000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65807'), strikePaise: 2425000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65808'), strikePaise: 2430000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65809'), strikePaise: 2430000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65852'), strikePaise: 2435000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65853'), strikePaise: 2435000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65854'), strikePaise: 2440000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65855'), strikePaise: 2440000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65858'), strikePaise: 2445000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65859'), strikePaise: 2445000, right: 'PE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65860'), strikePaise: 2450000, right: 'CE', expiry: '2026-08-04' },
  { instrumentId: makeInstrumentId('NSE', '65861'), strikePaise: 2450000, right: 'PE', expiry: '2026-08-04' },
];

// ─── tick loader ──────────────────────────────────────────────────────────────

/**
 * Load ticks from a (possibly truncated/multi-member) gzip file.
 * Collects all data that decompresses before any error, then parses lines.
 */
async function loadTicksFromGzLegacy(path: string): Promise<Tick[]> {
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve) => {
    const gz = createReadStream(path).pipe(createGunzip());
    gz.on('data', (chunk: Buffer) => chunks.push(chunk));
    gz.on('end', resolve);
    // Truncated last member — use whatever decompressed before the error.
    gz.on('error', () => resolve());
  });

  const ticks: Tick[] = [];
  const text = Buffer.concat(chunks).toString('utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      ticks.push(JSON.parse(trimmed) as Tick);
    } catch { /* skip partial line at EOF */ }
  }
  return ticks;
}

// ─── replay runner ────────────────────────────────────────────────────────────

export interface ReplayOptions {
  date: string;
  params?: Partial<StrategyParams>;
  journalDir?: string;
  silent?: boolean;
}

export interface ReplayResult {
  tradeCount: number;
  wins: number;
  losses: number;
  netPaise: number;
  grossPaise: number;
  chargesPaise: number;
  avgHoldMs: number;
  maxGiveBackPaise: number;
  ticksReplayed: number;
}

export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const { date } = opts;

  // ── load configs ─────────────────────────────────────────────────────────
  const marketCfg = loadConfig(MarketProfileSchema, join(CONFIG_DIR, 'market', 'india-nse-options.json'));
  const riskCfg = loadConfig(RiskProfileSchema, join(CONFIG_DIR, 'risk', 'paper-default.json'));
  const strategyCfg = loadConfig(StrategyConfigSchema, join(CONFIG_DIR, 'strategy', 's2-vwap-fade.json'));

  const overrides: StrategyParams = {};
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined) overrides[k] = v;
    }
  }
  const params: StrategyParams = { ...strategyCfg.value.params, ...overrides };
  const market = marketCfg.value;

  // ── load ticks ────────────────────────────────────────────────────────────
  const tickPath = join(TICK_ROOT, date, 'ticks.jsonl.gz');
  const allTicks = await loadTicksFromGz(tickPath);
  if (allTicks.length === 0) throw new Error(`No ticks loaded from ${tickPath}`);
  if (!opts.silent) console.log(`  Loaded ${allTicks.length} ticks for ${date}`);

  // ── build market data ─────────────────────────────────────────────────────
  const recording = discoverPlainRecording(allTicks, resolveScripMasterPath(date));
  const clock = new ManualClock(recording.feedTicks[0]!.ts);
  const marketData = new FeedMarketData({
    spotInstrumentId: recording.spotInstrumentId,
    options: recording.optionSpecs,
    strikeStepPaise: market.contract.strikeStepPaise,
  });

  // Prime spot so preflight freshness check passes.
  const firstSpot = recording.feedTicks.find((t) => t.instrumentId === recording.spotInstrumentId);
  if (firstSpot) {
    clock.set(firstSpot.ts);
    marketData.ingest(firstSpot);
  }

  // ── build paper broker & host ─────────────────────────────────────────────
  const sessionId = makeSessionId(date, 'paper');
  const ids = new IdFactory(sessionId);
  const broker = new PaperBroker({
    clock,
    tickSizePaise: market.tickSizePaise,
    slippageTicks: 1,
    ackLatencyMs: 0,
    fillLatencyMs: 0,
  });

  const journalDir =
    opts.journalDir ??
    join(SCALPER_ROOT, 'journals', 's2-replay', date, 'replay');
  mkdirSync(journalDir, { recursive: true });

  const strategy = new S2VwapFade();
  const regime = new FeatureRegimeProvider({ view: marketData, clock });

  const host = new PaperHost({
    sessionId,
    date,
    mode: 'paper',
    market,
    riskProfile: riskCfg.value,
    eligibility: {
      entryWindows: [{ from: market.session.open, to: market.entryCutoff }],
      blackoutDates: new Set(),
      maxSpreadPct: 0.015,
      minOi: 100,
      minVolume: 100,
      strikeBand: 5,
      strikeStepPaise: market.contract.strikeStepPaise,
    },
    strategy,
    params,
    regime,
    cooldownSec: typeof params.cooldownSec === 'number' ? params.cooldownSec : 60,
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
    resolveChain: () => ({
      expiryDate: recording.optionSpecs[0]!.expiry,
      chain: new Map(),
      lotSize: market.contract.lotSize,
      tickSizePaise: market.tickSizePaise,
      rowCount: recording.optionSpecs.length,
    }),
    preflightLastTickTs: () => marketData.lastSpotTs(),
    feedStaleMs: 30_000,
    autoArm: true,
    autoAckPreflight: true,
    persistence: 'off',
    quoteSink: (instrumentId, quote) => broker.setQuote(instrumentId, quote),
    fsync: 'never',
  });

  const startResult = await host.start();
  if (startResult.halted) {
    throw new Error(`Host started halted: ${startResult.reason ?? 'UNKNOWN'}`);
  }

  // ── drive tick loop ───────────────────────────────────────────────────────
  const TIMER_INTERVAL_MS = 250;
  let lastTimer = recording.feedTicks[0]!.ts;

  for (const tick of recording.feedTicks) {
    // Option ticks carry LTT (last-trade time) which can lag current spot time.
    // Use max() to keep the replay clock monotonically advancing.
    clock.set(Math.max(clock.now(), tick.ts));
    await host.ingestTick(tick);
    if (tick.ts - lastTimer >= TIMER_INTERVAL_MS) {
      await host.onTimer(tick.ts);
      lastTimer = tick.ts;
    }
  }

  // ── square off & report ───────────────────────────────────────────────────
  const { report } = await host.squareOffAndReport();
  const s = report.summary;
  return {
    tradeCount: s.tradeCount,
    wins: s.wins,
    losses: s.losses,
    netPaise: s.netPaise,
    grossPaise: s.grossPaise,
    chargesPaise: s.chargesPaise,
    avgHoldMs: s.avgHoldMs,
    maxGiveBackPaise: s.maxGiveBackPaise,
    ticksReplayed: recording.feedTicks.length,
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dateArg = args.find((_, i) => args[i - 1] === '--date') ?? '2026-07-22';

  console.log(`S2 Replay — ${dateArg}`);
  console.log('Running...');

  const journalDir = join(SCALPER_ROOT, 'journals', 's2-replay', dateArg, 'replay');
  const result = await runReplay({ date: dateArg, journalDir });

  const rupeesNet = (result.netPaise / 100).toFixed(2);
  const rupeesGross = (result.grossPaise / 100).toFixed(2);
  const rupeesCharges = (result.chargesPaise / 100).toFixed(2);

  console.log(`\nResult:`);
  console.log(`  Ticks replayed : ${result.ticksReplayed}`);
  console.log(`  Trades         : ${result.tradeCount}  (${result.wins}W / ${result.losses}L)`);
  console.log(`  Gross P&L      : ₹${rupeesGross}`);
  console.log(`  Charges        : ₹${rupeesCharges}`);
  console.log(`  Net P&L        : ₹${rupeesNet}`);
  console.log(`  Avg hold       : ${Math.round(result.avgHoldMs / 1000)}s`);
  console.log(`\nJournal written to: ${journalDir}`);
}

if (process.argv[1]?.endsWith('replay-s2.js')) {
  void main().catch((err) => {
    console.error('replay-s2 failed:', err);
    process.exitCode = 1;
  });
}
