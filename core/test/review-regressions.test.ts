import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, type MarketProfile, type RiskProfile } from '../src/config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type ClientOrderId, type InstrumentId, type PositionId, type SessionId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import type { Fill, Order, OrderIntent } from '../src/domain/orders.js';
import type { Position } from '../src/domain/positions.js';
import type { RiskVerdict } from '../src/domain/risk.js';
import { ManualClock, formatHHMMIst } from '../src/domain/time.js';
import type { BrokerOrderEvent, IBrokerAdapter } from '../src/exec/adapter.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import type { GatewayStateSlices } from '../src/gateway/protocol.js';
import { FeedMarketData } from '../src/host/feed-market-data.js';
import { PaperHost } from '../src/host/paper-host.js';
import { ExitEscalator } from '../src/oms/escalation.js';
import type { FlattenOmsPort, FlattenPorts } from '../src/oms/flatten.js';
import { Oms, type SubmitResult } from '../src/oms/oms.js';
import { Persistence } from '../src/persistence/db.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import { SessionRiskState } from '../src/risk/session-risk.js';
import { SessionManager } from '../src/session/session.js';
import { StopEngine } from '../src/stops/stop-engine.js';
import { StrategyRunner, type MarketViewProvider } from '../src/strategy/runner.js';
import { S1MomentumBurst } from '../src/strategy/strategies/s1-momentum-burst.js';
import type { IStrategy, StrategyDecision, StrategyView } from '../src/strategy/types.js';

/**
 * Regression tests for the defects found in the 2026-07 code review.
 * Each block names the bug it pins down; if one of these fails, a fixed
 * safety property has regressed.
 */

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(MarketProfileSchema, fileURLToPath(new URL('market/india-nse-options.json', configDir))).value;
const riskProfile: RiskProfile = loadConfig(RiskProfileSchema, fileURLToPath(new URL('risk/paper-default.json', configDir))).value;

const DATE = '2026-07-03';
const SESSION: SessionId = makeSessionId(DATE, 'paper');
const INSTR: InstrumentId = makeInstrumentId('NSE', 'RR1');
const CE_ID: InstrumentId = makeInstrumentId('NSE', 'CE1');
const PE_ID: InstrumentId = makeInstrumentId('NSE', 'PE1');
const ATM = 2_450_000;
const START_10AM_IST = Date.UTC(2026, 6, 3, 4, 30, 0); // 10:00 IST
const LOT = market.contract.lotSize;

function mkSentOrder(ids: IdFactory, opts: { side: 'BUY' | 'SELL'; qty?: number; limitPricePaise?: number }): Order {
  return {
    clientOrderId: ids.clientOrderId(),
    intentId: ids.intentId(),
    sessionId: SESSION,
    instrumentId: INSTR,
    side: opts.side,
    qty: opts.qty ?? LOT,
    filledQty: 0,
    avgFillPricePaise: 0,
    type: opts.limitPricePaise !== undefined ? 'LIMIT' : 'MARKET',
    ...(opts.limitPricePaise !== undefined ? { limitPricePaise: opts.limitPricePaise } : {}),
    state: 'SENT',
    purpose: opts.side === 'BUY' ? 'ENTRY' : 'STOP',
    tag: 'rr:test',
    createdTs: 1,
    updatedTs: 1,
  };
}

function entryIntent(ids: IdFactory, qty = LOT): OrderIntent {
  return {
    intentId: ids.intentId(),
    sessionId: SESSION,
    strategyId: 's1',
    ts: 1,
    side: 'BUY',
    instrumentId: INSTR,
    qty,
    type: 'LIMIT',
    limitPricePaise: 10_010,
    ttlMs: 1_000,
    tag: 's1:entry',
    purpose: 'ENTRY',
    stopPlan: { hardStopPremiumPaise: 9_000, timeStopSec: 60 },
  };
}

function approved(intentId: OrderIntent['intentId']): RiskVerdict {
  return { intentId, ts: 1, approved: true, riskPaise: 1_000 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
describe('PaperBroker — cancel/limit semantics (review fixes)', () => {
  it('never fills an order after its cancel was confirmed (kill-then-leak bug)', async () => {
    const broker = new PaperBroker({ fillLatencyMs: 15 });
    broker.setQuote(INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
    const events: BrokerOrderEvent[] = [];
    broker.onOrderEvent((ev) => events.push(ev));

    const ids = new IdFactory(SESSION);
    const order = mkSentOrder(ids, { side: 'BUY', limitPricePaise: 10_020 });
    await broker.placeOrder(order); // ACK sync, fill pending 15ms out
    await broker.cancelOrder(order.clientOrderId); // cancel confirmed first
    await sleep(40); // let the pending fill timer fire

    expect(events.some((e) => e.type === 'FILL')).toBe(false);
    expect(broker.getPositions()).toHaveLength(0);
    expect(broker.getOrders()[0]?.state).toBe('CANCELLED');
  });

  it('cancel never rewrites a FILLED order to CANCELLED in the broker book', async () => {
    const broker = new PaperBroker({ clock: new ManualClock(1) });
    broker.setQuote(INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
    const ids = new IdFactory(SESSION);
    const order = mkSentOrder(ids, { side: 'BUY', limitPricePaise: 10_020 });
    await broker.placeOrder(order); // fills synchronously
    await broker.cancelOrder(order.clientOrderId);
    expect(broker.getOrders()[0]?.state).toBe('FILLED');
  });

  it('a non-marketable limit rests ACKED instead of filling through the limit', async () => {
    const broker = new PaperBroker({ clock: new ManualClock(1) });
    broker.setQuote(INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
    const events: BrokerOrderEvent[] = [];
    broker.onOrderEvent((ev) => events.push(ev));

    const ids = new IdFactory(SESSION);
    // BUY limit below the ask: must rest, not fill at the (worse) ask.
    await broker.placeOrder(mkSentOrder(ids, { side: 'BUY', limitPricePaise: 10_000 }));
    expect(events.map((e) => e.type)).toEqual(['ACK']);
    expect(broker.getPositions()).toHaveLength(0);
    expect(broker.getOrders()[0]?.state).toBe('ACKED');
  });

  it('slippage on a marketable limit never breaches the limit price', async () => {
    const broker = new PaperBroker({ clock: new ManualClock(1), slippageTicks: 3, tickSizePaise: 5 });
    broker.setQuote(INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
    const events: BrokerOrderEvent[] = [];
    broker.onOrderEvent((ev) => events.push(ev));

    const ids = new IdFactory(SESSION);
    // ask 10_010 + 15 slip = 10_025, but the limit caps the fill at 10_012.
    await broker.placeOrder(mkSentOrder(ids, { side: 'BUY', limitPricePaise: 10_012 }));
    const fill = events.find((e) => e.type === 'FILL');
    expect(fill?.type === 'FILL' ? fill.fill.pricePaise : 0).toBe(10_012);
  });
});

// --------------------------------------------------------------------------
describe('OMS — TTL expiry cancels at the broker; adapter throw is contained', () => {
  it('expireTtl sends cancel-and-verify to the broker (no zombie resting order)', async () => {
    const clock = new ManualClock(START_10AM_IST);
    const ids = new IdFactory(SESSION);
    const broker = new PaperBroker({ clock });
    broker.setQuote(INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
    broker.holdFills(INSTR, 1); // order rests ACKED at the broker
    const oms = new Oms({ sessionId: SESSION, adapter: broker, marketProfile: market, clock, ids });

    const e = entryIntent(ids);
    const res = await oms.submit(e, approved(e.intentId));
    expect(broker.getOrders()[0]?.state).toBe('ACKED');

    clock.advance(1_001); // past the 1000ms intent TTL
    const expired = oms.expireTtl();
    expect(expired[0]?.state).toBe('EXPIRED');
    // The broker-side order must be cancelled, not left live to fill later.
    expect(broker.getOrders()[0]?.state).toBe('CANCELLED');
    // The OMS keeps its EXPIRED terminal state (CANCELLED event is stale).
    expect(oms.getOrder(res.order.clientOrderId)?.state).toBe('EXPIRED');
  });

  it('submit returns accepted:false when the adapter throws on the wire call', async () => {
    const ids = new IdFactory(SESSION);
    const adapter: IBrokerAdapter = {
      adapterId: 'boom',
      placeOrder: () => Promise.reject(new Error('socket dead')),
      cancelOrder: () => Promise.resolve(),
      getOrders: () => [],
      getPositions: () => [],
      onOrderEvent: () => () => {},
    };
    const oms = new Oms({ sessionId: SESSION, adapter, marketProfile: market, clock: new ManualClock(1), ids });
    const e = entryIntent(ids);
    const res = await oms.submit(e, approved(e.intentId));
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('ADAPTER_ERROR');
    expect(res.order.state).toBe('REJECTED');
  });
});

// --------------------------------------------------------------------------
describe('RiskGate — one-sided book cannot slip past the spread gate', () => {
  function ctx(row: { bidPaise: number; askPaise: number }): RiskGateContext {
    const risk = new SessionRiskState(riskProfile);
    return {
      nowMs: START_10AM_IST,
      nowHHMM: formatHHMMIst(START_10AM_IST),
      allowedInstruments: new Set([INSTR]),
      optionRows: new Map([[INSTR, {
        instrumentId: INSTR, strikePaise: ATM, right: 'CE' as const, expiry: '2026-07-07',
        ltpPaise: 15_000, bidPaise: row.bidPaise, askPaise: row.askPaise,
        bidQty: 650, askQty: 650, volume: 100_000, oi: 500_000, updatedTs: START_10AM_IST,
      }]]),
      openPositions: [],
      session: risk.current(),
    };
  }

  it('rejects an ENTRY on an empty or one-sided book as SPREAD_GATE', () => {
    const gate = new RiskGate(market, riskProfile);
    const ids = new IdFactory(SESSION);
    expect(gate.evaluate(entryIntent(ids), ctx({ bidPaise: 0, askPaise: 15_000 })).reason).toBe('SPREAD_GATE');
    expect(gate.evaluate(entryIntent(ids), ctx({ bidPaise: 14_990, askPaise: 0 })).reason).toBe('SPREAD_GATE');
    expect(gate.evaluate(entryIntent(ids), ctx({ bidPaise: 14_990, askPaise: 15_000 })).approved).toBe(true);
  });

  it('rejects an ENTRY with no quote row at all — a limit price must not bypass the quote gates', () => {
    const gate = new RiskGate(market, riskProfile);
    const ids = new IdFactory(SESSION);
    const noRow = { ...ctx({ bidPaise: 14_990, askPaise: 15_000 }), optionRows: new Map<InstrumentId, never>() };
    expect(gate.evaluate(entryIntent(ids), noRow).reason).toBe('NO_OPTION_QUOTE');
  });
});

// --------------------------------------------------------------------------
describe('SessionManager — square-off never claims CLOSED while positions are live', () => {
  function mkPos(): Position {
    return {
      positionId: 'pos-so' as PositionId, sessionId: SESSION, strategyId: 's1', instrumentId: INSTR,
      side: 'BUY', qty: LOT, avgEntryPricePaise: 15_000, state: 'OPEN', realizedGrossPaise: 0,
      openedTs: 1, updatedTs: 1,
    };
  }

  /** Exit submits are accepted but rest working; fills land only on fill(). */
  class SlowExitPort implements FlattenOmsPort {
    positions: Position[] = [mkPos()];
    orders: Order[] = [];
    submits = 0;
    getOrders(): Order[] { return this.orders; }
    getPositions(): Position[] { return this.positions; }
    async cancel(): Promise<void> {}
    async submit(intent: OrderIntent): Promise<SubmitResult> {
      this.submits++;
      const ids = new IdFactory(SESSION);
      const order: Order = {
        clientOrderId: `so-${this.submits}` as ClientOrderId, intentId: intent.intentId, sessionId: SESSION,
        instrumentId: intent.instrumentId, side: 'SELL', qty: intent.qty, filledQty: 0, avgFillPricePaise: 0,
        type: 'LIMIT', state: 'ACKED', purpose: intent.purpose, tag: intent.tag, createdTs: 1, updatedTs: 1,
      };
      void ids;
      this.orders.push(order);
      return { order, accepted: true };
    }
    fill(): void {
      this.positions = [];
      this.orders = this.orders.map((o) => ({ ...o, state: 'FILLED' as const, filledQty: o.qty }));
    }
  }

  function istMs(hh: number, mm: number): number {
    return Date.UTC(2026, 6, 3, hh, mm) - 330 * 60_000;
  }

  it('stays SQUARE_OFF while exits work, does not stack sells, closes once flat', async () => {
    const clock = new ManualClock(istMs(9, 20));
    const port = new SlowExitPort();
    const risk = new SessionRiskState(riskProfile);
    const events: Array<{ type: JournalEventType }> = [];
    const sink = <K extends JournalEventType>(type: K, _payload: JournalPayloads[K]): void => {
      events.push({ type });
    };
    const ports = (): FlattenPorts => ({
      sessionId: SESSION,
      oms: port,
      gate: new RiskGate(market, riskProfile),
      gateContext: () => ({
        nowMs: clock.now(), nowHHMM: formatHHMMIst(clock.now()),
        allowedInstruments: new Set([INSTR]), optionRows: new Map(),
        openPositions: port.getPositions(), session: risk.current(),
      }),
      ids: new IdFactory(SESSION), market, markPrice: () => 14_900, clock, journal: sink, protectTicks: 5,
    });
    const session = new SessionManager({
      sessionId: SESSION, mode: 'paper', date: DATE, market,
      target: { disarm: () => undefined },
      flattenPorts: ports,
      preflight: {
        resolveChain: () => ({ expiryDate: '2026-07-07', chain: new Map(), lotSize: LOT, tickSizePaise: 5, rowCount: 1 }),
        lastTickTs: () => clock.now() - 500, feedStaleMs: 5_000,
        killSelfTest: () => ({ ok: true, checks: [{ name: 'dry', ok: true }] }),
        journalReady: () => Promise.resolve(),
        configs: [],
      },
      clock, journal: sink,
    });

    await session.runPreflight();
    session.acknowledge('op');
    await session.onTimer(clock.now());
    expect(session.phase()).toBe('OPEN');

    clock.set(istMs(15, 13));
    await session.onTimer(clock.now()); // square-off: exit submitted, still working
    expect(port.submits).toBe(1);
    expect(session.phase()).toBe('SQUARE_OFF'); // NOT closed — position still live
    expect(events.some((e) => e.type === 'session.closed')).toBe(false);

    await session.onTimer(clock.now()); // retry pass: working exit → no duplicate sell
    expect(port.submits).toBe(1);
    expect(session.phase()).toBe('SQUARE_OFF');

    port.fill(); // exit finally fills
    await session.onTimer(clock.now());
    expect(session.phase()).toBe('CLOSED');
    expect(events.filter((e) => e.type === 'session.closed')).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
describe('OMS — unacked cancel-and-verify retries once per window, never spams', () => {
  it('one cancel attempt per timeout window per order', async () => {
    const clock = new ManualClock(1);
    const ids = new IdFactory(SESSION);
    const cancels: ClientOrderId[] = [];
    const adapter: IBrokerAdapter = {
      adapterId: 'silent',
      placeOrder: () => Promise.resolve(),
      cancelOrder: (id) => { cancels.push(id); return Promise.resolve(); },
      getOrders: () => [],
      getPositions: () => [],
      onOrderEvent: () => () => {},
    };
    const oms = new Oms({ sessionId: SESSION, adapter, marketProfile: market, clock, ids, unackedTimeoutMs: 50 });
    const e = entryIntent(ids);
    await oms.submit(e, approved(e.intentId));

    clock.advance(51);
    expect(oms.cancelUnacked()).toHaveLength(1);
    expect(oms.cancelUnacked()).toHaveLength(0); // same window: throttled
    clock.advance(51);
    expect(oms.cancelUnacked()).toHaveLength(1); // next window: retried
    expect(cancels).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------
describe('StrategyRunner — in-flight latches release; stops stay armed until the exit is accepted', () => {
  interface FakeOmsScript {
    /** Per exit-submit call: accept or refuse. Entries always accept. */
    exitAccepts: boolean[];
    /** Entry order lands in this state (position appears only on FILLED). */
    entryOutcome: 'FILLED' | 'REJECTED';
  }

  function makeFakeOms(ids: IdFactory, script: FakeOmsScript): {
    oms: Oms;
    exitSubmits: () => number;
    entrySubmits: () => number;
    setEntryOutcome: (o: 'FILLED' | 'REJECTED') => void;
    position: () => Position | undefined;
  } {
    let position: Position | undefined;
    const orders = new Map<ClientOrderId, Order>();
    let exitCount = 0;
    let entryCount = 0;
    const fake = {
      async submit(intent: OrderIntent, verdict: RiskVerdict): Promise<{ order: Order; accepted: boolean; reason?: string }> {
        void verdict;
        const order: Order = {
          clientOrderId: ids.clientOrderId(),
          intentId: intent.intentId,
          sessionId: SESSION,
          instrumentId: intent.instrumentId,
          side: intent.side,
          qty: intent.qty,
          filledQty: 0,
          avgFillPricePaise: 0,
          type: 'LIMIT',
          state: 'SENT',
          purpose: intent.purpose,
          tag: intent.tag,
          createdTs: intent.ts,
          updatedTs: intent.ts,
        };
        if (intent.purpose === 'ENTRY') {
          entryCount++;
          const filled = script.entryOutcome === 'FILLED';
          const final: Order = { ...order, state: script.entryOutcome, filledQty: filled ? intent.qty : 0 };
          orders.set(final.clientOrderId, final);
          if (filled) {
            position = {
              positionId: 'pos-rr-1' as PositionId,
              sessionId: SESSION,
              strategyId: intent.strategyId,
              instrumentId: intent.instrumentId,
              side: 'BUY',
              qty: intent.qty,
              avgEntryPricePaise: intent.limitPricePaise ?? 15_000,
              state: 'OPEN',
              realizedGrossPaise: 0,
              openedTs: intent.ts,
              updatedTs: intent.ts,
            };
          }
          return { order: final, accepted: true };
        }
        exitCount++;
        const ok = script.exitAccepts.shift() ?? true;
        if (ok) position = undefined; // exit filled instantly
        const final: Order = { ...order, state: ok ? 'FILLED' : 'REJECTED' };
        orders.set(final.clientOrderId, final);
        return { order: final, accepted: ok, ...(ok ? {} : { reason: 'THROTTLED' }) };
      },
      getOrder: (id: ClientOrderId) => orders.get(id),
      getOrders: () => [...orders.values()],
      getPositions: () => (position !== undefined ? [position] : []),
      cancel: () => Promise.resolve(),
    };
    return {
      oms: fake as unknown as Oms,
      exitSubmits: () => exitCount,
      entrySubmits: () => entryCount,
      setEntryOutcome: (o) => { script.entryOutcome = o; },
      position: () => position,
    };
  }

  function makeView(): MarketViewProvider {
    const row = {
      instrumentId: CE_ID, strikePaise: ATM, right: 'CE' as const, expiry: '2026-07-07',
      ltpPaise: 15_000, bidPaise: 14_990, askPaise: 15_000,
      bidQty: 650, askQty: 650, volume: 100_000, oi: 500_000, updatedTs: START_10AM_IST,
    };
    return {
      strategyView: (nowMs: number): Omit<StrategyView, 'params'> => ({
        nowMs,
        spotPaise: ATM,
        atmStrikePaise: ATM,
        atmOption: () => ({ instrumentId: CE_ID, row }),
      }),
      allowedInstruments: () => new Set([CE_ID]),
      optionRows: () => new Map([[CE_ID, row]]),
      atmStrikePaise: () => ATM,
      spotPaise: () => ATM,
    };
  }

  /** Proposes one CE entry per arm-cycle whenever asked. */
  class AlwaysEnter implements IStrategy {
    readonly id = 'rr-strategy';
    readonly version = '0';
    decide(view: StrategyView): StrategyDecision {
      const opt = view.atmOption('CE');
      if (opt === undefined) return { kind: 'NONE' };
      return {
        kind: 'ENTRY',
        right: 'CE',
        instrumentId: opt.instrumentId,
        qtyLots: 1,
        entryType: 'LIMIT',
        limitPricePaise: 15_000,
        ttlMs: 1_500,
        stopPlan: { hardStopPremiumPaise: 12_000, timeStopSec: 90 },
      };
    }
    reset(): void {}
  }

  function makeRunner(fakeOms: Oms, stopEngine: StopEngine, clock: ManualClock): StrategyRunner {
    return new StrategyRunner({
      sessionId: SESSION,
      strategy: new AlwaysEnter(),
      params: {},
      market,
      gate: new RiskGate(market, riskProfile),
      oms: fakeOms,
      stopEngine,
      sessionRisk: new SessionRiskState(riskProfile),
      ids: new IdFactory(SESSION),
      clock,
      view: makeView(),
      eligibility: {
        entryWindows: [{ from: '09:20', to: '15:00' }],
        blackoutDates: new Set(),
        maxSpreadPct: 0.015,
        minOi: 100,
        minVolume: 100,
        strikeBand: 5,
        strikeStepPaise: market.contract.strikeStepPaise,
      },
      todayDate: DATE,
      cooldownSec: 5,
    });
  }

  it('a rejected entry releases entryInFlight — the runner can enter again (deadlock bug)', async () => {
    const clock = new ManualClock(START_10AM_IST);
    const ids = new IdFactory(SESSION);
    const script: FakeOmsScript = { exitAccepts: [], entryOutcome: 'REJECTED' };
    const f = makeFakeOms(ids, script);
    const runner = makeRunner(f.oms, new StopEngine({ ids, tickSizePaise: market.tickSizePaise }), clock);
    runner.arm();

    await runner.onUnderlyingTick(clock.now()); // entry #1 → broker REJECTED, no position
    expect(f.entrySubmits()).toBe(1);
    expect(f.position()).toBeUndefined();

    f.setEntryOutcome('FILLED');
    clock.advance(1_000);
    // Before the fix this tick was silently swallowed (entryInFlight stuck true).
    await runner.onUnderlyingTick(clock.now());
    expect(f.entrySubmits()).toBe(2);
    expect(f.position()).toBeDefined();
    expect(runner.state()).toBe('ACTIVE');
  });

  it('a failed stop-exit submit keeps the stop armed and retries next tick (unprotected-position bug)', async () => {
    const clock = new ManualClock(START_10AM_IST);
    const ids = new IdFactory(SESSION);
    const script: FakeOmsScript = { exitAccepts: [false, true], entryOutcome: 'FILLED' };
    const f = makeFakeOms(ids, script);
    const stopEngine = new StopEngine({ ids, tickSizePaise: market.tickSizePaise });
    const runner = makeRunner(f.oms, stopEngine, clock);
    runner.arm();

    await runner.onUnderlyingTick(clock.now()); // entry fills, stop armed
    expect(runner.state()).toBe('ACTIVE');
    expect(stopEngine.get('pos-rr-1')).toBeDefined();

    clock.advance(1_000);
    await runner.onOptionTick(CE_ID, 11_000, clock.now()); // ≤ 12_000 hard stop → trigger; submit refused
    expect(f.exitSubmits()).toBe(1);
    // Before the fix the stop was disarmed here with NO exit working → stranded.
    expect(stopEngine.get('pos-rr-1')).toBeDefined();
    expect(f.position()).toBeDefined();

    clock.advance(1_000);
    await runner.onOptionTick(CE_ID, 11_000, clock.now()); // retry → accepted
    expect(f.exitSubmits()).toBe(2);
    expect(stopEngine.get('pos-rr-1')).toBeUndefined();
    expect(f.position()).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
describe('ExitEscalator — a refused escalation submit is retried, never dropped', () => {
  it('re-tracks the exit and re-escalates on the next poll', async () => {
    const clock = new ManualClock(START_10AM_IST);
    const ids = new IdFactory(SESSION);
    const risk = new SessionRiskState(riskProfile);
    let refusals = 1;
    const submits: OrderIntent[] = [];
    const dead: Order = { ...mkSentOrder(ids, { side: 'SELL', limitPricePaise: 9_990 }), state: 'CANCELLED' };
    const orders = new Map<ClientOrderId, Order>([[dead.clientOrderId, dead]]);

    const fakeOms = {
      getOrder: (id: ClientOrderId) => orders.get(id),
      cancel: () => Promise.resolve(),
      async submit(intent: OrderIntent): Promise<{ order: Order; accepted: boolean; reason?: string }> {
        submits.push(intent);
        if (refusals > 0) {
          refusals--;
          return { order: mkSentOrder(ids, { side: 'SELL' }), accepted: false, reason: 'THROTTLED' };
        }
        const order: Order = { ...mkSentOrder(ids, { side: 'SELL' }), state: 'FILLED', filledQty: LOT };
        orders.set(order.clientOrderId, order);
        return { order, accepted: true };
      },
    };

    const esc = new ExitEscalator({
      oms: fakeOms,
      gate: new RiskGate(market, riskProfile),
      gateContext: () => ({
        nowMs: clock.now(),
        nowHHMM: formatHHMMIst(clock.now()),
        allowedInstruments: new Set([INSTR]),
        optionRows: new Map(),
        openPositions: [],
        session: risk.current(),
      }),
      ids,
      market,
      markPrice: () => 10_000,
      clock,
    });

    const intent: OrderIntent = {
      intentId: ids.intentId(), sessionId: SESSION, strategyId: 's1', ts: clock.now(),
      side: 'SELL', instrumentId: INSTR, qty: LOT, type: 'LIMIT', limitPricePaise: 9_990,
      ttlMs: 2_000, tag: 's1:stop', purpose: 'STOP',
    };
    esc.track(dead, intent);

    clock.advance(800);
    await esc.poll(clock.now()); // dead order → escalate → submit refused → re-tracked
    expect(submits).toHaveLength(1);
    expect(esc.trackedCount()).toBe(1); // NOT dropped (the bug)

    clock.advance(800);
    await esc.poll(clock.now()); // retry → accepted
    expect(submits).toHaveLength(2);
  });
});

// --------------------------------------------------------------------------
describe('PaperHost — kill-switch auto trips are wired (feed stale while positioned)', () => {
  it('6s of feed silence with an open position trips FEED_STALE and flattens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-host-'));
    const clock = new ManualClock(START_10AM_IST);
    const marketData = new FeedMarketData({
      spotInstrumentId: makeInstrumentId('NSE', 'SPOT'),
      options: [
        { instrumentId: CE_ID, strikePaise: ATM, right: 'CE', expiry: '2026-07-07' },
        { instrumentId: PE_ID, strikePaise: ATM, right: 'PE', expiry: '2026-07-07' },
      ],
      strikeStepPaise: market.contract.strikeStepPaise,
    });
    const paper = new PaperBroker({ clock });
    paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });

    const SPOT_ID = makeInstrumentId('NSE', 'SPOT');
    const spotTick = (ts: number, ltp: number): Tick => ({
      instrumentId: SPOT_ID, ts, recvTs: ts, ltpPaise: ltp, qty: 100, volume: 1_000,
      bidPaise: ltp - 5, askPaise: ltp + 5, bidQty: 100, askQty: 100,
    });
    const optTick = (ts: number): Tick => ({
      instrumentId: CE_ID, ts, recvTs: ts, ltpPaise: 15_000, qty: 50, volume: 100_000,
      oi: 500_000, bidPaise: 14_990, askPaise: 15_000, bidQty: 650, askQty: 650,
    });

    let ts = START_10AM_IST;
    marketData.ingest(spotTick(ts, ATM));
    marketData.ingest(optTick(ts));

    // Capture the derived slices the host must keep fresh for the UI.
    let published: GatewayStateSlices | undefined;
    const gateway = {
      ingestJournal: (): void => undefined,
      publishState: (slices: GatewayStateSlices): void => {
        published = slices;
      },
    };

    const host = new PaperHost({
      sessionId: SESSION, date: DATE, mode: 'paper', market, riskProfile,
      eligibility: {
        entryWindows: [{ from: '09:20', to: '15:00' }], blackoutDates: new Set(),
        maxSpreadPct: 0.015, minOi: 100, minVolume: 100, strikeBand: 5, strikeStepPaise: market.contract.strikeStepPaise,
      },
      strategy: new S1MomentumBurst(),
      params: { impulsePct: 0.0008, confirmTicks: 2, lots: 1, ttlMs: 1500, tickSizePaise: 5, timeStopSec: 90, hardStopPremiumPct: 25 },
      regime: { trend: () => 1, highVolDay: () => false },
      broker: paper, marketData, ids: new IdFactory(SESSION), clock,
      journalDir: dir, fsync: 'never',
      configs: [{ name: 'market', hash: 'abc123abc123', path: 'm' }],
      gateway,
    });
    await host.start();
    expect(host.runnerState()).toBe('ARMED');

    const spot = async (ltp: number): Promise<void> => {
      ts += 1_000; clock.set(ts);
      await host.ingestTick(spotTick(ts, ltp));
    };
    let s = ATM;
    for (let i = 0; i < 10; i++) await spot(s); // warmup
    s += 2_500; await spot(s); // CONFIRMING
    s += 2_500; await spot(s); // ENTRY → fill
    expect(host.positions().filter((p) => p.qty > 0)).toHaveLength(1);

    // Feed goes silent for 6s while positioned → FEED_STALE must trip.
    ts += 6_000; clock.set(ts);
    await host.onTimer(ts);
    await new Promise<void>((r) => setImmediate(r)); // drain the async trip

    expect(host.killLocked()).toBe(true);
    expect(host.sessionPhase()).toBe('KILLED');
    const trip = host.journalEvents().find((e) => e.type === 'kill.tripped');
    expect(trip?.type === 'kill.tripped' && trip.payload.reason).toBe('FEED_STALE');
    expect(host.positions().filter((p) => p.state !== 'CLOSED' && p.qty > 0)).toHaveLength(0);

    // Gateway freshness: the host pushed derived slices on the timer —
    // health went STALE, chain rows and risk limits are populated, and the
    // algo lifecycle reflects the kill-disarm.
    expect(published).toBeDefined();
    expect(published?.health.feedStatus).toBe('STALE');
    expect(published?.chain.length).toBe(2);
    expect(published?.risk.limits.maxTradesPerDay).toBe(riskProfile.maxTradesPerDay);
    expect(published?.algo.lifecycle).toBe('DISARMED');

    await host.close();

    // SQLite runtime mirror (01-DESIGN §9): scalper.db was written alongside
    // the journal and carries the session's orders and the flatten trade.
    const db = new Persistence(join(dir, 'scalper.db'));
    const counts = db.counts(SESSION);
    expect(counts.sessions).toBe(1);
    expect(counts.orders).toBeGreaterThanOrEqual(2); // entry + kill exit
    expect(counts.trades).toBe(1);
    db.close();
  }, 20_000);
});

// --------------------------------------------------------------------------
describe('OMS state machine — fill-before-ack does not crash the fill path', () => {
  it('applies a FILL that arrives while the order is still SENT (lost ack)', async () => {
    const ids = new IdFactory(SESSION);
    let handler: ((ev: BrokerOrderEvent) => void) | undefined;
    const adapter: IBrokerAdapter = {
      adapterId: 'silent',
      placeOrder: () => Promise.resolve(),
      cancelOrder: () => Promise.resolve(),
      getOrders: () => [],
      getPositions: () => [],
      onOrderEvent: (cb) => { handler = cb; return () => { handler = undefined; }; },
    };
    const oms = new Oms({ sessionId: SESSION, adapter, marketProfile: market, clock: new ManualClock(1), ids });
    const e = entryIntent(ids);
    const res = await oms.submit(e, approved(e.intentId));

    const fill: Fill = { clientOrderId: res.order.clientOrderId, fillId: 'rr-f1', ts: 2, qty: LOT, pricePaise: 10_010 };
    handler?.({ type: 'FILL', clientOrderId: res.order.clientOrderId, fill, brokerEventId: 'rr-f1' });

    expect(oms.getOrder(res.order.clientOrderId)?.state).toBe('FILLED');
    expect(oms.getPositions()[0]?.qty).toBe(LOT);
  });
});
