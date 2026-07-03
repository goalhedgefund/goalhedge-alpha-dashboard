/**
 * M7 acceptance: end-to-end on a scripted replay —
 * signal → eligibility → gate → OMS → paper fill → stop trail → exit →
 * trade completed net-of-charges, with journaled no-trade reasons, and
 * byte-identical determinism across two independent runs.
 *
 * Hand-computed cost pin for the trail scenario (india-nse-options):
 *   entry BUY 65 @ 15000p → buy turnover  975 000p
 *   exit SELL 65 @ 16390p → sell turnover 1 065 350p, both 2 040 350p
 *   stt   = round(1 065 350 × 0.001)      = 1 065p
 *   txn   = round(2 040 350 × 0.0003503)  =   715p
 *   sebi  = round(2 040 350 × 0.000001)   =     2p
 *   stamp = round(  975 000 × 0.00003)    =    29p
 *   ipft  = round(2 040 350 × 0.000005)   =    10p
 *   gst   = round((715+2+10+0) × 0.18)    =   131p
 *   total = 1 952p
 *   gross = (16390 − 15000) × 65 = 90 350p → net = 88 398p
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import {
  MarketProfileSchema,
  RiskProfileSchema,
  type MarketProfile,
  type RiskProfile,
} from '../src/config/schemas.js';
import type { JournalEvent, JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId } from '../src/domain/ids.js';
import type { OptionChainRow, Tick } from '../src/domain/marketdata.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { TradesWriter } from '../src/exec/trades-writer.js';
import { hashEventStream } from '../src/journal/hash.js';
import { JournalWriter } from '../src/journal/writer.js';
import { computeUnderlyingFeatures } from '../src/marketdata/features/library.js';
import { Oms } from '../src/oms/oms.js';
import { RiskGate } from '../src/risk/risk-gate.js';
import { SessionRiskState } from '../src/risk/session-risk.js';
import { StopEngine } from '../src/stops/stop-engine.js';
import { StrategyRunner, type MarketViewProvider } from '../src/strategy/runner.js';
import { S1MomentumBurst } from '../src/strategy/strategies/s1-momentum-burst.js';
import type { StrategyView } from '../src/strategy/types.js';
import { ATM_STRIKE, CE_ID, PE_ID, mkRow } from './helpers/strategy-fixtures.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(
  MarketProfileSchema,
  fileURLToPath(new URL('market/india-nse-options.json', configDir)),
).value;
const riskProfile: RiskProfile = loadConfig(
  RiskProfileSchema,
  fileURLToPath(new URL('risk/paper-default.json', configDir)),
).value;

const SESSION = makeSessionId('2026-07-03', 'paper');
const SPOT_ID: InstrumentId = makeInstrumentId('NSE', 'SPOT');
const START_10AM_IST = Date.UTC(2026, 6, 3, 4, 30, 0); // 10:00 IST

const S1_PARAMS = {
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
};

class TestViewProvider implements MarketViewProvider {
  spotTicks: Tick[] = [];
  ceRow: OptionChainRow = mkRow(CE_ID, 'CE');
  peRow: OptionChainRow = mkRow(PE_ID, 'PE');
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

interface Harness {
  clock: ManualClock;
  provider: TestViewProvider;
  paper: PaperBroker;
  runner: StrategyRunner;
  events: JournalEvent[];
  writer: JournalWriter;
  trades: TradesWriter;
  lastSpot: () => number;
  stepSpot: (delta: number) => Promise<void>;
  stepPremium: (ltpPaise: number) => Promise<void>;
}

function buildHarness(startMs: number, dir: string): Harness {
  const clock = new ManualClock(startMs);
  const ids = new IdFactory(SESSION);
  const provider = new TestViewProvider();
  const paper = new PaperBroker({ clock });
  paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });
  const writer = new JournalWriter({ dir, clock, fsync: 'never', flushIntervalMs: 60_000 });
  const trades = new TradesWriter({ dir });
  const events: JournalEvent[] = [];

  const runnerBox: { runner?: StrategyRunner } = {};
  const sink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void => {
    events.push(writer.append(type, payload));
    if (type === 'trade.completed') {
      runnerBox.runner?.onTrade((payload as JournalPayloads['trade.completed']).trade);
    }
  };

  const oms = new Oms({
    sessionId: SESSION,
    adapter: paper,
    marketProfile: market,
    clock,
    ids,
    journal: sink,
    tradesWriter: trades,
  });

  const runner = new StrategyRunner({
    sessionId: SESSION,
    strategy: new S1MomentumBurst(),
    params: S1_PARAMS,
    market,
    gate: new RiskGate(market, riskProfile),
    oms,
    stopEngine: new StopEngine({ ids, tickSizePaise: 5 }),
    sessionRisk: new SessionRiskState(riskProfile),
    ids,
    clock,
    view: provider,
    eligibility: {
      entryWindows: [{ from: '09:20', to: '15:00' }],
      blackoutDates: new Set(),
      maxSpreadPct: 0.015,
      minOi: 100,
      minVolume: 100,
      strikeBand: 5,
      strikeStepPaise: market.contract.strikeStepPaise,
    },
    todayDate: '2026-07-03',
    regime: { trend: () => 1, highVolDay: () => false },
    journal: sink,
    cooldownSec: 5,
  });
  runnerBox.runner = runner;
  runner.arm();

  let spot = 2_450_000;
  return {
    clock,
    provider,
    paper,
    runner,
    events,
    writer,
    trades,
    lastSpot: () => spot,
    stepSpot: async (delta: number) => {
      clock.advance(1000);
      spot += delta;
      provider.pushSpot(clock.now(), spot);
      await runner.onUnderlyingTick(clock.now());
    },
    stepPremium: async (ltpPaise: number) => {
      clock.advance(1000);
      await runner.onOptionTick(CE_ID, ltpPaise, clock.now());
    },
  };
}

interface ScenarioResult {
  events: JournalEvent[];
  journalHash: string;
  tradesBytes: string;
  net: number | undefined;
}

async function runTrailScenario(): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), 'scalper-e2e-'));
  const h = buildHarness(START_10AM_IST, dir);

  for (let i = 0; i < 10; i++) await h.stepSpot(0); // warmup
  await h.stepSpot(2_500); // impulse: CONFIRMING
  await h.stepSpot(2_500); // impulse: ENTRY → fill @ ask 15000, stop armed

  await h.stepPremium(15_600); // HW up, no move yet
  await h.stepPremium(16_800); // breakeven + first trail lock → stop 15900
  await h.stepPremium(18_000); // trail → stop 16500

  h.paper.setQuote(CE_ID, { bidPaise: 16_390, askPaise: 16_410, ltpPaise: 16_400 });
  await h.stepPremium(16_400); // ≤ 16500 → L2_TRAIL trigger → exit fill @ bid 16390

  for (let i = 0; i < 7; i++) await h.stepSpot(0); // cooldown expires (5s) mid-way

  await h.writer.close();
  await h.trades.close();

  const trade = h.events.find((e) => e.type === 'trade.completed');
  return {
    events: h.events,
    journalHash: hashEventStream(h.events),
    tradesBytes: readFileSync(h.trades.path, 'utf8'),
    net: trade?.type === 'trade.completed' ? trade.payload.trade.netPnlPaise : undefined,
  };
}

describe('M7 E2E: signal → gate → fill → trail → exit (scripted replay)', () => {
  it('runs the full life of a trade and lands the hand-computed net', async () => {
    const r = await runTrailScenario();
    const byType = (t: JournalEvent['type']): JournalEvent[] => r.events.filter((e) => e.type === t);

    // No-trade reasons were journaled (deduplicated) during warmup.
    const noTradeReasons = byType('strategy.noTrade').map((e) =>
      e.type === 'strategy.noTrade' ? e.payload.reason : '',
    );
    expect(noTradeReasons).toContain('NO_IMPULSE');
    expect(noTradeReasons).toContain('COOLDOWN');
    // Dedup: consecutive duplicates never journaled.
    for (let i = 1; i < noTradeReasons.length; i++) {
      expect(noTradeReasons[i]).not.toBe(noTradeReasons[i - 1]);
    }

    // Exactly one signal, long CE.
    const signals = byType('strategy.signal');
    expect(signals.length).toBe(1);
    if (signals[0]?.type === 'strategy.signal') {
      expect(signals[0].payload.direction).toBe('LONG_CE');
    }

    // Two intents (entry + stop exit), both approved.
    const intents = byType('intent.proposed');
    expect(intents.length).toBe(2);
    const verdicts = byType('risk.verdict');
    expect(verdicts.length).toBe(2);
    for (const v of verdicts) {
      if (v.type === 'risk.verdict') expect(v.payload.verdict.approved).toBe(true);
    }
    if (intents[1]?.type === 'intent.proposed') {
      expect(intents[1].payload.intent.purpose).toBe('STOP');
      expect(intents[1].payload.intent.side).toBe('SELL');
    }

    // Stop ratcheted at least twice and only ever upward.
    const moves = byType('stop.moved');
    expect(moves.length).toBeGreaterThanOrEqual(2);
    let prevStop = 0;
    for (const m of moves) {
      if (m.type === 'stop.moved') {
        expect(m.payload.to.stopPremiumPaise).toBeGreaterThan(m.payload.from.stopPremiumPaise);
        expect(m.payload.to.stopPremiumPaise).toBeGreaterThanOrEqual(prevStop);
        prevStop = m.payload.to.stopPremiumPaise;
      }
    }
    const lastMove = moves[moves.length - 1];
    if (lastMove?.type === 'stop.moved') {
      expect(lastMove.payload.to.stopPremiumPaise).toBe(16_500);
    }

    // Trigger was the trail layer.
    const triggers = byType('stop.triggered');
    expect(triggers.length).toBe(1);
    if (triggers[0]?.type === 'stop.triggered') {
      expect(triggers[0].payload.layer).toBe('L2_TRAIL');
    }

    // The trade landed with the hand-computed cost waterfall.
    const trades = byType('trade.completed');
    expect(trades.length).toBe(1);
    if (trades[0]?.type === 'trade.completed') {
      const t = trades[0].payload.trade;
      expect(t.grossPnlPaise).toBe(90_350);
      expect(t.charges.totalPaise).toBe(1_952);
      expect(t.netPnlPaise).toBe(88_398);
      expect(t.exitReason).toBe('STOP');
      expect(t.qty).toBe(65);
    }

    // Runner came back to ARMED after cooldown; trades.jsonl has both streams.
    expect(r.tradesBytes).toContain('"kind":"trade"');
    expect(r.tradesBytes).toContain('"kind":"orderEvent"');
  }, 30_000);

  it('same scripted replay twice → identical journal hash and trades file (determinism)', async () => {
    const a = await runTrailScenario();
    const b = await runTrailScenario();
    expect(a.journalHash).toBe(b.journalHash);
    expect(a.tradesBytes === b.tradesBytes).toBe(true);
    expect(a.net).toBe(88_398);
    expect(b.net).toBe(88_398);
  }, 60_000);

  it('time stop (L3) fires via onTimer when the market goes quiet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scalper-e2e-t-'));
    const h = buildHarness(START_10AM_IST, dir);

    for (let i = 0; i < 10; i++) await h.stepSpot(0);
    await h.stepSpot(2_500);
    await h.stepSpot(2_500); // entry fills @ 15000

    await h.stepPremium(15_000); // sets last premium; no move, no trigger
    h.paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_010, ltpPaise: 15_000 });

    // Silence: only the timer runs. Time stop = 90s.
    for (let i = 0; i < 10; i++) {
      h.clock.advance(10_000);
      await h.runner.onTimer(h.clock.now());
    }

    const trigger = h.events.find((e) => e.type === 'stop.triggered');
    expect(trigger).toBeDefined();
    if (trigger?.type === 'stop.triggered') {
      expect(trigger.payload.layer).toBe('L3_TIME');
    }
    const trade = h.events.find((e) => e.type === 'trade.completed');
    expect(trade).toBeDefined();
    if (trade?.type === 'trade.completed') {
      // Scratch exit at bid 14990: small gross loss, charges make it worse — honestly negative.
      expect(trade.payload.trade.grossPnlPaise).toBe((14_990 - 15_000) * 65);
      expect(trade.payload.trade.netPnlPaise).toBeLessThan(trade.payload.trade.grossPnlPaise);
    }
    await h.writer.close();
    await h.trades.close();
  }, 30_000);

  it('outside the entry window: exactly one deduplicated ENTRY_WINDOW no-trade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scalper-e2e-w-'));
    const start916 = Date.UTC(2026, 6, 3, 3, 46, 0); // 09:16 IST — inside opening chaos
    const h = buildHarness(start916, dir);

    for (let i = 0; i < 3; i++) await h.stepSpot(0);

    const noTrades = h.events.filter((e) => e.type === 'strategy.noTrade');
    expect(noTrades.length).toBe(1);
    if (noTrades[0]?.type === 'strategy.noTrade') {
      expect(noTrades[0].payload.reason).toBe('ENTRY_WINDOW');
    }
    expect(h.events.filter((e) => e.type === 'strategy.signal').length).toBe(0);
    await h.writer.close();
    await h.trades.close();
  });
});
