import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema } from '../src/config/schemas.js';
import type { JournalEvent, JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId } from '../src/domain/ids.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import { isTerminalOrderState } from '../src/domain/orders.js';
import type { Trade } from '../src/domain/positions.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { OpMinusRunner, straddleShouldRecenter } from '../src/mm/op-minus-runner.js';
import { ExitEscalator } from '../src/oms/escalation.js';
import { Oms } from '../src/oms/oms.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import { SessionRiskState } from '../src/risk/session-risk.js';
import type { UnderlyingFeatures } from '../src/marketdata/features/library.js';
import type { MarketViewProvider } from '../src/strategy/runner.js';
import type { StrategyParams, StrategyView } from '../src/strategy/types.js';

const configDir = new URL('../../config/', import.meta.url);
const market = loadConfig(MarketProfileSchema, fileURLToPath(new URL('market/allop-nse-options.json', configDir))).value;
const risk = loadConfig(RiskProfileSchema, fileURLToPath(new URL('risk/op-minus-paper.json', configDir))).value;
const testRisk = {
  ...risk,
  // Legacy sequencing coverage needs four concurrently filled paper shorts.
  maxConcurrentPositions: 4,
  maxLotsPerOrder: 2,
};
const LOT = market.contract.lotSize;
const TICK = market.tickSizePaise;
const SESSION = makeSessionId('2026-07-22', 'paper');
const T0 = Date.UTC(2026, 6, 22, 5, 0, 0); // 10:30 IST
const ATM = 2_500_000;
const SCALP_EXPIRY = '2026-07-28';
const IDS = {
  scalpCe: makeInstrumentId('NSE', 'op-s-ce'),
  scalpPe: makeInstrumentId('NSE', 'op-s-pe'),
};

function optionRow(id: InstrumentId, right: 'CE' | 'PE', expiry: string, bid: number, ask: number, ts = T0): OptionChainRow {
  return {
    instrumentId: id, strikePaise: ATM, right, expiry, ltpPaise: Math.round((bid + ask) / 2),
    bidPaise: bid, askPaise: ask, bidQty: 10 * LOT, askQty: 10 * LOT,
    volume: 100_000, oi: 500_000, updatedTs: ts,
  };
}

function calmFeatures(ret30s = 0): UnderlyingFeatures {
  return {
    ret1s: 0, ret5s: 0, ret30s, vwapPaise: ATM, atr1mPaise: 1_000,
    tickVelocityPerSec: 1, volumeBurstRatio: 1,
    codexScore: { bull: 0, bear: 0, signal: 'WAIT', trend: 'flat', indicators: { last: ATM } },
  };
}

class FakeView implements MarketViewProvider {
  readonly rows = new Map<InstrumentId, OptionChainRow>();
  features: UnderlyingFeatures | undefined;
  strategyView(nowMs: number): Omit<StrategyView, 'params'> {
    return {
      nowMs, spotPaise: ATM, atmStrikePaise: ATM, atmOption: () => undefined,
      ...(this.features !== undefined ? { underlyingFeatures: this.features } : {}),
    };
  }
  allowedInstruments(): ReadonlySet<InstrumentId> { return new Set(this.rows.keys()); }
  optionRows(): ReadonlyMap<InstrumentId, OptionChainRow> { return this.rows; }
  atmStrikePaise(): number | undefined { return ATM; }
  spotPaise(): number | undefined { return ATM; }
}

function rig(paramOverrides: StrategyParams = {}) {
  const clock = new ManualClock(T0);
  const events: JournalEvent[] = [];
  let seq = 0;
  const runnerBox: { runner?: OpMinusRunner } = {};
  const sink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void => {
    const event = { seq: ++seq, ts: clock.now(), type, payload } as JournalEvent;
    events.push(event);
    if (event.type === 'trade.completed') runnerBox.runner?.onTrade(event.payload.trade);
  };
  const view = new FakeView();
  view.rows.set(IDS.scalpCe, optionRow(IDS.scalpCe, 'CE', SCALP_EXPIRY, 9_990, 10_000));
  view.rows.set(IDS.scalpPe, optionRow(IDS.scalpPe, 'PE', SCALP_EXPIRY, 9_990, 10_000));
  const paper = new PaperBroker({ clock, tickSizePaise: TICK, restingFills: true });
  for (const row of view.rows.values()) {
    paper.setQuote(row.instrumentId, { bidPaise: row.bidPaise, askPaise: row.askPaise, ltpPaise: row.ltpPaise });
  }
  const ids = new IdFactory(SESSION);
  const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: sink });
  const sessionRisk = new SessionRiskState(testRisk);
  const gate = new RiskGate(market, testRisk);
  const gateContext = (): RiskGateContext => ({
    nowMs: clock.now(), nowHHMM: '10:30', allowedInstruments: view.allowedInstruments(), optionRows: view.optionRows(),
    atmStrikePaise: ATM, strikeBand: 5, maxSpreadPct: 0.015, minOi: 100, minVolume: 100,
    openPositions: oms.getPositions(), session: sessionRisk.current(),
  });
  const escalator = new ExitEscalator({
    oms, gate, gateContext, ids, market,
    markPrice: (instrumentId, side) => {
      const row = view.rows.get(instrumentId);
      return side === 'BUY' ? row?.askPaise : row?.bidPaise;
    },
    clock, journal: sink,
  });
  const runner = new OpMinusRunner({
    sessionId: SESSION, strategyId: 'op-minus-atm-short',
    params: {
      scalpLotsPerRight: 2, rewardRiskRatio: 2, runnerLots: 1,
      quoteTtlSec: 3_600, maxHoldSec: 180, defensiveProtectTicks: 10, repriceTicks: 2,
      targetPremiumPct: 5, hardStopPremiumPct: 9, minRequoteMs: 0,
      rangeFilterEnabled: false, entryImprovementTicks: 100,
      quoteFrom: '09:20', entryCutoff: '15:10',
      ...paramOverrides,
    },
    market, scalpExpiry: SCALP_EXPIRY,
    gate, oms, escalator, sessionRisk, ids, clock, view,
    quoteGates: { maxSpreadPct: 0.015, minOi: 100, minVolume: 100, strikeBand: 5 },
    journal: sink,
  });
  runnerBox.runner = runner;
  return { runner, oms, paper, view, clock, events };
}

describe('straddle-drift window re-center hysteresis', () => {
  const STEP = 5_000; // one NIFTY strike = 50 index pts = 5000 paise
  const ANCHOR = 2_500_000;

  it('re-anchors when there is no anchor yet or ATM is unavailable', () => {
    expect(straddleShouldRecenter(ANCHOR, undefined, STEP)).toBe(true);
    expect(straddleShouldRecenter(undefined, ANCHOR, STEP)).toBe(true);
  });

  it('keeps the window through a one-strike oscillation while flat', () => {
    // ATM drifts up one strike and back: within tolerance both ways -> no reset,
    // so the 180s window survives and the proxy can actually warm up.
    expect(straddleShouldRecenter(ANCHOR + STEP, ANCHOR, STEP)).toBe(false);
    expect(straddleShouldRecenter(ANCHOR - STEP, ANCHOR, STEP)).toBe(false);
    expect(straddleShouldRecenter(ANCHOR, ANCHOR, STEP)).toBe(false);
  });

  it('re-anchors on a sustained move of more than one strike', () => {
    expect(straddleShouldRecenter(ANCHOR + 2 * STEP, ANCHOR, STEP)).toBe(true);
    expect(straddleShouldRecenter(ANCHOR - 2 * STEP, ANCHOR, STEP)).toBe(true);
  });
});

describe('OP(-) runner naked short sequencing', () => {
  it('reports the selected expiry and calendar DTE', () => {
    const r = rig();
    expect(r.runner.mmState()).toMatchObject({ expiryDate: SCALP_EXPIRY, daysToExpiry: 6 });
  });

  it('opens two CE and two PE short lots without protective long positions', async () => {
    const r = rig();
    r.runner.arm();
    await r.runner.onTimer(T0);
    // Entries rest one tick above the bid (never AT the bid); tick the bid up
    // to the resting quotes so the paper broker's touch fill takes them.
    for (const id of [IDS.scalpCe, IDS.scalpPe]) {
      r.paper.setQuote(id, { bidPaise: 9_995, askPaise: 10_005, ltpPaise: 10_000 });
    }

    const orders = r.oms.getOrders();
    expect(orders.filter((order) => order.tag.endsWith(':short_entry'))).toHaveLength(4);
    expect(orders.every((order) => order.tag.endsWith(':short_entry') && order.side === 'SELL')).toBe(true);
    expect(r.oms.getPositions()).toHaveLength(2);
    expect(r.oms.getPositions().every((position) => position.side === 'SELL' && position.qty === 2 * LOT)).toBe(true);
    expect(r.oms.getPositions().some((position) => position.side === 'BUY')).toBe(false);
  });

  it('cancels a young short entry immediately when the range regime breaks', async () => {
    // entryImprovementTicks: 0 rests the short at the ask so it stays working.
    const r = rig({ minRequoteMs: 5_000, rangeFilterEnabled: true, entryImprovementTicks: 0 });
    r.view.features = calmFeatures(); // ret30=0, spot at VWAP → rangeReady
    r.runner.arm();
    await r.runner.onTimer(T0);
    const entry = r.oms.getOrders().find((order) => order.tag.endsWith(':short_entry'))!;
    expect(entry).toBeDefined();
    expect(r.oms.getOrder(entry.clientOrderId)?.state).toBe('ACKED');

    // 30s return blows through maxAbsRet30Pct → PAUSED_REGIME. The entry is
    // younger than minRequoteMs but must not be retained: a fill here would be
    // short premium into the exact momentum the range gate exists to avoid.
    r.view.features = calmFeatures(0.05);
    await r.runner.onTimer(T0 + 1_000);
    expect(r.runner.mmState().quotePhase).toBe('PAUSED_REGIME');
    expect(r.oms.getOrder(entry.clientOrderId)?.state).toBe('CANCELLED');
  });

  it('keeps each working target stable instead of cancelling and recreating it every tick', async () => {
    const r = rig({ scalpLotsPerRight: 1, runnerLots: 0, pairedExitEnabled: false });
    r.runner.arm();
    await r.runner.onTimer(T0);
    for (const id of [IDS.scalpCe, IDS.scalpPe]) {
      r.paper.setQuote(id, { bidPaise: 9_995, askPaise: 10_005, ltpPaise: 10_000 });
    }

    await r.runner.onTimer(T0 + 1_000);
    const targets = r.oms.getOrders().filter((order) => order.tag.endsWith(':target'));
    expect(targets).toHaveLength(2);
    expect(targets.every((order) => order.state === 'ACKED')).toBe(true);
    const targetIds = targets.map((order) => order.clientOrderId).sort();

    await r.runner.onTimer(T0 + 2_000);
    await r.runner.onOptionTick(IDS.scalpCe, 10_000, T0 + 2_500);
    const after = r.oms.getOrders().filter((order) => order.tag.endsWith(':target'));
    expect(after.map((order) => order.clientOrderId).sort()).toEqual(targetIds);
    expect(after.every((order) => order.state === 'ACKED')).toBe(true);
  });

  it('caps completed cycles per right and keeps quoting the other side', async () => {
    const r = rig({ maxCyclesPerRight: 1, scalpLotsPerRight: 1, runnerLots: 0 });
    r.runner.arm();
    const completed = (instrumentId: InstrumentId): Trade =>
      ({
        instrumentId,
        netPnlPaise: 100,
        exitReason: 'target',
        exit: { clientOrderId: 'not-a-real-order', ts: T0 },
      }) as unknown as Trade;

    // One CE round trip is already done today → CE is capped, PE still quotes.
    r.runner.onTrade(completed(IDS.scalpCe));
    await r.runner.onTimer(T0);
    const entries = r.oms.getOrders().filter((order) => order.tag.endsWith(':short_entry'));
    expect(entries.some((order) => order.instrumentId === IDS.scalpPe)).toBe(true);
    expect(entries.some((order) => order.instrumentId === IDS.scalpCe)).toBe(false);

    // PE completes its cycle too → both capped: no entries, explicit reason,
    // and the still-working PE quote is pulled rather than left to fill.
    r.runner.onTrade(completed(IDS.scalpPe));
    await r.runner.onTimer(T0 + 1_000);
    expect(r.runner.lastNoTrade()).toBe('CYCLES_CAPPED');
    const workingEntries = r.oms.getOrders().filter(
      (order) => order.tag.endsWith(':short_entry') && !isTerminalOrderState(order.state),
    );
    expect(workingEntries).toHaveLength(0);
  });

  it('opens 2 CE + 2 PE shorts and assigns one runner after target', async () => {
    const r = rig();
    r.runner.arm();
    await r.runner.onTimer(T0); // four short asks rest one tick above the bid
    // Tick the bid up to the resting entry quotes so the touch fill takes them.
    for (const id of [IDS.scalpCe, IDS.scalpPe]) {
      r.paper.setQuote(id, { bidPaise: 9_995, askPaise: 10_005, ltpPaise: 10_000 });
    }

    const shortEntries = r.oms.getOrders().filter((order) => order.tag.endsWith(':short_entry'));
    expect(shortEntries).toHaveLength(4);
    expect(shortEntries.every((order) => order.side === 'SELL' && order.qty === LOT && order.state === 'FILLED')).toBe(true);
    for (const id of [IDS.scalpCe, IDS.scalpPe]) {
      const live = optionRow(id, id === IDS.scalpCe ? 'CE' : 'PE', SCALP_EXPIRY, 10_000, 10_005, T0 + 2_000);
      r.view.rows.set(id, live);
      r.paper.setQuote(id, { bidPaise: 10_000, askPaise: 10_005, ltpPaise: 10_000 });
    }
    expect(r.oms.getPositions().filter((position) => position.side === 'SELL')).toHaveLength(2);
    expect(r.oms.getPositions().filter((position) => position.side === 'SELL').every((position) => position.qty === 2 * LOT)).toBe(true);

    await r.runner.onTimer(T0 + 3_000);
    const state = r.runner.mmState();
    expect(state.runnerStatus).toBe('PENDING');
    const targets = r.oms.getOrders().filter((order) => !isTerminalOrderState(order.state) && order.tag.endsWith(':target'));
    expect(targets).toHaveLength(3);

    const target = Math.max(...targets.map((order) => order.limitPricePaise ?? 0));
    for (const id of [IDS.scalpCe, IDS.scalpPe]) {
      const live = optionRow(id, id === IDS.scalpCe ? 'CE' : 'PE', SCALP_EXPIRY, target - TICK, target, T0 + 4_000);
      r.view.rows.set(id, live);
      r.paper.setQuote(id, { bidPaise: target - TICK, askPaise: target, ltpPaise: target });
    }
    expect(r.runner.mmState().runnerStatus).toBe('ACTIVE');
    expect(r.oms.getPositions().filter((position) => position.side === 'SELL').reduce((sum, position) => sum + position.qty, 0)).toBe(LOT);
    expect(r.oms.getPositions().filter((position) => position.side === 'BUY').reduce((sum, position) => sum + position.qty, 0)).toBe(0);
  });
});
