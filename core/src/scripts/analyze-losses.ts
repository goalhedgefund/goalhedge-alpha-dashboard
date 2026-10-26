import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema } from '../config/schemas.js';
import { IdFactory, makeSessionId } from '../domain/ids.js';
import { ManualClock, istDayStartMs } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { FeedMarketData } from '../host/feed-market-data.js';
import { PaperHost, type HostRunnerPorts } from '../host/paper-host.js';
import { MmRunner } from '../mm/mm-runner.js';
import { AllOpAtmMm } from '../strategy/strategies/allop-atm-mm.js';
import { discoverPlainRecording, loadTicksForDate, resolveScripMasterPath } from './backtest-recording.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONFIG_DIR = join(SCALPER_ROOT, 'config');
const TICK_ROOT = join(SCALPER_ROOT, 'data', 'dhan', 'ticks-allop-atm-mm');

async function main() {
  const date = process.argv[2] ?? '2026-10-14';
  const allTicks = await loadTicksForDate(join(TICK_ROOT, date));
  allTicks.sort((a, b) => a.ts - b.ts || a.recvTs - b.recvTs);

  const rec = discoverPlainRecording(allTicks, resolveScripMasterPath(date));
  const clock = new ManualClock(allTicks[0]!.ts);
  const marketCfg = loadConfig(MarketProfileSchema, join(CONFIG_DIR, 'market', 'allop-nse-options.json'));
  const riskCfg = loadConfig(RiskProfileSchema, join(CONFIG_DIR, 'risk', 'allop-paper.json'));
  riskCfg.value.capitalPaise = 100_000_000; // 10L paper capital for options
  riskCfg.value.maxLotsPerOrder = 2;
  riskCfg.value.maxConcurrentPositions = 4;
  const strategyCfg = loadConfig(StrategyConfigSchema, join(CONFIG_DIR, 'strategy', 'allop-atm-mm.json'));
  const params = {
    ...strategyCfg.value.params,
    lotsPerOrder: 2,
    maxLotsInventory: 4,
    maxScalpLots: 2,
    runnerLots: 1,
    maxLotsPerSide: 2,
    runnerActivationPct: 1.5,
    runnerTrailPct: 2.5,
    runnerMaxHoldSec: 600,
    quoteFrom: '09:30',
    maxHoldSec: 60,
    hardStopPct: 8,
    adverseStopPct: 3,
    defensiveCooldownSec: 60,
    globalDefensiveCooldownSec: 30,
    globalLossClusterCount: 0,
    trendPct: 0.10,
    trendResumePct: 0.05,
    directionalOnly: true,
    maxEntryFallPct: 0.5,
  };







  const marketData = new FeedMarketData({
    spotInstrumentId: rec.spotInstrumentId,
    options: rec.optionSpecs,
    strikeStepPaise: marketCfg.value.contract.strikeStepPaise,
    sessionFloorMs: istDayStartMs(date),
  });

  const firstSpot = allTicks.find((t) => t.instrumentId === rec.spotInstrumentId);
  if (firstSpot) marketData.ingest(firstSpot);

  const broker = new PaperBroker({
    clock,
    tickSizePaise: marketCfg.value.tickSizePaise,
    slippageTicks: 1,
    ackLatencyMs: 0,
    fillLatencyMs: 0,
    restingFills: true,
    passiveTradeFills: true,
    passiveQueueAheadLots: 0,
  });

  const sessionId = makeSessionId(date, 'paper');
  const ids = new IdFactory(sessionId);
  const trades: any[] = [];

  const host = new PaperHost({
    sessionId,
    date,
    mode: 'paper',
    market: marketCfg.value,
    riskProfile: riskCfg.value,
    eligibility: {
      entryWindows: [{ from: marketCfg.value.session.open, to: marketCfg.value.entryCutoff }],
      blackoutDates: new Set(),
      maxSpreadPct: 0.10,
      minOi: 100,
      minVolume: 100,
      strikeBand: 5,
      strikeStepPaise: marketCfg.value.contract.strikeStepPaise,
    },
    strategy: new AllOpAtmMm(),
    params,
    broker,
    marketData,
    ids,
    clock,
    journalDir: 'C:/temp/allop-loss-analysis-' + Date.now(),
    configs: [],
    resolveChain: () => ({
      expiryDate: rec.optionSpecs[0]!.expiry,
      chain: new Map(),
      lotSize: marketCfg.value.contract.lotSize,
      tickSizePaise: marketCfg.value.tickSizePaise,
      rowCount: rec.optionSpecs.length,
    }),
    preflightLastTickTs: () => marketData.lastSpotTs(),
    feedStaleMs: 30000,
    autoArm: true,
    autoAckPreflight: true,
    persistence: 'off',
    quoteSink: (id, q) => broker.setQuote(id, q),
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
      quoteGates: { maxSpreadPct: 0.10, minOi: 100, minVolume: 100, strikeBand: 5 },
      journal: () => {},
      tradeSink: (t) => trades.push(t),
    }),
  });

  await host.start();
  let lastTimer = allTicks[0]!.ts;
  for (const t of allTicks) {
    clock.set(Math.max(clock.now(), t.ts));
    await host.ingestTick(t);
    if (t.ts - lastTimer >= 250) {
      await host.onTimer(t.ts);
      lastTimer = t.ts;
    }
  }
  const { report } = await host.squareOffAndReport();

  console.log('=== LOSS DETAILS ===');
  const losses = trades.filter((t) => t.netPnlPaise < 0);
  for (const l of losses) {
    const entryTime = new Date(l.entry.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const exitTime = new Date(l.exit.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    console.log(`${entryTime}->${exitTime} | Right: ${l.right} | Strike: ${l.strikePaise/100} | Entry: ₹${(l.entry.pricePaise/100).toFixed(2)} | Exit: ₹${(l.exit.pricePaise/100).toFixed(2)} | Hold: ${Math.round(l.holdMs/1000)}s | ${l.exitReason} | Net: ₹${(l.netPnlPaise/100).toFixed(2)}`);
  }

  console.log('\n=== SUMMARY BY RIGHT ===');
  const ceTrades = trades.filter((t) => t.right === 'CE');
  const peTrades = trades.filter((t) => t.right === 'PE');
  const ceNet = ceTrades.reduce((s, t) => s + t.netPnlPaise, 0);
  const peNet = peTrades.reduce((s, t) => s + t.netPnlPaise, 0);
  console.log(`CE: ${ceTrades.length} trades | Wins: ${ceTrades.filter(t => t.netPnlPaise > 0).length} | Net: ₹${(ceNet/100).toFixed(2)}`);
  console.log(`PE: ${peTrades.length} trades | Wins: ${peTrades.filter(t => t.netPnlPaise > 0).length} | Net: ₹${(peNet/100).toFixed(2)}`);

  console.log('\n=== EXIT REASON SUMMARY ===');
  for (const r of report.byExitReason) {
    console.log(`${r.reason.padEnd(16)}: ${r.count} trades | Net ₹${(r.netPaise/100).toFixed(2)}`);
  }

  const wins = trades.filter((t) => t.netPnlPaise > 0);
  const winHolds = wins.map(w => w.holdMs / 1000);
  const avgWinHold = winHolds.reduce((a, b) => a + b, 0) / (winHolds.length || 1);
  console.log(`\nWins: count=${wins.length}, avgHold=${avgWinHold.toFixed(1)}s, maxHold=${Math.max(...winHolds, 0)}s, minHold=${Math.min(...winHolds, 0)}s`);

  console.log('\n=== HOLD TIME BUCKETS ===');
  const buckets = [
    { label: '<= 15s', min: 0, max: 15 },
    { label: '15s - 30s', min: 15, max: 30 },
    { label: '30s - 60s', min: 30, max: 60 },
    { label: '60s - 120s', min: 60, max: 120 },
    { label: '> 120s', min: 120, max: 99999 },
  ];
  for (const b of buckets) {
    const ts = trades.filter(t => (t.holdMs / 1000) > b.min && (t.holdMs / 1000) <= b.max);
    const w = ts.filter(t => t.netPnlPaise > 0);
    const l = ts.filter(t => t.netPnlPaise < 0);
    const net = ts.reduce((s, t) => s + t.netPnlPaise, 0);
    console.log(`${b.label.padEnd(12)}: Total ${ts.length} | Wins ${w.length} | Losses ${l.length} | WinRate ${ts.length ? ((w.length/ts.length)*100).toFixed(1) : 0}% | Net ₹${(net/100).toFixed(2)}`);
  }
}


main().catch(console.error);
