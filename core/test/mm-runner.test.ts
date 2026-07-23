import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import {
  MarketProfileSchema,
  RiskProfileSchema,
  type MarketProfile,
  type RiskProfile,
} from '../src/config/schemas.js';
import type { JournalEvent, JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId } from '../src/domain/ids.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import { isTerminalOrderState } from '../src/domain/orders.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { MmRunner } from '../src/mm/mm-runner.js';
import { ExitEscalator } from '../src/oms/escalation.js';
import { Oms } from '../src/oms/oms.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import { SessionRiskState } from '../src/risk/session-risk.js';
import type { MarketViewProvider } from '../src/strategy/runner.js';
import type { StrategyView } from '../src/strategy/types.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(
  MarketProfileSchema,
  fileURLToPath(new URL('market/allop-nse-options.json', configDir)),
).value;
const riskProfile: RiskProfile = loadConfig(
  RiskProfileSchema,
  fileURLToPath(new URL('risk/allop-paper.json', configDir)),
).value;
const testRiskProfile: RiskProfile = {
  ...riskProfile,
  // Runner lifecycle tests exercise multi-lot reconciliation, not the tighter
  // production allocation cap.
  perTradeRiskPct: 10,
  maxConcurrentPositions: 5,
  maxLotsPerOrder: 5,
};

const LOT = market.contract.lotSize;
const TICK = market.tickSizePaise;
const SESSION = makeSessionId('2026-07-16', 'paper');
const CE_ID: InstrumentId = makeInstrumentId('NSE', 'ATM_CE');
const PE_ID: InstrumentId = makeInstrumentId('NSE', 'ATM_PE');
const ATM = 2_450_000;
const T0 = Date.UTC(2026, 6, 16, 5, 0, 0); // 10:30 IST

const PARAMS = {
  spreadCostMultiple: 3,
  maxLotsInventory: 5,
  maxScalpLots: 4,
  runnerLots: 1,
  lotsPerOrder: 1,
  ladderLevels: 2,
  ladderGapPct: 0.4,
  repriceTicks: 2,
  minRequoteMs: 0,
  quoteTtlSec: 3600, // long TTL so tests control expiry explicitly
  maxHoldSec: 180,
  hardStopPct: 10,
  adverseStopPct: 5,
  defensiveProtectTicks: 10,
  defensiveCooldownSec: 180,
  runnerActivationPct: 2,
  runnerTrailPct: 3,
  runnerMaxHoldSec: 900,
  deltaSkewLots: 3,
  knifePct: 0.35,
  knifeCooldownMin: 10,
  directionalOnly: false,
  quoteFrom: '09:20',
  bidCutoff: '15:10',
};

function row(id: InstrumentId, right: 'CE' | 'PE', bid: number, ask: number, ts: number): OptionChainRow {
  return {
    instrumentId: id,
    strikePaise: ATM,
    right,
    expiry: '2026-07-21',
    ltpPaise: Math.round((bid + ask) / 2),
    bidPaise: bid,
    askPaise: ask,
    bidQty: LOT,
    askQty: LOT,
    volume: 100_000,
    oi: 500_000,
    updatedTs: ts,
  };
}

class FakeView implements MarketViewProvider {
  rows = new Map<InstrumentId, OptionChainRow>();
  spot = ATM;
  atm: number | undefined = ATM;

  setRow(r: OptionChainRow): void {
    this.rows.set(r.instrumentId, r);
  }
  strategyView(nowMs: number): Omit<StrategyView, 'params'> {
    return {
      nowMs,
      spotPaise: this.spot,
      ...(this.atm !== undefined ? { atmStrikePaise: this.atm } : {}),
      atmOption: () => undefined,
    };
  }
  allowedInstruments(): ReadonlySet<InstrumentId> {
    return new Set(this.rows.keys());
  }
  optionRows(): ReadonlyMap<InstrumentId, OptionChainRow> {
    return this.rows;
  }
  atmStrikePaise(): number | undefined {
    return this.atm;
  }
  spotPaise(): number | undefined {
    return this.spot;
  }
}

interface Rig {
  runner: MmRunner;
  oms: Oms;
  paper: PaperBroker;
  view: FakeView;
  clock: ManualClock;
  sessionRisk: SessionRiskState;
  escalator: ExitEscalator;
  events: JournalEvent[];
}

function rig(profile: RiskProfile = testRiskProfile): Rig {
  const clock = new ManualClock(T0);
  const events: JournalEvent[] = [];
  let seq = 0;
  const runnerBox: { runner?: MmRunner } = {};
  const sink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void => {
    const ev = { seq: ++seq, ts: clock.now(), type, payload } as JournalEvent;
    events.push(ev);
    if (ev.type === 'trade.completed') runnerBox.runner?.onTrade(ev.payload.trade);
  };
  const paper = new PaperBroker({ clock, tickSizePaise: TICK, restingFills: true });
  const ids = new IdFactory(SESSION);
  const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: sink });
  const sessionRisk = new SessionRiskState(profile);
  const view = new FakeView();
  view.setRow(row(CE_ID, 'CE', 14_990, 15_010, T0));
  view.setRow(row(PE_ID, 'PE', 14_990, 15_010, T0));
  // The broker must know the touch too, or resting limits "fill" at placement.
  paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_010, ltpPaise: 15_000 });
  paper.setQuote(PE_ID, { bidPaise: 14_990, askPaise: 15_010, ltpPaise: 15_000 });
  const gate = new RiskGate(market, profile);
  const gateContext = (): RiskGateContext => ({
    nowMs: clock.now(),
    nowHHMM: '10:30',
    allowedInstruments: view.allowedInstruments(),
    optionRows: view.optionRows(),
    openPositions: oms.getPositions(),
    session: sessionRisk.current(),
  });
  const escalator = new ExitEscalator({
    oms,
    gate,
    gateContext,
    ids,
    market,
    markPrice: (instrumentId) => view.optionRows().get(instrumentId)?.bidPaise ?? 0,
    clock,
    journal: sink,
    stageTimeoutMs: 750,
    repriceTicks: 10,
  });
  const runner = new MmRunner({
    sessionId: SESSION,
    strategyId: 'allop-atm-mm',
    params: PARAMS,
    market,
    gate,
    oms,
    sessionRisk,
    ids,
    clock,
    view,
    quoteGates: { maxSpreadPct: 0.015, minOi: 100, minVolume: 100, strikeBand: 5 },
    journal: sink,
    escalator,
  });
  runnerBox.runner = runner;
  return { runner, oms, paper, view, clock, sessionRisk, escalator, events };
}

function working(r: Rig) {
  return r.oms.getOrders().filter((o) => !isTerminalOrderState(o.state));
}

describe('MmRunner reconciliation through gate → OMS', () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it('does nothing while DISARMED', async () => {
    await r.runner.onTimer(T0);
    expect(r.oms.getOrders()).toHaveLength(0);
    expect(r.runner.state()).toBe('DISARMED');
  });

  it('armed: places the full gate-approved ladder (2 levels x CE/PE)', async () => {
    r.runner.arm();
    await r.runner.onTimer(T0);
    const orders = working(r);
    expect(orders).toHaveLength(4);
    for (const o of orders) {
      expect(o.side).toBe('BUY');
      expect(o.purpose).toBe('ENTRY');
      expect(o.tag).toBe('allop-atm-mm:quote_bid');
      expect(o.state).toBe('ACKED'); // resting below mid, not marketable
      expect(o.limitPricePaise!).toBeLessThan(15_000);
    }
    // Every placement went through the gate: an approved verdict per intent.
    const verdicts = r.events.filter((e) => e.type === 'risk.verdict');
    expect(verdicts).toHaveLength(4);
  });

  it('re-quotes when mid drifts beyond tolerance (cancel first, replace next pass)', async () => {
    r.runner.arm();
    await r.runner.onTimer(T0);
    const before = working(r).map((o) => o.limitPricePaise);
    // Mid moves up 100 paise (>> 2-tick tolerance).
    r.view.setRow(row(CE_ID, 'CE', 15_090, 15_110, T0 + 1_000));
    r.view.setRow(row(PE_ID, 'PE', 15_090, 15_110, T0 + 1_000));
    r.paper.setQuote(CE_ID, { bidPaise: 15_090, askPaise: 15_110, ltpPaise: 15_100 });
    r.paper.setQuote(PE_ID, { bidPaise: 15_090, askPaise: 15_110, ltpPaise: 15_100 });
    await r.runner.onTimer(T0 + 1_000); // cancels stale quotes
    await r.runner.onTimer(T0 + 2_000); // lanes now free → replacements
    const after = working(r);
    expect(after).toHaveLength(4);
    for (const o of after) expect(before).not.toContain(o.limitPricePaise);
  });

  it('bid fill → inventory ask at >= cost x (1 + minSpread) → profitable round trip', async () => {
    r.runner.arm();
    await r.runner.onTimer(T0);
    const bestBid = Math.max(...working(r).filter((o) => o.instrumentId === CE_ID).map((o) => o.limitPricePaise!));

    // The market trades down to our bid: the resting order becomes marketable.
    r.paper.setQuote(CE_ID, { bidPaise: bestBid - TICK, askPaise: bestBid, ltpPaise: bestBid });
    const pos = r.oms.getPositions().find((p) => p.instrumentId === CE_ID);
    expect(pos).toBeDefined();
    expect(pos!.qty).toBe(LOT);

    // Next pass: the book gets a covered ask, never below the spread floor.
    r.view.setRow(row(CE_ID, 'CE', bestBid - TICK, bestBid + TICK, T0 + 1_000));
    await r.runner.onTimer(T0 + 1_000);
    const asks = working(r).filter((o) => o.side === 'SELL');
    expect(asks).toHaveLength(1);
    const ask = asks[0]!;
    expect(ask.purpose).toBe('EXIT');
    expect(ask.qty).toBe(LOT);
    const cost = pos!.avgEntryPricePaise;
    expect(ask.limitPricePaise!).toBeGreaterThanOrEqual(cost * 1.005); // >= ~3x statutory round trip

    // Market lifts to our ask → round trip completes at a net profit.
    r.paper.setQuote(CE_ID, { bidPaise: ask.limitPricePaise!, askPaise: ask.limitPricePaise! + TICK, ltpPaise: ask.limitPricePaise! });
    const trades = r.events.filter((e) => e.type === 'trade.completed');
    expect(trades).toHaveLength(1);
    const trade = (trades[0] as Extract<JournalEvent, { type: 'trade.completed' }>).payload.trade;
    expect(trade.netPnlPaise).toBeGreaterThan(0);
    expect(r.oms.getPositions().filter((p) => p.state !== 'CLOSED' && p.qty > 0)).toHaveLength(0);
  });

  it('earns one runner from a profitable pair and closes the intended scalp lot', async () => {
    r.runner.arm();
    await r.runner.onTimer(T0);
    const ceBids = working(r)
      .filter((o) => o.side === 'BUY' && o.instrumentId === CE_ID)
      .sort((a, b) => (b.limitPricePaise ?? 0) - (a.limitPricePaise ?? 0));
    expect(ceBids).toHaveLength(2);
    const highEntry = ceBids[0]!.limitPricePaise!;
    const lowEntry = ceBids[1]!.limitPricePaise!;

    r.paper.setQuote(CE_ID, { bidPaise: highEntry - TICK, askPaise: highEntry, ltpPaise: highEntry });
    r.paper.setQuote(CE_ID, { bidPaise: lowEntry - TICK, askPaise: lowEntry, ltpPaise: lowEntry });
    const beforeLots = r.oms.getOpenLots(CE_ID);
    expect(beforeLots).toHaveLength(2);
    const cheapLot = beforeLots.find((lot) => lot.pricePaise === lowEntry)!;
    const expensiveLot = beforeLots.find((lot) => lot.pricePaise === highEntry)!;

    r.view.setRow(row(CE_ID, 'CE', highEntry + 195, highEntry + 205, T0 + 1_000));
    await r.runner.onTimer(T0 + 1_000);
    const scalpExit = working(r).find((o) => o.side === 'SELL' && o.instrumentId === CE_ID)!;
    expect(scalpExit.tag).toBe('allop-atm-mm:scalp_exit');
    expect(scalpExit.qty).toBe(LOT);
    expect(scalpExit.closeLotIds).toEqual([expensiveLot.lotId]);

    r.paper.setQuote(CE_ID, {
      bidPaise: scalpExit.limitPricePaise!,
      askPaise: scalpExit.limitPricePaise! + TICK,
      ltpPaise: scalpExit.limitPricePaise!,
    });
    const afterLots = r.oms.getOpenLots(CE_ID);
    expect(afterLots.some((lot) => lot.lotId === cheapLot.lotId)).toBe(true);
    expect(afterLots.some((lot) => lot.lotId === expensiveLot.lotId)).toBe(false);
    expect(r.runner.mmState().runnerStatus).toBe('ACTIVE');
    expect(r.runner.mmState().runner?.entryPricePaise).toBe(lowEntry);

    // Replenishment may already have added a fresh scalp lot. Its next ask
    // must explicitly exclude the retained runner allocation.
    r.paper.setQuote(CE_ID, { bidPaise: lowEntry - 500, askPaise: highEntry + 1_000, ltpPaise: highEntry });
    await r.runner.onTimer(T0 + 2_000);
    const nextScalpExit = working(r).find((o) => o.side === 'SELL' && o.instrumentId === CE_ID);
    if (afterLots.length > 1) {
      expect(nextScalpExit).toBeDefined();
      expect(nextScalpExit?.closeLotIds).not.toContain(cheapLot.lotId);
    }
  });

  it('inventory cap: held books shrink the working bid set (5 lots total)', async () => {
    r.runner.arm();
    await r.runner.onTimer(T0);
    // Fill both CE bids and one PE bid (3 lots held).
    const bids = working(r);
    for (const o of bids.slice(0, 3)) {
      r.paper.setQuote(o.instrumentId, { bidPaise: o.limitPricePaise! - TICK, askPaise: o.limitPricePaise!, ltpPaise: o.limitPricePaise! });
    }
    await r.runner.onTimer(T0 + 1_000);
    await r.runner.onTimer(T0 + 2_000);
    const buys = working(r).filter((o) => o.side === 'BUY');
    const heldLots = r.oms
      .getPositions()
      .filter((p) => p.state !== 'CLOSED')
      .reduce((s, p) => s + p.qty, 0) / LOT;
    expect(heldLots + buys.length).toBeLessThanOrEqual(PARAMS.maxLotsInventory);
  });

  it('latched session stop cancels bids and immediately flattens inventory', async () => {
    r.runner.arm();
    await r.runner.onTimer(T0);
    const bid = working(r).find((o) => o.instrumentId === CE_ID)!;
    r.paper.setQuote(CE_ID, { bidPaise: bid.limitPricePaise! - TICK, askPaise: bid.limitPricePaise!, ltpPaise: bid.limitPricePaise! });
    // Latch the day-loss stop directly.
    r.sessionRisk.recordTrade(-Math.round(riskProfile.capitalPaise * (riskProfile.dailyMaxLossPct / 100)) - 1);
    r.view.setRow(row(CE_ID, 'CE', bid.limitPricePaise! - TICK, bid.limitPricePaise! + TICK, T0 + 1_000));
    await r.runner.onTimer(T0 + 1_000);
    await r.runner.onTimer(T0 + 2_000);
    const still = working(r);
    expect(still.filter((o) => o.side === 'BUY')).toHaveLength(0);
    expect(still.filter((o) => o.side === 'SELL')).toHaveLength(0);
    expect(r.oms.getPositions().filter((p) => p.state !== 'CLOSED' && p.qty > 0)).toHaveLength(0);
    expect(r.oms.getOrders().some((o) => o.tag === 'allop-atm-mm:risk_exit' && o.state === 'FILLED')).toBe(true);
    expect(r.runner.lastNoTrade()).toBe('PAUSED_LOCKOUT');
  });

  it('a completed trade that trips the session stop flattens the other book in the same cycle', async () => {
    const sensitiveRisk: RiskProfile = {
      ...testRiskProfile,
      giveBack: { armAtPct: 0.1, retainPct: 99 },
    };
    r = rig(sensitiveRisk);
    r.runner.arm();
    await r.runner.onTimer(T0);
    const ceBid = working(r).find((o) => o.instrumentId === CE_ID)!.limitPricePaise!;
    const peBid = working(r).find((o) => o.instrumentId === PE_ID)!.limitPricePaise!;

    r.paper.setQuote(CE_ID, { bidPaise: ceBid - TICK, askPaise: ceBid, ltpPaise: ceBid });
    r.paper.setQuote(PE_ID, { bidPaise: peBid - TICK, askPaise: peBid, ltpPaise: peBid });
    expect(r.oms.getOpenLots(CE_ID).length).toBeGreaterThan(0);
    expect(r.oms.getOpenLots(PE_ID).length).toBeGreaterThan(0);

    // Arm give-back with a small synthetic prior profit, then let the CE hard
    // stop create the loss that latches it. PE must be liquidated immediately.
    r.sessionRisk.recordTrade(10_001);
    const ceStopBid = Math.floor((ceBid * 0.89) / TICK) * TICK;
    r.view.setRow(row(CE_ID, 'CE', ceStopBid, ceStopBid + TICK, T0 + 1_000));
    r.view.setRow(row(PE_ID, 'PE', peBid - TICK, peBid, T0 + 1_000));
    r.paper.setQuote(CE_ID, { bidPaise: ceStopBid, askPaise: ceStopBid + TICK, ltpPaise: ceStopBid });

    await r.runner.onTimer(T0 + 1_000);

    expect(r.sessionRisk.current().latchedStop).toBe('GIVE_BACK');
    expect(r.oms.getOpenLots()).toHaveLength(0);
    expect(working(r)).toHaveLength(0);
    expect(r.oms.getOrders().some((o) => o.instrumentId === PE_ID && o.tag === 'allop-atm-mm:risk_exit' && o.state === 'FILLED')).toBe(true);
  });

  it('polls a resting hard stop through REPRICE then MARKET until the exact lot is flat', async () => {
    r.runner.arm();
    await r.runner.onTimer(T0);
    const bid = working(r).find((o) => o.instrumentId === CE_ID)!;
    r.paper.setQuote(CE_ID, {
      bidPaise: bid.limitPricePaise! - TICK,
      askPaise: bid.limitPricePaise!,
      ltpPaise: bid.limitPricePaise!,
    });
    const lotId = r.oms.getOpenLots(CE_ID)[0]?.lotId;
    expect(lotId).toBeDefined();
    for (const order of working(r).filter((candidate) => candidate.side === 'BUY' && candidate.instrumentId === CE_ID)) {
      await r.oms.cancel(order.clientOrderId);
    }

    const stopBid = Math.floor((bid.limitPricePaise! * 0.89) / TICK) * TICK;
    r.view.setRow(row(CE_ID, 'CE', stopBid, stopBid + TICK, T0 + 1_000));
    r.paper.setQuote(CE_ID, { bidPaise: stopBid, askPaise: stopBid + TICK, ltpPaise: stopBid });
    r.paper.holdFills(CE_ID, 2);
    r.clock.advance(1_000);
    await r.runner.onTimer(r.clock.now());

    const protect = working(r).find((o) => o.tag === 'allop-atm-mm:hard_stop');
    expect(protect).toEqual(expect.objectContaining({
      type: 'LIMIT',
      limitPricePaise: stopBid - 10 * TICK,
      closeLotIds: [lotId],
    }));
    expect(r.escalator.trackedCount()).toBe(1);

    r.clock.advance(800);
    await r.runner.onTimer(r.clock.now());
    r.clock.advance(800);
    await r.runner.onTimer(r.clock.now());

    const stages = r.events
      .filter((event) => event.type === 'exit.escalated')
      .map((event) => (event as Extract<JournalEvent, { type: 'exit.escalated' }>).payload.stage);
    expect(stages).toEqual(['REPRICE', 'MARKET']);
    const escalated = r.oms.getOrders().filter((order) => order.tag.includes('esc-'));
    expect(escalated.every((order) => order.closeLotIds?.[0] === lotId)).toBe(true);
    expect(r.oms.getOpenLots(CE_ID)).toHaveLength(0);
  });

  it('DISARM cancels every working quote and leaves the position alone', async () => {
    r.runner.arm();
    await r.runner.onTimer(T0);
    const bid = working(r).find((o) => o.instrumentId === CE_ID)!;
    r.paper.setQuote(CE_ID, { bidPaise: bid.limitPricePaise! - TICK, askPaise: bid.limitPricePaise!, ltpPaise: bid.limitPricePaise! });
    r.view.setRow(row(CE_ID, 'CE', bid.limitPricePaise! - TICK, bid.limitPricePaise! + TICK, T0 + 1_000));
    await r.runner.onTimer(T0 + 1_000);
    expect(working(r).length).toBeGreaterThan(0);

    r.runner.disarm();
    await Promise.resolve(); // flush the fire-and-forget cancel chain
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(working(r)).toHaveLength(0);
    expect(r.oms.getPositions().filter((p) => p.state !== 'CLOSED' && p.qty > 0)).toHaveLength(1);
    // Re-arm resumes quoting.
    r.runner.arm();
    await r.runner.onTimer(T0 + 3_000);
    expect(working(r).length).toBeGreaterThan(0);
  });

  it('gate rejects an off-window bid (before open the ENTRY lane is closed)', async () => {
    const early = Date.UTC(2026, 6, 16, 3, 40, 0); // 09:10 IST — inside quoteFrom guard too
    r.runner.arm();
    await r.runner.onTimer(early);
    expect(working(r)).toHaveLength(0);
    expect(r.runner.lastNoTrade()).toBe('PAUSED_WINDOW');
  });
});
