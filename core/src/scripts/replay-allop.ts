/** Backtest-only single-session replay for the live ALL-OP market-maker. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema } from '../config/schemas.js';
import { IdFactory, makeSessionId } from '../domain/ids.js';
import { ManualClock } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { FeedMarketData } from '../host/feed-market-data.js';
import { PaperHost, type HostRunnerPorts } from '../host/paper-host.js';
import { MmRunner } from '../mm/mm-runner.js';
import { FeatureRegimeProvider } from '../strategy/regime.js';
import { AllOpAtmMm } from '../strategy/strategies/allop-atm-mm.js';
import { discoverRecording, loadTicksFromGz, resolveScripMasterPath } from './backtest-recording.js';

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_DIR = join(SCALPER_ROOT, 'config');
const TICK_ROOT = join(SCALPER_ROOT, 'data', 'dhan', 'ticks-op-minus-atm-short');

export async function runAllOpReplay(date: string): Promise<{ ticks: number; trades: number; wins: number; losses: number; grossPaise: number; chargesPaise: number; netPaise: number; avgHoldMs: number; syntheticSpot: boolean }> {
  const marketCfg = loadConfig(MarketProfileSchema, join(CONFIG_DIR, 'market', 'allop-nse-options.json'));
  const riskCfg = loadConfig(RiskProfileSchema, join(CONFIG_DIR, 'risk', 'allop-paper.json'));
  const strategyCfg = loadConfig(StrategyConfigSchema, join(CONFIG_DIR, 'strategy', 'allop-atm-mm.json'));
  const ticks = await loadTicksFromGz(join(TICK_ROOT, date, 'ticks.jsonl.gz'));
  if (ticks.length === 0) throw new Error(`No ticks loaded for ${date}`);
  const recording = discoverRecording(ticks, resolveScripMasterPath());
  const clock = new ManualClock(recording.feedTicks[0]!.ts);
  const marketData = new FeedMarketData({
    spotInstrumentId: recording.spotInstrumentId,
    options: recording.optionSpecs,
    strikeStepPaise: marketCfg.value.contract.strikeStepPaise,
  });
  const firstSpot = recording.feedTicks.find((tick) => tick.instrumentId === recording.spotInstrumentId);
  if (firstSpot !== undefined) marketData.ingest(firstSpot);
  const sessionId = makeSessionId(date, 'paper');
  const ids = new IdFactory(sessionId);
  const broker = new PaperBroker({ clock, tickSizePaise: marketCfg.value.tickSizePaise, slippageTicks: 1, ackLatencyMs: 0, fillLatencyMs: 0, restingFills: true });
  const journalDir = join(SCALPER_ROOT, 'journals', 'allop-atm-mm', 'backtest', date);
  mkdirSync(journalDir, { recursive: true });
  const host = new PaperHost({
    sessionId,
    date,
    mode: 'paper',
    market: marketCfg.value,
    riskProfile: riskCfg.value,
    eligibility: { entryWindows: [{ from: marketCfg.value.session.open, to: marketCfg.value.entryCutoff }], blackoutDates: new Set(), maxSpreadPct: 0.015, minOi: 100, minVolume: 100, strikeBand: 5, strikeStepPaise: marketCfg.value.contract.strikeStepPaise },
    strategy: new AllOpAtmMm(),
    params: strategyCfg.value.params,
    regime: new FeatureRegimeProvider({ view: marketData, clock }),
    cooldownSec: 60,
    broker,
    marketData,
    ids,
    clock,
    journalDir,
    configs: [{ name: 'market', hash: marketCfg.hash, path: marketCfg.path }, { name: 'risk', hash: riskCfg.hash, path: riskCfg.path }, { name: 'strategy', hash: strategyCfg.hash, path: strategyCfg.path }],
    resolveChain: () => ({ expiryDate: recording.optionSpecs[0]!.expiry, chain: new Map(), lotSize: marketCfg.value.contract.lotSize, tickSizePaise: marketCfg.value.tickSizePaise, rowCount: recording.optionSpecs.length }),
    preflightLastTickTs: () => marketData.lastSpotTs(),
    feedStaleMs: 30_000,
    autoArm: true,
    autoAckPreflight: true,
    persistence: 'off',
    quoteSink: (instrumentId, quote) => broker.setQuote(instrumentId, quote),
    runnerFactory: (ports: HostRunnerPorts) => new MmRunner({
      sessionId,
      strategyId: strategyCfg.value.strategyId,
      params: strategyCfg.value.params,
      market: marketCfg.value,
      gate: ports.gate,
      oms: ports.oms,
      escalator: ports.escalator,
      sessionRisk: ports.sessionRisk,
      ids,
      clock: ports.clock,
      view: marketData,
      quoteGates: { maxSpreadPct: 0.015, minOi: 100, minVolume: 100, strikeBand: 5 },
      journal: ports.journal,
      journalHealthy: ports.journalHealthy,
    }),
  });
  const start = await host.start();
  if (start.halted) throw new Error(`Host started halted: ${start.reason ?? 'UNKNOWN'}`);
  let lastTimer = recording.feedTicks[0]!.ts;
  for (const tick of recording.feedTicks) {
    clock.set(Math.max(clock.now(), tick.ts));
    await host.ingestTick(tick);
    if (tick.ts - lastTimer >= 250) { await host.onTimer(tick.ts); lastTimer = tick.ts; }
  }
  const { report } = await host.squareOffAndReport();
  const summary = report.summary;
  return { ticks: recording.feedTicks.length, trades: summary.tradeCount, wins: summary.wins, losses: summary.losses, grossPaise: summary.grossPaise, chargesPaise: summary.chargesPaise, netPaise: summary.netPaise, avgHoldMs: summary.avgHoldMs, syntheticSpot: recording.syntheticSpot };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const date = args.find((_, index) => args[index - 1] === '--date') ?? '2026-07-22';
  const result = await runAllOpReplay(date);
  console.log(`ALL-OP Replay — ${date}`);
  console.log(`  Ticks replayed : ${result.ticks}`);
  console.log(`  Trades         : ${result.trades} (${result.wins}W / ${result.losses}L)`);
  console.log(`  Gross P&L      : ₹${(result.grossPaise / 100).toFixed(2)}`);
  console.log(`  Charges        : ₹${(result.chargesPaise / 100).toFixed(2)}`);
  console.log(`  Net P&L        : ₹${(result.netPaise / 100).toFixed(2)}`);
  console.log(`  Avg hold       : ${Math.round(result.avgHoldMs / 1000)}s`);
  console.log(`  Spot source    : ${result.syntheticSpot ? 'synthetic ATM reference (recording has no native spot)' : 'recorded native spot'}`);
}

if (process.argv[1]?.endsWith('replay-allop.js')) void main().catch((err) => { console.error('replay-allop failed:', err); process.exitCode = 1; });
