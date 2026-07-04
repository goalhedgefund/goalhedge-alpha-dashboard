/**
 * M9a acceptance: kill switch — trip sequence (disarm → cancel → flatten →
 * lock), auto-trips, typed re-arm, self-test, gateway KILL/REARM commands,
 * and the reserved exit throttle lane.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import {
  MarketProfileSchema,
  RiskProfileSchema,
  type MarketProfile,
  type RiskProfile,
} from '../src/config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type ClientOrderId, type InstrumentId } from '../src/domain/ids.js';
import type { Order, OrderIntent } from '../src/domain/orders.js';
import type { Position } from '../src/domain/positions.js';
import type { RiskVerdict } from '../src/domain/risk.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { registerKillCommands, registerRunnerCommands } from '../src/gateway/commands.js';
import { Gateway } from '../src/gateway/gateway.js';
import type { GatewayState, ServerMsg } from '../src/gateway/protocol.js';
import { KillSwitch, type KillOmsPort } from '../src/killswitch/kill-switch.js';
import { Oms, type SubmitResult } from '../src/oms/oms.js';
import { TokenBucket } from '../src/oms/throttle.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import type { StrategyLifecycle, StrategyParams } from '../src/strategy/types.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(
  MarketProfileSchema,
  fileURLToPath(new URL('market/india-nse-options.json', configDir)),
).value;
const risk: RiskProfile = loadConfig(
  RiskProfileSchema,
  fileURLToPath(new URL('risk/paper-default.json', configDir)),
).value;
const SESSION = makeSessionId('2026-07-03', 'paper');
const CE = makeInstrumentId('NSE', 'CE1');
const LOT = market.contract.lotSize;

// ---------------------------------------------------------------- fixtures

function mkPosition(instrumentId: InstrumentId = CE, qty = LOT): Position {
  return {
    positionId: `pos-x-${instrumentId}` as Position['positionId'],
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

function mkOrder(state: Order['state'], id: string): Order {
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

class FakePort implements KillOmsPort {
  orders: Order[] = [];
  positions: Position[] = [];
  cancelled: ClientOrderId[] = [];
  submitted: OrderIntent[] = [];

  getOrders(): Order[] {
    return this.orders;
  }

  getPositions(): Position[] {
    return this.positions;
  }

  async cancel(id: ClientOrderId): Promise<void> {
    this.cancelled.push(id);
  }

  async submit(intent: OrderIntent, _verdict: RiskVerdict): Promise<SubmitResult> {
    this.submitted.push(intent);
    this.positions = this.positions.filter((p) => p.instrumentId !== intent.instrumentId);
    return { order: mkOrder('FILLED', 'ord-fill'), accepted: true };
  }
}

/** Adverse gate context: latched stop + blown spread — exits must still pass. */
function adverseCtx(port: KillOmsPort): () => RiskGateContext {
  return () => ({
    nowMs: 10_000,
    nowHHMM: '15:10',
    allowedInstruments: new Set([CE]),
    optionRows: new Map(),
    openPositions: port.getPositions(),
    session: {
      realizedNetPnlPaise: -9_999_999,
      peakNetPnlPaise: 0,
      lossStreak: 9,
      tradesTaken: 99,
      latchedStop: 'DAILY_LOSS',
    },
  });
}

interface Captured {
  events: Array<{ type: JournalEventType; payload: unknown }>;
  sink: <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;
}

function capture(): Captured {
  const events: Captured['events'] = [];
  return { events, sink: (type, payload) => events.push({ type, payload }) };
}

function buildKill(port: KillOmsPort, cap: Captured, overrides: Partial<ConstructorParameters<typeof KillSwitch>[0]> = {}): {
  kill: KillSwitch;
  target: { disarmed: number; disarm(): void };
} {
  const target = {
    disarmed: 0,
    disarm(): void {
      target.disarmed++;
    },
  };
  const kill = new KillSwitch({
    sessionId: SESSION,
    target,
    oms: port,
    gate: new RiskGate(market, risk),
    gateContext: adverseCtx(port),
    ids: new IdFactory(SESSION),
    market,
    markPrice: () => 14_900,
    clock: new ManualClock(50_000),
    journal: cap.sink,
    ...overrides,
  });
  return { kill, target };
}

// ---------------------------------------------------------------- unit

describe('trip sequence', () => {
  it('disarm → cancel non-terminal only → flatten via KILL exits → LOCKED, journaled', async () => {
    const port = new FakePort();
    port.orders = [mkOrder('FILLED', 'ord-1'), mkOrder('SENT', 'ord-2'), mkOrder('ACKED', 'ord-3')];
    port.positions = [mkPosition()];
    const cap = capture();
    const { kill, target } = buildKill(port, cap);

    const report = await kill.trip('MANUAL', 'operator');
    expect(report.alreadyTripped).toBe(false);
    expect(report.cancelledOrders).toBe(2); // SENT + ACKED, not FILLED
    expect(port.cancelled).toEqual(['ord-2', 'ord-3']);
    expect(report.flattenedPositions).toBe(1);
    expect(target.disarmed).toBe(1);
    expect(kill.state()).toBe('LOCKED');
    expect(kill.isLocked()).toBe(true);

    const exit = port.submitted[0];
    expect(exit).toMatchObject({
      side: 'SELL',
      purpose: 'KILL',
      qty: LOT,
      type: 'LIMIT',
      limitPricePaise: 14_900 - 5 * market.tickSizePaise, // mark − protectTicks
      tag: 'kill:operator',
    });

    const types = cap.events.map((e) => e.type);
    expect(types[0]).toBe('kill.tripped');
    expect(types).toContain('intent.proposed');
    expect(types).toContain('risk.verdict');
    expect(types[types.length - 1]).toBe('kill.completed');
  });

  it('flatten passes the gate under latched stop + blown spread (exit lane)', async () => {
    const port = new FakePort();
    port.positions = [mkPosition()];
    const cap = capture();
    const { kill } = buildKill(port, cap);
    const report = await kill.trip('AUTO', 'RECON_MISMATCH');
    expect(report.flattenedPositions).toBe(1);
    const verdicts = cap.events.filter((e) => e.type === 'risk.verdict');
    expect((verdicts[0]?.payload as { verdict: RiskVerdict }).verdict.approved).toBe(true);
  });

  it('no mark price → market exit (getting flat beats price)', async () => {
    const port = new FakePort();
    port.positions = [mkPosition()];
    const cap = capture();
    const { kill } = buildKill(port, cap, { markPrice: () => undefined });
    await kill.trip('MANUAL', 'x');
    expect(port.submitted[0]?.type).toBe('MARKET_PROTECT');
    expect(port.submitted[0]?.limitPricePaise).toBeUndefined();
  });

  it('is idempotent: second trip is a no-op with no duplicate journal', async () => {
    const port = new FakePort();
    const cap = capture();
    const { kill } = buildKill(port, cap);
    await kill.trip('MANUAL', 'first');
    const eventsAfterFirst = cap.events.length;
    const second = await kill.trip('MANUAL', 'second');
    expect(second.alreadyTripped).toBe(true);
    expect(second.reason).toBe('first');
    expect(cap.events.length).toBe(eventsAfterFirst);
  });
});

describe('re-arm discipline', () => {
  it('requires LOCKED state, the literal REARM confirmation, and a reason', async () => {
    const port = new FakePort();
    const cap = capture();
    const { kill } = buildKill(port, cap);

    expect(kill.rearm('REARM', 'why')).toMatchObject({ accepted: false, reason: 'NOT_LOCKED' });
    await kill.trip('MANUAL', 'x');
    expect(kill.rearm('rearm', 'why')).toMatchObject({ accepted: false, reason: 'CONFIRMATION_REQUIRED' });
    expect(kill.rearm('REARM', '   ')).toMatchObject({ accepted: false, reason: 'CONFIRMATION_REQUIRED' });
    expect(kill.isLocked()).toBe(true);

    expect(kill.rearm('REARM', 'root cause: fixed feed').accepted).toBe(true);
    expect(kill.state()).toBe('READY');
    expect(cap.events.some((e) => e.type === 'kill.rearmed')).toBe(true);

    // Can trip again after re-arm.
    const again = await kill.trip('MANUAL', 'y');
    expect(again.alreadyTripped).toBe(false);
  });
});

describe('auto trips', () => {
  it('reject storm: N rejects inside the window trip; fewer do not; old rejects expire', async () => {
    const port = new FakePort();
    const cap = capture();
    const { kill } = buildKill(port, cap, { rejectStormCount: 3, rejectStormWindowMs: 1_000 });

    kill.noteReject(1_000);
    kill.noteReject(1_100);
    expect(kill.state()).toBe('READY');
    kill.noteReject(1_200); // 3 within 1s → trip
    await new Promise<void>((r) => setImmediate(r)); // trip() awaits helpers; flush fully
    expect(kill.state()).toBe('LOCKED');
    expect(cap.events.find((e) => e.type === 'kill.tripped')?.payload).toMatchObject({
      source: 'AUTO',
      reason: 'REJECT_STORM',
    });

    // Window slide: rebuilt switch, spaced rejects never accumulate.
    const cap2 = capture();
    const { kill: kill2 } = buildKill(new FakePort(), cap2, { rejectStormCount: 3, rejectStormWindowMs: 1_000 });
    kill2.noteReject(1_000);
    kill2.noteReject(3_000);
    kill2.noteReject(5_000);
    expect(kill2.state()).toBe('READY');
  });

  it('feed staleness trips ONLY while positioned', async () => {
    const flat = new FakePort();
    const capFlat = capture();
    const { kill: killFlat } = buildKill(flat, capFlat);
    killFlat.noteTick(10_000);
    expect(killFlat.checkFeedStale(20_000)).toBe(false); // stale but FLAT → no trip
    expect(killFlat.state()).toBe('READY');

    const positioned = new FakePort();
    positioned.positions = [mkPosition()];
    const capPos = capture();
    const { kill: killPos } = buildKill(positioned, capPos);
    killPos.noteTick(10_000);
    expect(killPos.checkFeedStale(12_000)).toBe(false); // fresh → no trip
    expect(killPos.checkFeedStale(20_000)).toBe(true); // stale + positioned → trip
    await new Promise<void>((r) => setImmediate(r)); // trip() awaits helpers; flush fully
    expect(killPos.state()).toBe('LOCKED');
  });
});

describe('self-test', () => {
  it('passes on healthy wiring; fails with an empty whitelist', () => {
    const port = new FakePort();
    const { kill } = buildKill(port, capture());
    const healthy = kill.selfTest();
    expect(healthy.ok).toBe(true);
    expect(healthy.checks.every((c) => c.ok)).toBe(true);

    const { kill: broken } = buildKill(port, capture(), {
      gateContext: () => ({
        nowMs: 1,
        nowHHMM: '10:00',
        allowedInstruments: new Set<InstrumentId>(),
        optionRows: new Map(),
        openPositions: [],
        session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
      }),
    });
    const result = broken.selfTest();
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'gate.approves.kill.exit')?.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- integration

describe('integration: real OMS + PaperBroker', () => {
  it('trip flattens a real position into a completed trade and locks', async () => {
    const clock = new ManualClock(Date.UTC(2026, 6, 3, 4, 30));
    const ids = new IdFactory(SESSION);
    const paper = new PaperBroker({ clock });
    paper.setQuote(CE, { bidPaise: 14_900, askPaise: 15_000, ltpPaise: 15_000 });
    const cap = capture();
    const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: cap.sink });

    // Open a position the honest way: approved ENTRY through the OMS.
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
    const verdict: RiskVerdict = { intentId: entry.intentId, ts: clock.now(), approved: true };
    await oms.submit(entry, verdict);
    expect(oms.getPositions().filter((p) => p.state === 'OPEN').length).toBe(1);

    const target = { disarm: (): void => undefined };
    const kill = new KillSwitch({
      sessionId: SESSION,
      target,
      oms,
      gate: new RiskGate(market, risk),
      gateContext: () => ({
        nowMs: clock.now(),
        nowHHMM: '10:05',
        allowedInstruments: new Set([CE]),
        optionRows: new Map(),
        openPositions: oms.getPositions(),
        session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
      }),
      ids,
      market,
      markPrice: () => 14_900,
      clock,
      journal: cap.sink,
    });

    const report = await kill.trip('MANUAL', 'drill');
    expect(report.flattenedPositions).toBe(1);
    expect(kill.state()).toBe('LOCKED');
    expect(oms.getPositions().every((p) => p.state === 'CLOSED' || p.qty === 0)).toBe(true);
    expect(cap.events.some((e) => e.type === 'trade.completed')).toBe(true);
  });
});

// ---------------------------------------------------------------- gateway

describe('gateway KILL/REARM commands + ARM lock', () => {
  const gateways: Gateway[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    for (const g of gateways.splice(0)) await g.close();
  });

  function initialState(): GatewayState {
    return {
      session: { sessionId: SESSION, mode: 'paper', phase: 'OPEN', date: '2026-07-03' },
      kill: { state: 'READY' },
      health: { feedStatus: 'CONNECTED', lastTickTs: 0, gatewayTs: 0 },
      algo: { strategyId: 's1', lifecycle: 'ARMED', params: {} },
      risk: {
        snapshot: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
        limits: { dailyMaxLossPaise: 1, perTradeRiskPaise: 1, maxTradesPerDay: 1, maxConcurrentPositions: 1 },
      },
      positions: [],
      orders: [],
      trades: [],
      chain: [],
      bars: [],
      events: [],
    };
  }

  it('KILL → LOCKED; ARM refused while locked; REARM (typed) unlocks; ARM works again', async () => {
    const port = new FakePort();
    port.positions = [mkPosition()];
    const cap = capture();
    const { kill } = buildKill(port, cap);

    let lifecycle: StrategyLifecycle = 'ARMED';
    const runner = {
      arm: (): void => {
        lifecycle = 'ARMED';
      },
      disarm: (): void => {
        lifecycle = 'DISARMED';
      },
      setParams: (_p: StrategyParams): void => undefined,
      state: (): StrategyLifecycle => lifecycle,
    };

    const g = new Gateway({ port: 0, initialState: initialState(), flushMs: 60_000, heartbeatMs: 60_000 });
    gateways.push(g);
    registerRunnerCommands(g, runner, { isLocked: () => kill.isLocked() });
    registerKillCommands(g, kill);
    await g.ready();

    const ws = new WebSocket(`ws://127.0.0.1:${g.port()}`);
    sockets.push(ws);
    const acks: Array<{ commandId: string; accepted: boolean; reason?: string }> = [];
    const waitAck = async (id: string): Promise<{ accepted: boolean; reason?: string }> => {
      const deadline = Date.now() + 3_000;
      for (;;) {
        const hit = acks.find((a) => a.commandId === id);
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) throw new Error(`no ack for ${id}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      if (msg.kind === 'ack') acks.push(msg);
    });
    await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve()));

    const send = (commandId: string, type: string, payload?: Record<string, unknown>): void => {
      ws.send(JSON.stringify({ kind: 'command', commandId, type, ...(payload ? { payload } : {}) }));
    };

    send('k1', 'KILL', { reason: 'ui drill' });
    expect(await waitAck('k1')).toMatchObject({ accepted: true, reason: 'LOCKED' });
    expect(kill.state()).toBe('LOCKED');
    expect(port.submitted.length).toBe(1); // flattened

    send('a1', 'ARM');
    expect(await waitAck('a1')).toMatchObject({ accepted: false, reason: 'KILL_LOCKED' });

    send('r1', 'REARM', { confirm: 'nope', reason: 'x' });
    expect(await waitAck('r1')).toMatchObject({ accepted: false, reason: 'CONFIRMATION_REQUIRED' });

    send('r2', 'REARM', { confirm: 'REARM', reason: 'drill complete' });
    expect(await waitAck('r2')).toMatchObject({ accepted: true });
    expect(kill.state()).toBe('READY');

    send('a2', 'ARM');
    expect(await waitAck('a2')).toMatchObject({ accepted: true, reason: 'ARMED' });
  });
});

// ---------------------------------------------------------------- exit lane

describe('reserved exit throttle lane', () => {
  it('a STOP exit is never starved by entries draining the main bucket', async () => {
    const clock = new ManualClock(1_000);
    const ids = new IdFactory(SESSION);
    const paper = new PaperBroker({ clock });
    paper.setQuote(CE, { bidPaise: 14_900, askPaise: 15_000, ltpPaise: 15_000 });
    const oms = new Oms({
      sessionId: SESSION,
      adapter: paper,
      marketProfile: market,
      clock,
      ids,
      throttle: new TokenBucket({ capacity: 1, refillPerSec: 0, clock }),
      exitThrottle: new TokenBucket({ capacity: 5, refillPerSec: 0, clock }),
    });

    const intent = (purpose: OrderIntent['purpose'], side: OrderIntent['side']): OrderIntent => ({
      intentId: ids.intentId(),
      sessionId: SESSION,
      strategyId: 's1',
      ts: clock.now(),
      side,
      instrumentId: CE,
      qty: LOT,
      type: 'LIMIT',
      limitPricePaise: side === 'BUY' ? 15_000 : 14_900,
      ttlMs: 1_000,
      tag: `s1:${purpose.toLowerCase()}`,
      purpose,
      ...(purpose === 'ENTRY' ? { stopPlan: { hardStopPremiumPaise: 11_250, timeStopSec: 90 } } : {}),
    });
    const ok = (i: OrderIntent): RiskVerdict => ({ intentId: i.intentId, ts: clock.now(), approved: true });

    // Entry 1 drains the main bucket; entry 2 is throttled.
    const e1 = intent('ENTRY', 'BUY');
    expect((await oms.submit(e1, ok(e1))).accepted).toBe(true);
    const e2 = intent('ENTRY', 'BUY');
    const r2 = await oms.submit(e2, ok(e2));
    expect(r2).toMatchObject({ accepted: false, reason: 'THROTTLED' });

    // The stop exit still goes straight through on the reserved lane.
    const stop = intent('STOP', 'SELL');
    expect((await oms.submit(stop, ok(stop))).accepted).toBe(true);
  });
});
