import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, StrategyConfigSchema, type MarketProfile } from '../config/schemas.js';
import type { JournalPayloads } from '../domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { systemClock, istDayStartMs } from '../domain/time.js';
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
  resolveNiftyCurrentFuture,
  resolveNiftyOptionChain,
  toInstrument,
  type ScripRow,
  type WeeklyChainResult,
} from '../marketdata/instrument-master.js';
import type { IStrategy } from '../strategy/types.js';
import { FeatureRegimeProvider } from '../strategy/regime.js';
import { AllOpAtmMm } from '../strategy/strategies/allop-atm-mm.js';
import { OpMinusAtmShort } from '../strategy/strategies/op-minus-atm-short.js';
import { S1MomentumBurst } from '../strategy/strategies/s1-momentum-burst.js';
import { S2VwapFade } from '../strategy/strategies/s2-vwap-fade.js';
import { FeedMarketData, type OptionSpec } from './feed-market-data.js';
import { loadDhanLiveDataPaperEnv, type DhanLiveDataPaperEnv } from './dhan-live-data-paper-env.js';
import { PaperHost, type HostRunnerPorts } from './paper-host.js';
import { MmRunner } from '../mm/mm-runner.js';
import { OpMinusRunner } from '../mm/op-minus-runner.js';

interface DhanLiveDataPaperBuild {
  host: PaperHost;
  gateway: Gateway;
  feed: DhanFeed;
  recorder: Recorder;
  subscriptions: SubscribeRequest[];
  notePreflightTick: (tick: Tick) => boolean;
  /**
   * Record a spot tick's arrival for the preflight freshness probe WITHOUT
   * ingesting it. Once `startFeedForPreflight` hands the feed over to the live
   * handler, `PaperHost.ingestTick` owns ingestion — but the timestamp
   * `preflightLastTickTs` reads is host-external, so it must still be advanced
   * here or feed freshness can never recover mid-session.
   */
  noteSpotArrival: (tick: Tick) => void;
  journalDir: string;
  tickDir: string;
  selectedStrikes: number[];
  initialSpotPaise: number;
  disabledStrategyConfig: boolean;
  /** Recentre the option subscription band on the actual live spot after preflight. */
  recentreSubscriptions: () => void;
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

function latestWeeklyChain(
  rows: ScripRow[],
  date: string,
  underlying: string,
  minDaysToExpiry = 0,
): WeeklyChainResult {
  if (underlying !== 'NIFTY') {
    throw new Error(`Only NIFTY weekly chain is wired today; got DHAN_UNDERLYING_SYMBOL=${underlying}`);
  }
  const weekly = resolveNiftyOptionChain(rows, date, minDaysToExpiry);
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
    case 'op-minus-atm-short':
      return new OpMinusAtmShort();
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
  const isAllOp = env.strategyId === 'allop-atm-mm';
  const isOpMinus = env.strategyId === 'op-minus-atm-short';
  const isMm = isAllOp || isOpMinus;
  const marketCfg = loadConfig(
    MarketProfileSchema,
    fileURLToPath(new URL(isMm ? 'market/allop-nse-options.json' : 'market/india-nse-options.json', configDir)),
  );
  const riskCfg = loadConfig(
    RiskProfileSchema,
    fileURLToPath(new URL(isOpMinus ? 'risk/op-minus-paper.json' : isAllOp ? 'risk/allop-paper.json' : 'risk/paper-default.json', configDir)),
  );
  const strategyCfg = loadConfig(StrategyConfigSchema, fileURLToPath(new URL(`strategy/${env.strategyId}.json`, configDir)));
  if (strategyCfg.value.strategyId !== env.strategyId) {
    throw new Error(`Strategy config id mismatch: requested ${env.strategyId}, file declares ${strategyCfg.value.strategyId}`);
  }
  const scripMasterPath = resolveRepoPath(root, env.scripMasterPath);
  const scripRows = loadScripMaster(scripMasterPath);
  // ALL_OP never quotes a contract on its own expiry day (minDaysToExpiry=1
  // rolls to the next weekly); S1/S2 configs omit the param and keep DTE 0.
  const minDaysToExpiry =
    typeof strategyCfg.value.params.minDaysToExpiry === 'number'
      ? Math.max(0, Math.floor(strategyCfg.value.params.minDaysToExpiry))
      : 0;
  const weekly = latestWeeklyChain(scripRows, date, env.underlyingSymbol, minDaysToExpiry);
  const market = marketWithLiveChainFacts(marketCfg.value, weekly);
  // Every strategy trades the market profile's own window. S1 previously
  // overrode it (09:20–15:25, square-off 15:30) which pushed square-off onto
  // the exchange close with no retry runway; it now shares the base schedule.
  const strategyMarket = market;
  const initialSpotPaise = pickInitialSpotPaise(weekly, env);
  const selectedStrikes = getChainStrikes(weekly.chain, initialSpotPaise, env.chainDepth);
  const { options, subscriptions: optionSubscriptions } = buildOptionSpecs(weekly, selectedStrikes, env.optionExchangeSegment);
  if (options.length === 0) throw new Error('No Dhan option instruments selected from the weekly chain');

  // Resolve the spot feed instrument. Index (IDX_I) sends qty=0 on every tick
  // so VWAP never computes. Default to NIFTY current-month futures (FUTIDX)
  // which carry real volume. Override via DHAN_SPOT_SECURITY_ID / DHAN_SPOT_EXCHANGE_SEGMENT.
  let spotBrokerToken = env.spotSecurityId;
  let spotSegment = env.spotExchangeSegment;
  if (!spotBrokerToken || !spotSegment) {
    const futRow = resolveNiftyCurrentFuture(scripRows, date);
    if (futRow === undefined) {
      throw new Error(
        `Could not resolve NIFTY current-month futures from ${env.scripMasterPath}. ` +
        `Set DHAN_SPOT_SECURITY_ID + DHAN_SPOT_EXCHANGE_SEGMENT to use a manual override.`,
      );
    }
    spotBrokerToken = futRow.securityId;
    spotSegment = env.optionExchangeSegment;
    console.log(`[scalper] spot feed: NIFTY futures ${futRow.tradingSymbol} (id=${spotBrokerToken}, expiry=${futRow.expiryDate})`);
  }

  const spotInstrumentId = makeInstrumentId('NSE', spotBrokerToken);
  let liveSpotTickTs = 0;
  const marketData = new FeedMarketData({
    spotInstrumentId,
    options,
    strikeStepPaise: market.contract.strikeStepPaise,
    chainDepth: env.chainDepth,
    // Reject prior-day carryover/reconnect snapshots (stale exchange ts) so the
    // session VWAP is not seeded with the previous close.
    sessionFloorMs: istDayStartMs(date),
  });
  primeSpot(marketData, spotInstrumentId, initialSpotPaise);

  const journalDir = join(resolveRepoPath(root, env.journalRoot), date, 'dhan-live-data-paper');
  const tickDir = join(resolveRepoPath(root, env.recorderRoot), date);
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(tickDir, { recursive: true });

  const paper = new PaperBroker({
    clock: systemClock,
    tickSizePaise: strategyMarket.tickSizePaise,
    slippageTicks: env.paperSlippageTicks,
    ackLatencyMs: env.paperAckLatencyMs,
    fillLatencyMs: env.paperFillLatencyMs,
    // MM quotes rest passively below mid and must fill when the touch arrives.
    restingFills: isMm,
    passiveTradeFills: isAllOp,
    passiveQueueAheadLots: Number(strategyCfg.value.params.paperQueueAheadLots ?? 2),
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
    market: strategyMarket,
    riskProfile: riskCfg.value,
    eligibility: {
      entryWindows: [{ from: strategyMarket.session.open, to: strategyMarket.entryCutoff }],
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
    preflightLastTickTs: () => liveSpotTickTs,
    feedStaleMs: env.feedStaleMs,
    autoArm: env.autoArm && strategyCfg.value.enabled,
    autoAckPreflight: env.autoArm && strategyCfg.value.enabled,
    // OP(-): a FEED_STALE trip flattens the naked shorts and locks; once the
    // feed streams again for 60s the desk may resume, at most twice a day.
    // Every other trip reason stays operator-only (typed REARM).
    ...(isOpMinus ? { autoRearmFeedRecovery: { stableMs: 60_000, maxPerDay: 2 } } : {}),
    recorder,
    gateway,
    quoteSink: (instrumentId, quote) => paper.setQuote(instrumentId, quote),
    ...(isAllOp
      ? {
          runnerFactory: (ports: HostRunnerPorts) =>
            new MmRunner({
              sessionId,
              strategyId: env.strategyId,
              params: strategyCfg.value.params,
              market,
              gate: ports.gate,
              oms: ports.oms,
              escalator: ports.escalator,
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
      : isOpMinus
        ? {
            runnerFactory: (ports: HostRunnerPorts) =>
              new OpMinusRunner({
                sessionId,
                strategyId: env.strategyId,
                params: strategyCfg.value.params,
                market,
                scalpExpiry: weekly.expiryDate,
                gate: ports.gate,
                oms: ports.oms,
                escalator: ports.escalator,
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
    accessToken: () => loadDhanLiveDataPaperEnv().accessToken,
    requestCode: env.feedRequestCode,
  });
  const subscriptions: SubscribeRequest[] = [
    {
      exchangeSegment: spotSegment,
      brokerToken: spotBrokerToken,
      instrumentId: spotInstrumentId,
    },
    ...optionSubscriptions,
  ];
  const noteSpotArrival = (tick: Tick): void => {
    if (marketData.classify(tick) !== 'spot') return;
    const observedTs = Math.min(tick.recvTs, Date.now());
    if (observedTs > liveSpotTickTs) liveSpotTickTs = observedTs;
  };
  const notePreflightTick = (tick: Tick): boolean => {
    if (marketData.classify(tick) !== 'spot') return false;
    noteSpotArrival(tick);
    marketData.ingest(tick);
    return true;
  };

  return {
    host,
    gateway,
    feed,
    recorder,
    subscriptions,
    notePreflightTick,
    noteSpotArrival,
    journalDir,
    tickDir,
    selectedStrikes,
    initialSpotPaise,
    disabledStrategyConfig: !strategyCfg.value.enabled,
    recentreSubscriptions: (): void => {
      // After the first live spot tick arrives, the ATM may differ from the
      // static median used at build time. Resubscribe any strikes that fall
      // in the live ATM band but weren't in the original subscription set.
      const liveSpot = marketData.spotPaise();
      if (liveSpot === undefined || liveSpot <= 0) return;
      const liveStrikes = getChainStrikes(weekly.chain, liveSpot, env.chainDepth);
      const { options: liveOptions, subscriptions: liveSubs } = buildOptionSpecs(
        weekly,
        liveStrikes,
        env.optionExchangeSegment,
      );
      const added = marketData.addOptions(liveOptions);
      if (added.length === 0) return;
      const newSubs = liveSubs.filter((s) =>
        added.some((o) => o.instrumentId === s.instrumentId),
      );
      feed.subscribe(newSubs);
      console.log(
        `[scalper] recentred option chain on live spot ${formatPaise(liveSpot)}: ` +
        `added ${added.length} instruments (${newSubs.length} new subscriptions), ` +
        `strikes ${liveStrikes.map(formatPaise).join(', ')}`,
      );
    },
  };
}

async function startFeedForPreflight(build: DhanLiveDataPaperBuild, timeoutMs: number): Promise<boolean> {
  build.feed.setTickHandler((tick: Tick) => {
    build.notePreflightTick(tick);
  });
  build.feed.subscribe(build.subscriptions);

  try {
    await build.feed.connect();
    console.log('[scalper] connected to Dhan live market feed');
  } catch (err) {
    console.log(`[scalper] Dhan live market feed unavailable; gateway stays online and retries: ${String(err)}`);
    return false;
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    build.feed.setTickHandler((tick: Tick) => {
      if (build.notePreflightTick(tick)) finish(true);
    });
  });
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

  const gotInitialSpot = await startFeedForPreflight(build, env.feedStaleMs);
  if (gotInitialSpot) {
    console.log('[scalper] received first live spot tick for preflight');
    // Recentre the option subscription on the actual live spot. If the static
    // estimate (scrip-master median) was off by ≥1 strike step the Dhan feed
    // may not stream the originally-subscribed contracts — they would be too
    // far OTM to carry activity. This adds any missing near-ATM instruments
    // and sends the supplementary subscription before the session opens.
    build.recentreSubscriptions();
  } else {
    console.log(`[scalper] no live spot tick within ${env.feedStaleMs}ms; preflight should block ARM until the feed recovers`);
  }

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
      resetSessionRisk: (reason) => build.host.resetSessionRisk(reason),
      disableLossStreak: (reason) => build.host.disableLossStreak(reason),
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
    // Advance the preflight freshness timestamp on arrival, before the tick is
    // queued. Ingestion is serialized through `tickChain`; feed freshness is a
    // liveness signal and must not wait behind it.
    build.noteSpotArrival(tick);
    tickChain = tickChain
      .then(() => build.host.ingestTick(tick))
      .catch((err: unknown) => {
        console.error('[scalper] tick ingestion failed:', err);
        void build.host.tripKill('AUTO', 'TICK_INGESTION_FAILED');
      });
  });
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
