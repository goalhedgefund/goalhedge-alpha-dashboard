/**
 * Demo gateway — drives the full M7 pipeline (S1 → gate → OMS → PaperBroker
 * → StopEngine) on a looping scripted scenario and publishes everything
 * through the Gateway on port 8787, so the mission-control UI has a live
 * trade lifecycle to render (~1 completed trade every ~20s).
 *
 * DEMO ONLY: session/entry windows are widened to 00:00–23:59 so it runs at
 * any wall-clock time. Never reuse this profile override for live trading.
 *
 * Run: npm run build -w @scalper/core && node core/dist/demo/demo-gateway.js
 */

import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/loader.js';
import { MarketProfileSchema, RiskProfileSchema } from '../config/schemas.js';
import type { JournalEvent, JournalEventType, JournalPayloads } from '../domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId } from '../domain/ids.js';
import type { OptionChainRow, Tick } from '../domain/marketdata.js';
import { systemClock } from '../domain/time.js';
import { PaperBroker } from '../exec/paper-broker.js';
import { Gateway } from '../gateway/gateway.js';
import { registerKillCommands, registerRunnerCommands, registerSessionCommands } from '../gateway/commands.js';
import { toGatewayLatency, type GatewayState } from '../gateway/protocol.js';
import { LatencySampler } from '../telemetry/latency.js';
import { KillSwitch } from '../killswitch/kill-switch.js';
import { SessionManager } from '../session/session.js';
import { computeUnderlyingFeatures } from '../marketdata/features/library.js';
import { formatHHMMIst } from '../domain/time.js';
import { Oms } from '../oms/oms.js';
import { RiskGate, type RiskGateContext } from '../risk/risk-gate.js';
import { SessionRiskState } from '../risk/session-risk.js';
import { StopEngine } from '../stops/stop-engine.js';
import { StrategyRunner, type MarketViewProvider } from '../strategy/runner.js';
import { S1MomentumBurst } from '../strategy/strategies/s1-momentum-burst.js';
import type { StrategyView } from '../strategy/types.js';

const PORT = 8787;
const STEP_MS = 500;
const SPOT_ID = makeInstrumentId('NSE', 'SPOT');
const CE_ID = makeInstrumentId('NSE', 'CE1');
const PE_ID = makeInstrumentId('NSE', 'PE1');
const ATM_STRIKE = 2_450_000;
const BASE_SPOT = 2_450_000;

function istDate(nowMs: number): string {
  return new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);
}

function mkRow(id: InstrumentId, right: 'CE' | 'PE', bid: number, ask: number, ltp: number): OptionChainRow {
  return {
    instrumentId: id,
    strikePaise: ATM_STRIKE,
    right,
    expiry: '2026-07-07',
    ltpPaise: ltp,
    bidPaise: bid,
    askPaise: ask,
    bidQty: 650,
    askQty: 650,
    volume: 100_000,
    oi: 500_000,
    updatedTs: Date.now(),
  };
}

class DemoViewProvider implements MarketViewProvider {
  spotTicks: Tick[] = [];
  ceRow = mkRow(CE_ID, 'CE', 14_990, 15_000, 15_000);
  peRow = mkRow(PE_ID, 'PE', 14_990, 15_000, 15_000);
  private volume = 0;

  pushSpot(ts: number, ltpPaise: number): void {
    this.volume += 100;
    this.spotTicks.push({
      instrumentId: SPOT_ID,
      ts,
      recvTs: ts,
      ltpPaise,
      qty: 100,
      volume: this.volume,
      bidPaise: ltpPaise - 5,
      askPaise: ltpPaise + 5,
      bidQty: 100,
      askQty: 100,
    });
    if (this.spotTicks.length > 200) this.spotTicks.splice(0, this.spotTicks.length - 200);
  }

  strategyView(nowMs: number): Omit<StrategyView, 'params'> {
    const features = computeUnderlyingFeatures(this.spotTicks, []);
    const ce = { instrumentId: CE_ID, row: this.ceRow };
    const pe = { instrumentId: PE_ID, row: this.peRow };
    const spot = this.spotPaise();
    return {
      nowMs,
      ...(spot !== undefined ? { spotPaise: spot } : {}),
      underlyingFeatures: features,
      atmStrikePaise: ATM_STRIKE,
      atmOption: (right) => (right === 'CE' ? ce : pe),
    };
  }

  allowedInstruments(): ReadonlySet<InstrumentId> {
    return new Set([CE_ID, PE_ID]);
  }

  optionRows(): ReadonlyMap<InstrumentId, OptionChainRow> {
    return new Map([
      [CE_ID, this.ceRow],
      [PE_ID, this.peRow],
    ]);
  }

  atmStrikePaise(): number | undefined {
    return ATM_STRIKE;
  }

  spotPaise(): number | undefined {
    return this.spotTicks[this.spotTicks.length - 1]?.ltpPaise;
  }
}

async function main(): Promise<void> {
  const configDir = new URL('../../../config/', import.meta.url);
  const marketCfg = loadConfig(
    MarketProfileSchema,
    fileURLToPath(new URL('market/india-nse-options.json', configDir)),
  );
  const marketBase = marketCfg.value;
  // DEMO override: trade at any wall-clock time.
  const market = {
    ...marketBase,
    session: { open: '00:00', close: '23:59' },
    entryCutoff: '23:59',
    hardSquareOff: '23:59',
  };
  const riskCfg = loadConfig(
    RiskProfileSchema,
    fileURLToPath(new URL('risk/paper-default.json', configDir)),
  );
  const riskProfile = riskCfg.value;

  const today = istDate(Date.now());
  const sessionId = makeSessionId(today, 'paper');
  const ids = new IdFactory(sessionId);
  const provider = new DemoViewProvider();
  const paper = new PaperBroker({ clock: systemClock });
  paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });
  paper.setQuote(PE_ID, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });

  const initialState: GatewayState = {
    session: { sessionId, mode: 'paper', phase: 'OPEN', date: today },
    kill: { state: 'READY' },
    health: { feedStatus: 'CONNECTED', lastTickTs: Date.now(), gatewayTs: Date.now() },
    algo: { strategyId: 's1-momentum-burst', lifecycle: 'DISARMED', params: {} },
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
    chain: [provider.ceRow, provider.peRow],
    bars: [],
    events: [],
  };

  let journalSeq = 0;
  const runnerBox: { runner?: StrategyRunner } = {};
  const gateway = new Gateway({ port: PORT, initialState, journal: sinkFor() });

  function sinkFor(): <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void {
    return (type, payload) => {
      const ev = { seq: ++journalSeq, ts: Date.now(), type, payload } as JournalEvent;
      gateway.ingestJournal(ev);
      if (ev.type === 'trade.completed') runnerBox.runner?.onTrade(ev.payload.trade);
    };
  }
  const sink = sinkFor();

  const sessionRisk = new SessionRiskState(riskProfile);
  const oms = new Oms({
    sessionId,
    adapter: paper,
    marketProfile: market,
    clock: systemClock,
    ids,
    journal: sink,
  });

  const gate = new RiskGate(market, riskProfile);
  const latency = new LatencySampler();
  const runner = new StrategyRunner({
    sessionId,
    strategy: new S1MomentumBurst(),
    params: {
      impulsePct: 0.0008,
      confirmTicks: 2,
      lots: 1,
      ttlMs: 1500,
      tickSizePaise: 5,
      timeStopSec: 90,
      hardStopPremiumPct: 25,
      breakevenAtPct: 12,
      trailStepPct: 8,
      trailLockPct: 50,
    },
    market,
    gate,
    oms,
    stopEngine: new StopEngine({ ids, tickSizePaise: 5 }),
    sessionRisk,
    ids,
    clock: systemClock,
    view: provider,
    eligibility: {
      entryWindows: [{ from: '00:00', to: '23:59' }],
      blackoutDates: new Set(),
      maxSpreadPct: 0.015,
      minOi: 100,
      minVolume: 100,
      strikeBand: 5,
      strikeStepPaise: market.contract.strikeStepPaise,
    },
    todayDate: today,
    regime: { trend: () => 1, highVolDay: () => false },
    journal: sink,
    cooldownSec: 5,
    latency,
  });
  runnerBox.runner = runner;

  const killGateCtx = (): RiskGateContext => ({
    nowMs: Date.now(),
    nowHHMM: formatHHMMIst(Date.now()),
    allowedInstruments: provider.allowedInstruments(),
    optionRows: provider.optionRows(),
    openPositions: oms.getPositions(),
    session: sessionRisk.current(),
  });
  const markPrice = (id: InstrumentId): number | undefined => {
    const row = provider.optionRows().get(id);
    if (row === undefined) return undefined;
    return row.bidPaise > 0 ? row.bidPaise : row.ltpPaise > 0 ? row.ltpPaise : undefined;
  };
  // Session is constructed after the kill switch (its preflight self-tests the
  // kill path); the kill switch reflects trips back into the phase via notify.
  const sessionBox: { session?: SessionManager } = {};
  const kill = new KillSwitch({
    sessionId,
    target: runner,
    oms,
    gate,
    gateContext: killGateCtx,
    ids,
    market,
    markPrice,
    journal: sink,
    notify: (event) => sessionBox.session?.onKill(event),
  });
  const session = new SessionManager({
    sessionId,
    mode: 'paper',
    date: today,
    market,
    target: runner,
    flattenPorts: () => ({
      sessionId,
      oms,
      gate,
      gateContext: killGateCtx,
      ids,
      market,
      markPrice,
      clock: systemClock,
      journal: sink,
      protectTicks: 5,
    }),
    preflight: {
      // DEMO: the real chain resolver needs a scrip-master CSV; stub a resolved
      // weekly so the checklist renders a realistic PASS.
      resolveChain: () => ({
        expiryDate: '2026-07-07',
        chain: new Map(),
        lotSize: market.contract.lotSize,
        tickSizePaise: market.tickSizePaise,
        rowCount: 82,
      }),
      lastTickTs: () => provider.spotTicks[provider.spotTicks.length - 1]?.ts ?? 0,
      feedStaleMs: 5_000,
      killSelfTest: () => kill.selfTest(),
      journalReady: () => Promise.resolve(),
      configs: [
        { name: 'market', hash: marketCfg.hash, path: marketCfg.path },
        { name: 'risk', hash: riskCfg.hash, path: riskCfg.path },
      ],
    },
    clock: systemClock,
    journal: sink,
  });
  sessionBox.session = session;

  registerRunnerCommands(gateway, runner, { isLocked: () => kill.isLocked() });
  registerKillCommands(gateway, kill);
  registerSessionCommands(gateway, session);

  // Preflight → operator ACK → OPEN, then arm the scripted trade loop. Seed one
  // spot tick first so the feed-freshness check passes.
  provider.pushSpot(Date.now(), BASE_SPOT);
  await session.runPreflight();
  session.acknowledge('demo');
  runner.arm();

  // Seed an hour of synthetic 1m bars so the chart is never empty.
  {
    let p = BASE_SPOT;
    const nowMin = Math.floor(Date.now() / 60_000) * 60_000;
    for (let i = 60; i >= 1; i--) {
      const o = p;
      const move = Math.round((Math.random() - 0.5) * 3_000);
      const c = o + move;
      sink('md.bar', {
        bar: {
          instrumentId: SPOT_ID,
          tf: '1m',
          startTs: nowMin - i * 60_000,
          o,
          h: Math.max(o, c) + 500,
          l: Math.min(o, c) - 500,
          c,
          volume: 6_500,
          tickCount: 60,
        },
      });
      p = c;
    }
  }

  // ---- Scripted cycle: warmup → impulse → trail up → trigger → cooldown ----
  let spot = BASE_SPOT;
  let stepIdx = 0;

  const setCe = (bid: number, ask: number, ltp: number): void => {
    provider.ceRow = mkRow(CE_ID, 'CE', bid, ask, ltp);
    paper.setQuote(CE_ID, { bidPaise: bid, askPaise: ask, ltpPaise: ltp });
  };

  type Step = () => Promise<void>;
  const spotStep = (delta: number): Step => async () => {
    spot += delta;
    provider.pushSpot(Date.now(), spot);
    await runner.onUnderlyingTick(Date.now());
  };
  const premiumStep = (bid: number, ask: number, ltp: number): Step => async () => {
    setCe(bid, ask, ltp);
    await runner.onOptionTick(CE_ID, ltp, Date.now());
  };
  const resetStep = (): Step => async () => {
    spot = BASE_SPOT;
    setCe(14_990, 15_000, 15_000);
    provider.pushSpot(Date.now(), spot);
    await runner.onUnderlyingTick(Date.now());
  };

  const cycle: Step[] = [
    resetStep(),
    ...Array.from({ length: 9 }, () => spotStep(0)),
    spotStep(2_500),
    spotStep(2_500), // entry fills here
    premiumStep(15_590, 15_610, 15_600),
    premiumStep(16_790, 16_810, 16_800), // breakeven + trail
    premiumStep(17_990, 18_010, 18_000), // trail → 16500
    premiumStep(16_390, 16_410, 16_400), // trigger → exit @ 16390
    ...Array.from({ length: 12 }, () => spotStep(0)), // cooldown (5s) elapses
  ];

  const publish = (): void => {
    const lat = latency.snapshot();
    gateway.set('health', {
      feedStatus: 'CONNECTED',
      lastTickTs: provider.spotTicks[provider.spotTicks.length - 1]?.ts ?? 0,
      gatewayTs: Date.now(),
      ...(lat.total.count > 0 ? { latency: toGatewayLatency(lat) } : {}),
    });
    gateway.set('algo', {
      strategyId: 's1-momentum-burst',
      lifecycle: runner.state(),
      params: runner.activeParamsSnapshot(),
      ...(gateway.currentState().algo.lastNoTradeReason !== undefined
        ? { lastNoTradeReason: gateway.currentState().algo.lastNoTradeReason }
        : {}),
    });
    gateway.set('risk', { ...gateway.currentState().risk, snapshot: sessionRisk.current() });
    gateway.set('chain', [provider.ceRow, provider.peRow]);
    gateway.set('positions', oms.getPositions().filter((p) => p.state !== 'CLOSED'));
  };

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    const step = cycle[stepIdx % cycle.length] as Step;
    stepIdx++;
    void step()
      .then(() => publish())
      .catch((err) => console.error('demo step failed:', err))
      .finally(() => {
        busy = false;
      });
  }, STEP_MS);

  await gateway.ready();
  console.log(`demo-gateway listening on ws://127.0.0.1:${gateway.port()} (PAPER, looping scripted scenario)`);

  process.on('SIGINT', () => {
    clearInterval(timer);
    void gateway.close().then(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('demo-gateway failed to start:', err);
  process.exit(1);
});
