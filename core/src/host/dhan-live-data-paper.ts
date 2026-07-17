import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema, type MarketProfile } from '../config/schemas.js';
import type { JournalPayloads } from '../domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { systemClock } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { DhanFeed } from '../feed/dhan/feed.js';
import { Recorder } from '../feed/recorder.js';
import type { SubscribeRequest } from '../feed/interface.js';
import { Gateway } from '../gateway/gateway.js';
import { registerKillCommands, registerRunnerCommands, registerSessionCommands } from '../gateway/commands.js';
import type { GatewayState } from '../gateway/protocol.js';
import {
  getChainStrikes,
  loadScripMaster,
  resolveNiftyWeeklyChain,
  toInstrument,
  type ScripRow,
  type WeeklyChainResult,
} from '../marketdata/instrument-master.js';
import type { IStrategy } from '../strategy/types.js';
import { FeatureRegimeProvider } from '../strategy/regime.js';
import { AllOpAtmMm } from '../strategy/strategies/allop-atm-mm.js';
import { S1MomentumBurst } from '../strategy/strategies/s1-momentum-burst.js';
import { S2VwapFade } from '../strategy/strategies/s2-vwap-fade.js';
import { FeedMarketData, type OptionSpec } from './feed-market-data.js';
import { loadDhanLiveDataPaperEnv, type DhanLiveDataPaperEnv } from './dhan-live-data-paper-env.js';
import { PaperHost, type HostRunnerPorts } from './paper-host.js';
import { MmRunner } from '../mm/mm-runner.js';

interface DhanLiveDataPaperBuild {
  host: PaperHost;
  gateway: Gateway;
  feed: DhanFeed;
  recorder: Recorder;
  subscriptions: SubscribeRequest[];
  journalDir: string;
  tickDir: string;
  selectedStrikes: number[];
  initialSpotPaise: number;
  disabledStrategyConfig: boolean;
}

const IST_OFFSET_MS = 330 * 60_000;

function istDate(nowMs = Date.now()): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

function resolveRepoPath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

function initialGatewayState(
  sessionId: string,
  date: string,
  strategyId: string,
  params: Record<string, number | string | boolean>,
  riskProfile: ReturnType<typeof RiskProfileSchema.parse>,
  chain: FeedMarketData,
): GatewayState {
  return {
    session: { sessionId, mode: 'paper', phase: 'BOOTING', date },
    kill: { state: 'READY' },
    health: { feedStatus: 'DISCONNECTED', lastTickTs: 0, gatewayTs: Date.now() },
    algo: { strategyId, lifecycle: 'DISARMED', params },
    risk: {
      snapshot: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
      limits: {
        dailyMaxLossPaise: Math.round(riskProfile.capitalPaise * (riskProfile.dailyMaxLossPct / 100)),
        perTradeRiskPaise: Math.round(riskProfile.capitalPaise * (riskProfile.perTradeRiskPct / 100)),
        maxTradesPerDay: riskProfile.maxTradesPerDay,
        maxConcurrentPositions: riskProfile.maxConcurrentPositions,
      },
    },
    positions: [],
    orders: [],
    trades: [],
    chain: chain.chainRows(),
    bars: [],
    events: [],
  };
}

function pickInitialSpotPaise(weekly: WeeklyChainResult, env: DhanLiveDataPaperEnv): number {
  if (env.initialSpotPaise !== undefined) return env.initialSpotPaise;
  const strikes = Array.from(weekly.chain.keys()).sort((a, b) => a - b);
  const middle = strikes[Math.floor(strikes.length / 2)];
  if (middle === undefined) throw new Error('Resolved Dhan weekly chain has no strikes');
  console.warn(
    `[scalper] DHAN_INITIAL_SPOT_* not set; bootstrapping preflight from median strike ${formatPaise(middle)}. Live IDX_I ticks will replace it.`,
  );
  return middle;
}

function buildOptionSpecs(
  weekly: WeeklyChainResult,
  selectedStrikes: number[],
  optionExchangeSegment: string,
): { options: OptionSpec[]; subscriptions: SubscribeRequest[] } {
  const options: OptionSpec[] = [];
  const subscriptions: SubscribeRequest[] = [];

  for (const strike of selectedStrikes) {
    const entry = weekly.chain.get(strike);
    for (const row of [entry?.ce, entry?.pe]) {
      if (row === undefined) continue;
      const instrument = toInstrument(row);
      const right = row.optionType === 'CE' || row.optionType === 'PE' ? row.optionType : undefined;
      if (right === undefined) continue;
      options.push({
        instrumentId: instrument.id,
        strikePaise: row.strikePaise,
        right,
        expiry: row.expiryDate,
      });
      subscriptions.push({
        exchangeSegment: optionExchangeSegment,
        brokerToken: row.securityId,
        instrumentId: instrument.id,
      });
    }
  }

  return { options, subscriptions };
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

function latestWeeklyChain(rows: ScripRow[], date: string, underlying: string): WeeklyChainResult {
  if (underlying !== 'NIFTY') {
    throw new Error(`Only NIFTY weekly chain is wired today; got DHAN_UNDERLYING_SYMBOL=${underlying}`);
  }
  const weekly = resolveNiftyWeeklyChain(rows, date);
  if (weekly === undefined) {
    throw new Error(`Could not resolve NIFTY weekly chain for ${date}. Check DHAN_SCRIP_MASTER_PATH.`);
  }
  return weekly;
}

function marketWithLiveChainFacts(market: MarketProfile, weekly: WeeklyChainResult): MarketProfile {
  return {
    ...market,
    tickSizePaise: weekly.tickSizePaise,
    contract: {
      ...market.contract,
      lotSize: weekly.lotSize,
    },
  };
}

function makeStrategy(strategyId: string): IStrategy {
  switch (strategyId) {
    case 's1-momentum-burst':
      return new S1MomentumBurst();
    case 's2-vwap-fade':
      return new S2VwapFade();
    case 'allop-atm-mm':
      return new AllOpAtmMm();
    default:
      throw new Error(`Unsupported DHAN_STRATEGY_ID=${strategyId}`);
  }
}

function buildDhanLiveDataPaper(env: DhanLiveDataPaperEnv): DhanLiveDataPaperBuild {
  const root = repoRoot();
  const configDir = new URL('../../../config/', import.meta.url);
  const date = istDate();
  const sessionId = makeSessionId(date, 'paper');
  // ALL_OP quotes to a later cutoff (15:10) and squares off at 15:15, with an
  // MM-shaped risk profile (many small round trips, 1-lot orders); S1/S2 keep
  // the momentum-desk profiles.
  const isMm = env.strategyId === 'allop-atm-mm';
  const marketCfg = loadConfig(
    MarketProfileSchema,
    fileURLToPath(new URL(isMm ? 'market/allop-nse-options.json' : 'market/india-nse-options.json', configDir)),
  );
  const riskCfg = loadConfig(
    RiskProfileSchema,
    fileURLToPath(new URL(isMm ? 'risk/allop-paper.json' : 'risk/paper-default.json', configDir)),
  );
  const strategyCfg = loadConfig(StrategyConfigSchema, fileURLToPath(new URL(`strategy/${env.strategyId}.json`, configDir)));
  if (strategyCfg.value.strategyId !== env.strategyId) {
    throw new Error(`Strategy config id mismatch: requested ${env.strategyId}, file declares ${strategyCfg.value.strategyId}`);
  }

  const scripMasterPath = resolveRepoPath(root, env.scripMasterPath);
  const scripRows = loadScripMaster(scripMasterPath);
  const weekly = latestWeeklyChain(scripRows, date, env.underlyingSymbol);
  const market = marketWithLiveChainFacts(marketCfg.value, weekly);
  const initialSpotPaise = pickInitialSpotPaise(weekly, env);
  const selectedStrikes = getChainStrikes(weekly.chain, initialSpotPaise, env.chainDepth);
  const { options, subscriptions: optionSubscriptions } = buildOptionSpecs(weekly, selectedStrikes, env.optionExchangeSegment);
  if (options.length === 0) throw new Error('No Dhan option instruments selected from the weekly chain');

  const spotInstrumentId = makeInstrumentId('NSE', `${env.underlyingSymbol}_SPOT`);
  const marketData = new FeedMarketData({
    spotInstrumentId,
    options,
    strikeStepPaise: market.contract.strikeStepPaise,
    chainDepth: env.chainDepth,
  });
  primeSpot(marketData, spotInstrumentId, initialSpotPaise);

  const journalDir = join(resolveRepoPath(root, env.journalRoot), date, 'dhan-live-data-paper');
  const tickDir = join(resolveRepoPath(root, env.recorderRoot), date);
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(tickDir, { recursive: true });

  const paper = new PaperBroker({
    clock: systemClock,
    tickSizePaise: market.tickSizePaise,
    slippageTicks: env.paperSlippageTicks,
    ackLatencyMs: env.paperAckLatencyMs,
    fillLatencyMs: env.paperFillLatencyMs,
    // MM quotes rest passively below mid and must fill when the touch arrives.
    restingFills: isMm,
  });
  const recorder = new Recorder({ dir: tickDir, compression: 'gzip' });
  const ids = new IdFactory(sessionId);
  const strategy = makeStrategy(strategyCfg.value.strategyId);
  const commandJournal = { host: undefined as PaperHost | undefined };
  const gateway = new Gateway({
    port: env.gatewayPort,
    initialState: initialGatewayState(sessionId, date, strategy.id, strategyCfg.value.params, riskCfg.value, marketData),
    journal: (type, payload) => {
      if (type === 'command.received') {
        commandJournal.host?.journalGatewayCommand(type, payload as JournalPayloads['command.received']);
      } else if (type === 'command.acked') {
        commandJournal.host?.journalGatewayCommand(type, payload as JournalPayloads['command.acked']);
      }
    },
  });
  const host = new PaperHost({
    sessionId,
    date,
    mode: 'paper',
    market,
    riskProfile: riskCfg.value,
    eligibility: {
      entryWindows: [{ from: market.session.open, to: market.entryCutoff }],
      blackoutDates: new Set(),
      maxSpreadPct: env.maxSpreadPct,
      minOi: env.minOi,
      minVolume: env.minVolume,
      strikeBand: env.chainDepth,
      strikeStepPaise: market.contract.strikeStepPaise,
    },
    strategy,
    params: strategyCfg.value.params,
    regime: new FeatureRegimeProvider({
      view: marketData,
      clock: systemClock,
      trendRet30Pct: env.regimeTrendRet30Pct,
      trendVwapPct: env.regimeTrendVwapPct,
      highVolRet30Pct: env.regimeHighVolRet30Pct,
      highVolAtrPct: env.regimeHighVolAtrPct,
    }),
    ...(typeof strategyCfg.value.params.cooldownSec === 'number' ? { cooldownSec: strategyCfg.value.params.cooldownSec } : {}),
    broker: paper,
    marketData,
    ids,
    clock: systemClock,
    journalDir,
    configs: [
      { name: 'market', hash: marketCfg.hash, path: marketCfg.path },
      { name: 'risk', hash: riskCfg.hash, path: riskCfg.path },
      { name: 'strategy', hash: strategyCfg.hash, path: strategyCfg.path },
    ],
    resolveChain: () => weekly,
    feedStaleMs: env.feedStaleMs,
    autoArm: env.autoArm && strategyCfg.value.enabled,
    recorder,
    gateway,
    quoteSink: (instrumentId, quote) => paper.setQuote(instrumentId, quote),
    ...(isMm
      ? {
          runnerFactory: (ports: HostRunnerPorts) =>
            new MmRunner({
              sessionId,
              strategyId: env.strategyId,
              params: strategyCfg.value.params,
              market,
              gate: ports.gate,
              oms: ports.oms,
              sessionRisk: ports.sessionRisk,
              ids,
              clock: ports.clock,
              view: marketData,
              quoteGates: {
                maxSpreadPct: env.maxSpreadPct,
                minOi: env.minOi,
                minVolume: env.minVolume,
                strikeBand: env.chainDepth,
              },
              journal: ports.journal,
              journalHealthy: ports.journalHealthy,
            }),
        }
      : {}),
  });
  commandJournal.host = host;
  const feed = new DhanFeed({
    wsUrl: env.wsUrl,
    clientId: env.clientId,
    accessToken: env.accessToken,
    requestCode: env.feedRequestCode,
  });
  const subscriptions: SubscribeRequest[] = [
    {
      exchangeSegment: env.spotExchangeSegment,
      brokerToken: env.spotSecurityId,
      instrumentId: spotInstrumentId,
      requestCode: 15,
    },
    ...optionSubscriptions,
  ];

  return {
    host,
    gateway,
    feed,
    recorder,
    subscriptions,
    journalDir,
    tickDir,
    selectedStrikes,
    initialSpotPaise,
    disabledStrategyConfig: !strategyCfg.value.enabled,
  };
}

async function main(): Promise<void> {
  const env = loadDhanLiveDataPaperEnv();
  const build = buildDhanLiveDataPaper(env);
  await build.gateway.ready();
  console.log(`[scalper] gateway listening on ws://127.0.0.1:${build.gateway.port()}`);
  console.log(`[scalper] journal: ${build.journalDir}`);
  console.log(`[scalper] ticks: ${build.tickDir}`);
  console.log(`[scalper] selected strikes: ${build.selectedStrikes.map(formatPaise).join(', ')}`);
  if (build.disabledStrategyConfig) {
    console.warn('[scalper] strategy config is enabled=false; auto-arm and UI ARM are blocked until the config is enabled.');
  }

  await build.feed.connect();
  console.log('[scalper] connected to Dhan live market feed');

  const started = await build.host.start();
  if (started.halted) {
    console.warn(`[scalper] host started halted: ${started.reason ?? 'UNKNOWN'}`);
  }

  registerRunnerCommands(
    build.gateway,
    {
      arm: () => build.host.arm(),
      disarm: () => build.host.disarm(),
      setParams: (params) => build.host.setParams(params),
      state: () => build.host.runnerState(),
    },
    {
      isLocked: () => build.host.killLocked(),
      canArm: () => {
        if (build.disabledStrategyConfig) return { ok: false, reason: 'STRATEGY_DISABLED' };
        return build.host.canArm();
      },
    },
  );
  registerKillCommands(build.gateway, {
    trip: (source, reason) => build.host.tripKill(source, reason),
    rearm: (confirm, reason) => build.host.rearmKill(confirm, reason),
    isLocked: () => build.host.killLocked(),
  });
  registerSessionCommands(build.gateway, {
    acknowledge: (operator) => build.host.acknowledgePreflight(operator),
  });

  let tickChain = Promise.resolve();
  build.feed.setTickHandler((tick: Tick) => {
    tickChain = tickChain
      .then(() => build.host.ingestTick(tick))
      .catch((err: unknown) => {
        console.error('[scalper] tick ingestion failed:', err);
        void build.host.tripKill('AUTO', 'TICK_INGESTION_FAILED');
      });
  });
  build.feed.subscribe(build.subscriptions);
  console.log(`[scalper] subscribed ${build.subscriptions.length} Dhan instruments; initial spot ${formatPaise(build.initialSpotPaise)}`);

  const timer = setInterval(() => {
    void build.host.onTimer(Date.now()).catch((err: unknown) => {
      console.error('[scalper] timer failed:', err);
      void build.host.tripKill('AUTO', 'HOST_TIMER_FAILED');
    });
  }, env.timerIntervalMs);

  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    console.log(`[scalper] shutting down (${reason})`);
    try {
      await tickChain;
      await build.host.squareOffAndReport();
    } catch (err) {
      console.error('[scalper] square-off/report failed:', err);
      try {
        await build.host.close();
      } catch {
        /* ignore close failure during shutdown */
      }
      process.exitCode = 1;
    } finally {
      await build.feed.close();
      await build.recorder.close();
      await build.gateway.close();
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

function formatPaise(paise: number): string {
  return (paise / 100).toFixed(2);
}

void main().catch((err: unknown) => {
  console.error('[scalper] Dhan live-data paper runner failed:', err);
  process.exitCode = 1;
});
