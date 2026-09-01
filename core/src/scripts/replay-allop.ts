/** Backtest-only single-session replay for the live ALL-OP market-maker. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema } from '../config/schemas.js';
import { IdFactory, makeSessionId, type ClientOrderId } from '../domain/ids.js';
import type { Trade } from '../domain/positions.js';
import { ManualClock } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { FeedMarketData } from '../host/feed-market-data.js';
import { PaperHost, type HostRunnerPorts } from '../host/paper-host.js';
import { MmRunner, type MmEntryDecision } from '../mm/mm-runner.js';
import { FeatureRegimeProvider } from '../strategy/regime.js';
import { AllOpAtmMm } from '../strategy/strategies/allop-atm-mm.js';
import type { StrategyParams } from '../strategy/types.js';
import {
  discoverPlainRecording,
  loadTicksFromGz,
  resolveScripMasterPath,
  type DiscoveredRecording,
} from './backtest-recording.js';

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_DIR = join(SCALPER_ROOT, 'config');
const TICK_ROOT = join(SCALPER_ROOT, 'data', 'dhan', 'ticks-allop-atm-mm');
const recordingCache = new Map<string, Promise<DiscoveredRecording>>();

export interface AllOpReplayResult {
  ticks: number;
  trades: number;
  wins: number;
  losses: number;
  entrySubmissions: number;
  grossPaise: number;
  chargesPaise: number;
  netPaise: number;
  avgHoldMs: number;
  syntheticSpot: boolean;
  byExitReason: Array<{ reason: string; count: number; netPaise: number }>;
  entryOutcomes: AllOpReplayEntryOutcome[];
}

export interface AllOpReplayEntryOutcome extends MmEntryDecision {
  fillTs: number;
  entryPricePaise: number;
  exitTs: number;
  exitPricePaise: number;
  exitReason: string;
  holdMs: number;
  grossPnlPaise: number;
  chargesPaise: number;
  netPnlPaise: number;
}

export async function runAllOpReplay(
  date: string,
  paramOverrides: StrategyParams = {},
): Promise<AllOpReplayResult> {
  const marketCfg = loadConfig(MarketProfileSchema, join(CONFIG_DIR, 'market', 'allop-nse-options.json'));
  const riskCfg = loadConfig(RiskProfileSchema, join(CONFIG_DIR, 'risk', 'allop-paper.json'));
  const strategyCfg = loadConfig(StrategyConfigSchema, join(CONFIG_DIR, 'strategy', 'allop-atm-mm.json'));
  const params = { ...strategyCfg.value.params, ...paramOverrides };
  const recording = await recordingForDate(date);
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
  const entryDecisions = new Map<ClientOrderId, MmEntryDecision>();
  const completedTrades: Trade[] = [];
  const broker = new PaperBroker({
    clock,
    tickSizePaise: marketCfg.value.tickSizePaise,
    slippageTicks: 1,
    ackLatencyMs: 0,
    fillLatencyMs: 0,
    restingFills: true,
    passiveTradeFills: true,
    passiveQueueAheadLots: Number(params.paperQueueAheadLots ?? 2),
  });
  // Every replay is isolated. Reusing a dated journal would recover the prior
  // run and contaminate comparisons between strategy versions.
  const journalDir = mkdtempSync(join(tmpdir(), `allop-replay-${date}-`));
  const host = new PaperHost({
    sessionId,
    date,
    mode: 'paper',
    market: marketCfg.value,
    riskProfile: riskCfg.value,
    eligibility: {
      entryWindows: [{ from: marketCfg.value.session.open, to: marketCfg.value.entryCutoff }],
      blackoutDates: new Set(),
      maxSpreadPct: 0.015,
      minOi: 100,
      minVolume: 100,
      strikeBand: 5,
      strikeStepPaise: marketCfg.value.contract.strikeStepPaise,
    },
    strategy: new AllOpAtmMm(),
    params,
    regime: new FeatureRegimeProvider({ view: marketData, clock }),
    cooldownSec: 60,
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
      lotSize: marketCfg.value.contract.lotSize,
      tickSizePaise: marketCfg.value.tickSizePaise,
      rowCount: recording.optionSpecs.length,
    }),
    preflightLastTickTs: () => marketData.lastSpotTs(),
    feedStaleMs: 30_000,
    autoArm: true,
    autoAckPreflight: true,
    persistence: 'off',
    quoteSink: (instrumentId, quote) => broker.setQuote(instrumentId, quote),
    runnerFactory: (ports: HostRunnerPorts) => new MmRunner({
      sessionId,
      strategyId: strategyCfg.value.strategyId,
      params,
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
      entryDecisionSink: (decision) => entryDecisions.set(decision.clientOrderId, decision),
      tradeSink: (trade) => completedTrades.push(trade),
    }),
  });
  const start = await host.start();
  if (start.halted) throw new Error(`Host started halted: ${start.reason ?? 'UNKNOWN'}`);
  let lastTimer = recording.feedTicks[0]!.ts;
  for (const tick of recording.feedTicks) {
    clock.set(Math.max(clock.now(), tick.ts));
    await host.ingestTick(tick);
    if (tick.ts - lastTimer >= 250) {
      await host.onTimer(tick.ts);
      lastTimer = tick.ts;
    }
  }
  const { report } = await host.squareOffAndReport();
  const summary = report.summary;
  return {
    ticks: recording.feedTicks.length,
    trades: summary.tradeCount,
    wins: summary.wins,
    losses: summary.losses,
    entrySubmissions: entryDecisions.size,
    grossPaise: summary.grossPaise,
    chargesPaise: summary.chargesPaise,
    netPaise: summary.netPaise,
    avgHoldMs: summary.avgHoldMs,
    syntheticSpot: recording.syntheticSpot,
    byExitReason: report.byExitReason.map((row) => ({ ...row })),
    entryOutcomes: completedTrades.flatMap((trade) => {
      const decision = entryDecisions.get(trade.entry.clientOrderId);
      if (decision === undefined) return [];
      return [{
        ...decision,
        fillTs: trade.entry.ts,
        entryPricePaise: trade.entry.pricePaise,
        exitTs: trade.exit.ts,
        exitPricePaise: trade.exit.pricePaise,
        exitReason: trade.exitReason,
        holdMs: trade.holdMs,
        grossPnlPaise: trade.grossPnlPaise,
        chargesPaise: trade.charges.totalPaise,
        netPnlPaise: trade.netPnlPaise,
      }];
    }),
  };
}

async function recordingForDate(date: string): Promise<DiscoveredRecording> {
  let pending = recordingCache.get(date);
  if (pending === undefined) {
    pending = loadTicksFromGz(join(TICK_ROOT, date, 'ticks.jsonl.gz')).then((ticks) => {
      if (ticks.length === 0) throw new Error(`No ticks loaded for ${date}`);
      return discoverPlainRecording(ticks, resolveScripMasterPath());
    });
    recordingCache.set(date, pending);
  }
  return pending;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const date = args.find((_, index) => args[index - 1] === '--date') ?? '2026-07-22';
  const result = await runAllOpReplay(date, parseOverrides(args));
  console.log(`ALL-OP Replay - ${date}`);
  console.log(`  Ticks replayed : ${result.ticks}`);
  console.log(`  Trades         : ${result.trades} (${result.wins}W / ${result.losses}L)`);
  console.log(`  Broker entries : ${result.entrySubmissions}`);
  console.log(`  Gross P&L      : Rs${(result.grossPaise / 100).toFixed(2)}`);
  console.log(`  Charges        : Rs${(result.chargesPaise / 100).toFixed(2)}`);
  console.log(`  Net P&L        : Rs${(result.netPaise / 100).toFixed(2)}`);
  console.log(`  Avg hold       : ${Math.round(result.avgHoldMs / 1_000)}s`);
  for (const row of result.byExitReason) {
    console.log(`  Exit ${row.reason.padEnd(14)}: ${row.count} / Rs${(row.netPaise / 100).toFixed(2)}`);
  }
  console.log(
    `  Spot source    : ${result.syntheticSpot
      ? 'synthetic ATM reference (recording has no native spot)'
      : 'recorded native spot'}`,
  );
}

function parseOverrides(args: readonly string[]): StrategyParams {
  const params: StrategyParams = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--set') continue;
    const assignment = args[index + 1];
    if (assignment === undefined) throw new Error('--set requires key=value');
    const separator = assignment.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid --set value: ${assignment}`);
    const key = assignment.slice(0, separator);
    const raw = assignment.slice(separator + 1);
    if (raw === 'true' || raw === 'false') params[key] = raw === 'true';
    else if (raw !== '' && Number.isFinite(Number(raw))) params[key] = Number(raw);
    else params[key] = raw;
    index += 1;
  }
  return params;
}

if (process.argv[1]?.endsWith('replay-allop.js')) {
  void main().catch((err) => {
    console.error('replay-allop failed:', err);
    process.exitCode = 1;
  });
}
