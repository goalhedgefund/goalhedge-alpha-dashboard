/**
 * M9b step 3 acceptance: reconciliation loop — GREEN/AMBER/RED classification,
 * recon.result journaled deduplicated on state change, and RED (position qty
 * mismatch) tripping the kill switch (AUTO / RECON_MISMATCH). PaperBroker
 * reconciles GREEN in a normal run; a fault injected straight into the broker
 * book drives RED.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, type MarketProfile, type RiskProfile } from '../src/config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type ClientOrderId, type InstrumentId } from '../src/domain/ids.js';
import type { Order, OrderIntent, OrderState } from '../src/domain/orders.js';
import type { Position } from '../src/domain/positions.js';
import type { RiskVerdict } from '../src/domain/risk.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { KillSwitch } from '../src/killswitch/kill-switch.js';
import { Oms } from '../src/oms/oms.js';
import { Reconciler, type ReconBookPort, type ReconKillPort } from '../src/oms/reconciler.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(MarketProfileSchema, fileURLToPath(new URL('market/india-nse-options.json', configDir))).value;
const risk: RiskProfile = loadConfig(RiskProfileSchema, fileURLToPath(new URL('risk/paper-default.json', configDir))).value;
const SESSION = makeSessionId('2026-07-03', 'paper');
const CE = makeInstrumentId('NSE', 'CE1');
const LOT = market.contract.lotSize;

// ---------------------------------------------------------------- fixtures

interface Captured {
  events: Array<{ type: JournalEventType; payload: unknown }>;
  sink: <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;
}
function capture(): Captured {
  const events: Captured['events'] = [];
  return { events, sink: (type, payload) => events.push({ type, payload }) };
}

function mkPosition(qty = LOT, instrumentId: InstrumentId = CE): Position {
  return {
    positionId: `pos-${instrumentId}` as Position['positionId'],
    sessionId: SESSION,
    strategyId: 's1',
    instrumentId,
    side: 'BUY',
    qty,
    avgEntryPricePaise: 15_000,
    state: 'OPEN',
    realizedGrossPaise: 0,
    openedTs: 1_000,
    updatedTs: 1_000,
  };
}

function mkOrder(state: OrderState, id: string): Order {
  return {
    clientOrderId: id as ClientOrderId,
    intentId: 'int-x' as Order['intentId'],
    sessionId: SESSION,
    instrumentId: CE,
    side: 'BUY',
    qty: LOT,
    filledQty: 0,
    avgFillPricePaise: 0,
    type: 'LIMIT',
    limitPricePaise: 15_000,
    state,
    purpose: 'ENTRY',
    tag: 's1:entry',
    createdTs: 1,
    updatedTs: 1,
  };
}

class FakeBook implements ReconBookPort {
  constructor(
    public orders: Order[] = [],
    public positions: Position[] = [],
  ) {}
  getOrders(): Order[] {
    return this.orders;
  }
  getPositions(): Position[] {
    return this.positions;
  }
}

function fakeKill(): ReconKillPort & { trips: string[]; locked: boolean } {
  return {
    trips: [],
    locked: false,
    async trip(_source, reason): Promise<void> {
      this.trips.push(reason);
      this.locked = true;
    },
    isLocked(): boolean {
      return this.locked;
    },
  };
}

// ------------------------------------------------------------------- classify

describe('reconciliation classification', () => {
  it('GREEN when books agree — journals a single ok result, no trip', () => {
    const oms = new FakeBook([mkOrder('FILLED', 'o1')], [mkPosition()]);
    const broker = new FakeBook([mkOrder('FILLED', 'o1')], [mkPosition()]);
    const cap = capture();
    const kill = fakeKill();
    const rc = new Reconciler({ oms, adapter: broker, kill, journal: cap.sink });

    expect(rc.reconcile().state).toBe('GREEN');
    rc.reconcile();
    rc.reconcile();
    expect(cap.events.filter((e) => e.type === 'recon.result').length).toBe(1);
    expect(cap.events[0]?.payload).toMatchObject({ ok: true });
    expect(kill.trips).toEqual([]);
  });

  it('AMBER when a working order exists on one side only — warns, does not trip', () => {
    const oms = new FakeBook([mkOrder('ACKED', 'o1')], [mkPosition()]);
    const broker = new FakeBook([], [mkPosition()]); // broker never saw the working order
    const cap = capture();
    const kill = fakeKill();
    const rc = new Reconciler({ oms, adapter: broker, kill, journal: cap.sink });

    const result = rc.reconcile();
    expect(result.state).toBe('AMBER');
    expect(result.orderDiffs).toEqual([{ clientOrderId: 'o1', issue: 'OMS_WORKING_ONLY', state: 'ACKED' }]);
    expect(kill.trips).toEqual([]);
    expect(cap.events[0]?.payload).toMatchObject({ ok: false, diffs: { state: 'AMBER' } });
  });

  it('RED on a net position qty mismatch — trips the kill switch once', () => {
    const oms = new FakeBook([], [mkPosition(LOT)]);
    const broker = new FakeBook([], [mkPosition(2 * LOT)]); // broker shows double
    const cap = capture();
    const kill = fakeKill();
    const rc = new Reconciler({ oms, adapter: broker, kill, journal: cap.sink });

    const result = rc.reconcile();
    expect(result.state).toBe('RED');
    expect(result.positionDiffs).toEqual([{ instrumentId: CE, omsNet: LOT, brokerNet: 2 * LOT }]);
    expect(kill.trips).toEqual(['RECON_MISMATCH']);

    // Still RED next tick, but kill already locked → no second trip.
    rc.reconcile();
    expect(kill.trips).toEqual(['RECON_MISMATCH']);
  });

  it('a phantom broker position (OMS flat) is RED', () => {
    const oms = new FakeBook([], []);
    const broker = new FakeBook([], [mkPosition(LOT)]);
    const kill = fakeKill();
    const rc = new Reconciler({ oms, adapter: broker, kill });
    expect(rc.reconcile().state).toBe('RED');
    expect(kill.trips).toEqual(['RECON_MISMATCH']);
  });

  it('dedups on state change: GREEN → RED → GREEN journals three, not per-tick', () => {
    const omsPos: Position[] = [mkPosition(LOT)];
    const brokerPos: Position[] = [mkPosition(LOT)];
    const oms = new FakeBook([], omsPos);
    const broker = new FakeBook([], brokerPos);
    const cap = capture();
    const kill = fakeKill();
    const rc = new Reconciler({ oms, adapter: broker, kill, journal: cap.sink });

    rc.reconcile(); // GREEN
    rc.reconcile(); // GREEN (no re-journal)
    broker.positions = [mkPosition(2 * LOT)];
    rc.reconcile(); // RED
    rc.reconcile(); // RED (no re-journal)
    broker.positions = [mkPosition(LOT)];
    rc.reconcile(); // GREEN again

    const recon = cap.events.filter((e) => e.type === 'recon.result');
    expect(recon.length).toBe(3);
    expect(recon.map((e) => (e.payload as { ok: boolean }).ok)).toEqual([true, false, true]);
  });
});

// ------------------------------------------------ integration: real OMS + broker

describe('integration: PaperBroker reconciles GREEN, injected drift trips', () => {
  async function submitEntry(oms: Oms, clock: ManualClock, ids: IdFactory): Promise<void> {
    const entry: OrderIntent = {
      intentId: ids.intentId(),
      sessionId: SESSION,
      strategyId: 's1',
      ts: clock.now(),
      side: 'BUY',
      instrumentId: CE,
      qty: LOT,
      type: 'LIMIT',
      limitPricePaise: 15_000,
      ttlMs: 1_500,
      tag: 's1:entry',
      purpose: 'ENTRY',
      stopPlan: { hardStopPremiumPaise: 11_250, timeStopSec: 90 },
    };
    await oms.submit(entry, { intentId: entry.intentId, ts: clock.now(), approved: true } as RiskVerdict);
  }

  it('normal run reconciles GREEN', async () => {
    const clock = new ManualClock(Date.UTC(2026, 6, 3, 4, 30));
    const ids = new IdFactory(SESSION);
    const paper = new PaperBroker({ clock });
    paper.setQuote(CE, { bidPaise: 14_900, askPaise: 15_000, ltpPaise: 15_000 });
    const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids });
    await submitEntry(oms, clock, ids);
    expect(oms.getPositions().filter((p) => p.state === 'OPEN').length).toBe(1);

    const kill = fakeKill();
    const rc = new Reconciler({ oms, adapter: paper, kill });
    expect(rc.reconcile().state).toBe('GREEN');
    expect(kill.trips).toEqual([]);
  });

  it('drift injected straight into the broker book → RED → kill trips', async () => {
    const clock = new ManualClock(Date.UTC(2026, 6, 3, 4, 30));
    const ids = new IdFactory(SESSION);
    const paper = new PaperBroker({ clock });
    paper.setQuote(CE, { bidPaise: 14_900, askPaise: 15_000, ltpPaise: 15_000 });
    const cap = capture();
    const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: cap.sink });
    await submitEntry(oms, clock, ids);

    const gateContext = (): RiskGateContext => ({
      nowMs: clock.now(),
      nowHHMM: '10:00',
      allowedInstruments: new Set([CE]),
      optionRows: new Map(),
      openPositions: oms.getPositions(),
      session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
    });
    const kill = new KillSwitch({
      sessionId: SESSION,
      target: { disarm: (): void => undefined },
      oms,
      gate: new RiskGate(market, risk),
      gateContext,
      ids,
      market,
      markPrice: () => 14_900,
      clock,
      journal: cap.sink,
    });
    const rc = new Reconciler({ oms, adapter: paper, kill, journal: cap.sink });
    expect(rc.reconcile().state).toBe('GREEN');

    // Broker book gains a lot the OMS never saw — a real position mismatch.
    paper.setPositionQty(CE, { ...mkPosition(2 * LOT), positionId: 'paper-CE1' as Position['positionId'] });
    const red = rc.reconcile();
    expect(red.state).toBe('RED');

    await new Promise<void>((r) => setImmediate(r)); // let the async trip settle
    expect(kill.state()).toBe('LOCKED');
    expect(kill.lastTripReason()).toBe('RECON_MISMATCH');
    expect(cap.events.some((e) => e.type === 'kill.tripped')).toBe(true);
  });
});
