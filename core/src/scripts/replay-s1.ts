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

import { createReadStream, mkdirSync, rmSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema } from '../config/schemas.js';
import { makeSessionId, IdFactory, type InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { ManualClock } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { FeedMarketData } from '../host/feed-market-data.js';
import { PaperHost } from '../host/paper-host.js';
import { S1MomentumBurst } from '../strategy/strategies/s1-momentum-burst.js';
import { FeatureRegimeProvider } from '../strategy/regime.js';
import { S1_ENTRY_START, s1MarketProfile } from '../strategy/s1-schedule.js';
import type { StrategyParams } from '../strategy/types.js';
import {
  discoverPlainRecording,
  loadTicksForDate,
  resolveScripMasterPath,
  type DiscoveredRecording,
} from './backtest-recording.js';
export { loadTicksFromGz, loadTicksForDate } from './backtest-recording.js';

// ─── paths ───────────────────────────────────────────────────────────────────

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_DIR = join(SCALPER_ROOT, 'config');
// Backtest-only corpus. Live data paths are configured by the live host.
// Exported so sweep-s1 pre-validates the SAME corpus runReplay loads from.
export const TICK_ROOT = join(SCALPER_ROOT, 'data', 'dhan', 'ticks-s1-momentum-burst');

// ─── tick loader ─────────────────────────────────────────────────────────────

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

/**
 * A scrip-master/corpus mismatch must never degrade into a plausible-looking
 * zero-trade replay. Dynamic discovery handles expiry rolls; this guard still
 * catches recordings whose instruments are mostly no longer resolvable.
 */
export function assertReplayCoverage(ticks: readonly Tick[], recording: DiscoveredRecording, date: string): void {
  const known = new Set<InstrumentId>([
    recording.spotInstrumentId,
    ...recording.optionSpecs.map((spec) => spec.instrumentId),
  ]);
  const unknownCount = ticks.filter((tick) => !known.has(tick.instrumentId)).length;
  const unknownPct = unknownCount / ticks.length;
  if (unknownPct > 0.05) {
    throw new Error(
      `${(unknownPct * 100).toFixed(0)}% ticks unknown — scrip master or option specs are stale for ${date}`,
    );
  }
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
  const market = s1MarketProfile(marketCfg.value);

  // ── load ticks ────────────────────────────────────────────────────────────
  // Loads every part (ticks.jsonl.gz, ticks-2.jsonl.gz, …) so a day recorded
  // across process restarts replays whole.
  const tickPath = join(TICK_ROOT, date);
  const allTicks = await loadTicksForDate(tickPath);
  if (allTicks.length === 0) throw new Error(`No ticks loaded from ${tickPath}`);
  if (!opts.silent) console.log(`  Loaded ${allTicks.length} ticks for ${date}`);

  // ── build market data ─────────────────────────────────────────────────────
  // discoverRecording resolves instruments from the scrip master and throws
  // when nothing resolves — a stale/mismatched corpus fails loudly, never as
  // a silent 0-trade run.
  // Date-aware: an expired contract is purged from the live master, so a past
  // recording must resolve against the master as it stood on that date.
  const scripMasterPath = resolveScripMasterPath(date);
  if (!opts.silent) console.log(`  Scrip master: ${scripMasterPath}`);
  const recording = discoverPlainRecording(allTicks, scripMasterPath);
  assertReplayCoverage(allTicks, recording, date);
  const clock = new ManualClock(recording.feedTicks[0]!.ts);
  const marketData = new FeedMarketData({
    spotInstrumentId: recording.spotInstrumentId,
    options: recording.optionSpecs,
    strikeStepPaise: market.contract.strikeStepPaise,
  });

  // Prime spot so preflight freshness check passes (needs a recent tick).
  // Hard-fail when absent: preflight would fail feed.fresh, ARM would be
  // refused, and the run would "complete" with 0 trades and no warning.
  const firstSpot = recording.feedTicks.find((t) => t.instrumentId === recording.spotInstrumentId);
  if (firstSpot === undefined) {
    throw new Error(`No spot tick (${recording.spotInstrumentId}) in ${tickPath} — cannot replay ${date}`);
  }
  clock.set(firstSpot.ts);
  marketData.ingest(firstSpot);

  // ── build paper broker & host ─────────────────────────────────────────────
  const sessionId = makeSessionId(date, 'paper');
  const ids = new IdFactory(sessionId);
  // Deterministic fill model: 1 tick slippage, zero latency. Fine for RANKING
  // combos against each other; do NOT compare absolute ₹ to live paper numbers
  // (live fills ride real ack/fill latency between signal and execution).
  const broker = new PaperBroker({
    clock,
    tickSizePaise: market.tickSizePaise,
    slippageTicks: 1,
    ackLatencyMs: 0,
    fillLatencyMs: 0,
  });

  const journalDir = opts.journalDir ?? join(tmpdir(), `scalper-replay-${date}-${Date.now()}`);
  // Fresh dir every run: PaperHost.start() enters crash recovery whenever an
  // events.jsonl EXISTS in the dir, which would resume the previous run's seq
  // and sessionRisk (incl. a latched daily-loss stop) and silently change
  // results on re-runs.
  rmSync(journalDir, { recursive: true, force: true });
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
      entryWindows: [{ from: S1_ENTRY_START, to: market.entryCutoff }],
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
    // Option ticks carry LTT (last-trade time) which can lag the current spot
    // timestamp by minutes. Driving the clock (or the timer) backward trips
    // CLOCK_SKEW and regresses TTL/session-phase checks — clamp everything to
    // monotonically-advancing sim time.
    const simNow = Math.max(clock.now(), tick.ts);
    clock.set(simNow);
    await host.ingestTick(tick);
    if (simNow - lastTimer >= TIMER_INTERVAL_MS) {
      await host.onTimer(simNow);
      lastTimer = simNow;
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
