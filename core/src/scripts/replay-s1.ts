/**
 * Phase B: Replay harness for S1 Momentum-Burst.
 *
 * Loads one day of tick data from the recorded corpus and drives it through
 * a fresh PaperHost with ManualClock, then prints the session result.
 *
 * ManualClock is critical: without it, formatHHMMIst(nowMs) uses the wall
 * clock which falls outside 09:15–15:00 and blocks all entries via ENTRY_WINDOW.
 *
 * Usage:
 *   node dist/scripts/replay-s1.js [--date YYYY-MM-DD] [--validate]
 *
 * --validate  asserts the Jul 16 baseline reproduces 1 trade (regression gate).
 */

import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema } from '../config/schemas.js';
import { makeInstrumentId, makeSessionId, IdFactory, type InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { ManualClock } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { FeedMarketData, type OptionSpec } from '../host/feed-market-data.js';
import { PaperHost } from '../host/paper-host.js';
import { S1MomentumBurst } from '../strategy/strategies/s1-momentum-burst.js';
import { FeatureRegimeProvider } from '../strategy/regime.js';
import type { StrategyParams } from '../strategy/types.js';

// ─── paths ───────────────────────────────────────────────────────────────────

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_DIR = join(SCALPER_ROOT, 'config');
const TICK_ROOT = join(SCALPER_ROOT, 'data', 'dhan', 'ticks-s1-momentum-burst');

// ─── known instruments for S1 Jul 16–19 replay ───────────────────────────────

const SPOT_ID = makeInstrumentId('NSE', 'NIFTY_SPOT');

// All NIFTY options from the Jul 16 session (expiry 2026-07-21, strikes 24000–24500).
// Derived via identify-instruments.py from the Jul 16 tick corpus.
const OPTION_SPECS: OptionSpec[] = [
  { instrumentId: makeInstrumentId('NSE', '57340'), strikePaise: 2400000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57341'), strikePaise: 2400000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57342'), strikePaise: 2405000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57343'), strikePaise: 2405000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57344'), strikePaise: 2410000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57345'), strikePaise: 2410000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57346'), strikePaise: 2415000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57347'), strikePaise: 2415000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57348'), strikePaise: 2420000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57349'), strikePaise: 2420000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57350'), strikePaise: 2425000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57351'), strikePaise: 2425000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57352'), strikePaise: 2430000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57353'), strikePaise: 2430000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57354'), strikePaise: 2435000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57355'), strikePaise: 2435000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57356'), strikePaise: 2440000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57357'), strikePaise: 2440000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57358'), strikePaise: 2445000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57359'), strikePaise: 2445000, right: 'PE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57360'), strikePaise: 2450000, right: 'CE', expiry: '2026-07-21' },
  { instrumentId: makeInstrumentId('NSE', '57362'), strikePaise: 2450000, right: 'PE', expiry: '2026-07-21' },
];

// ─── tick loader ─────────────────────────────────────────────────────────────

/**
 * Load ticks from a (possibly truncated/multi-member) gzip file.
 * Collects all data that decompresses before any error, then parses lines.
 */
export async function loadTicksFromGz(path: string): Promise<Tick[]> {
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

// ─── host builder ────────────────────────────────────────────────────────────

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

  // ── load configs ──────────────────────────────────────────────────────────
  const marketCfg = loadConfig(MarketProfileSchema, join(CONFIG_DIR, 'market', 'india-nse-options.json'));
  const riskCfg = loadConfig(RiskProfileSchema, join(CONFIG_DIR, 'risk', 'paper-default.json'));
  const strategyCfg = loadConfig(StrategyConfigSchema, join(CONFIG_DIR, 'strategy', 's1-momentum-burst.json'));

  // Merge any param overrides (for sweep), stripping undefined values.
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
  const clock = new ManualClock(allTicks[0]!.ts);
  const marketData = new FeedMarketData({
    spotInstrumentId: SPOT_ID,
    options: OPTION_SPECS,
    strikeStepPaise: market.contract.strikeStepPaise,
  });

  // Prime spot so preflight freshness check passes (needs a recent tick).
  const firstSpot = allTicks.find((t) => t.instrumentId === SPOT_ID);
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

  const journalDir = opts.journalDir ?? join(tmpdir(), `scalper-replay-${date}-${Date.now()}`);
  mkdirSync(journalDir, { recursive: true });

  const strategy = new S1MomentumBurst();
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
      expiryDate: '2026-07-21',
      chain: new Map(),
      lotSize: market.contract.lotSize,
      tickSizePaise: market.tickSizePaise,
      rowCount: OPTION_SPECS.length,
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
  let lastTimer = allTicks[0]!.ts;

  for (const tick of allTicks) {
    // Option ticks carry LTT (last-trade time) which can lag the current spot
    // timestamp by minutes. Driving the clock backward trips CLOCK_SKEW.
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
    ticksReplayed: allTicks.length,
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dateArg = args.find((_, i) => args[i - 1] === '--date') ?? '2026-07-16';
  const validate = args.includes('--validate');

  console.log(`S1 Replay — ${dateArg}`);
  console.log('Running...');

  const journalDir = join(SCALPER_ROOT, 'journals', 's1-replay', dateArg, 'replay');
  const result = await runReplay({ date: dateArg, journalDir });

  console.log(`\nResult:`);
  console.log(`  Ticks replayed : ${result.ticksReplayed}`);
  console.log(`  Trades         : ${result.tradeCount}  (${result.wins}W / ${result.losses}L)`);
  console.log(`  Gross P&L      : ₹${(result.grossPaise / 100).toFixed(2)}`);
  console.log(`  Charges        : ₹${(result.chargesPaise / 100).toFixed(2)}`);
  console.log(`  Net P&L        : ₹${(result.netPaise / 100).toFixed(2)}`);
  console.log(`  Avg hold       : ${Math.round(result.avgHoldMs / 1000)}s`);

  if (validate) {
    // Jul 16 corrected baseline: 2 trades. Live showed only 1 because the live
    // run itself was killed by CLOCK_SKEW (option LTT < spot timestamp). With the
    // monotonic-clock fix, the second signal on the replayed tick stream fires.
    if (result.tradeCount !== 2) {
      console.error(`\n[FAIL] Expected 2 trades, got ${result.tradeCount}`);
      process.exitCode = 1;
    } else {
      console.log('\n[PASS] Validation: 2 trades reproduced.');
    }
  }
}

// Only auto-run when invoked directly (not when imported by sweep-s1).
if (process.argv[1]?.endsWith('replay-s1.js')) {
  void main().catch((err) => {
    console.error('replay-s1 failed:', err);
    process.exitCode = 1;
  });
}
