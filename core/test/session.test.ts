/**
 * M9b step 2 acceptance: session lifecycle — preflight checklist (gates ARM),
 * operator ACK (ACK_PREFLIGHT), the wall-clock phase machine, and the hard
 * square-off (reuses the shared flatten helper, purpose SQUARE_OFF, and must
 * NOT lock the session — only a kill locks).
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, type MarketProfile, type RiskProfile } from '../src/config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type ClientOrderId } from '../src/domain/ids.js';
import type { Order, OrderIntent } from '../src/domain/orders.js';
import type { Position } from '../src/domain/positions.js';
import type { RiskVerdict } from '../src/domain/risk.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import type { CommandHandler, CommandResult } from '../src/gateway/gateway.js';
import type { Gateway } from '../src/gateway/gateway.js';
import { registerRunnerCommands, registerSessionCommands } from '../src/gateway/commands.js';
import { KillSwitch } from '../src/killswitch/kill-switch.js';
import type { FlattenOmsPort, FlattenPorts } from '../src/oms/flatten.js';
import { Oms, type SubmitResult } from '../src/oms/oms.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import { SessionManager, type PreflightProbes } from '../src/session/session.js';
import type { StrategyLifecycle, StrategyParams } from '../src/strategy/types.js';
import type { WeeklyChainResult } from '../src/marketdata/instrument-master.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(MarketProfileSchema, fileURLToPath(new URL('market/india-nse-options.json', configDir))).value;
const risk: RiskProfile = loadConfig(RiskProfileSchema, fileURLToPath(new URL('risk/paper-default.json', configDir))).value;

const SESSION = makeSessionId('2026-07-03', 'paper');
const CE = makeInstrumentId('NSE', 'CE1');
const LOT = market.contract.lotSize;

/** Epoch ms whose IST wall time is hh:mm on 2026-07-03 (IST = UTC+5:30). */
function ist(hh: number, mm: number): number {
  return Date.UTC(2026, 6, 3, hh, mm) - 330 * 60_000;
}

const CHAIN: WeeklyChainResult = { expiryDate: '2026-07-07', chain: new Map(), lotSize: LOT, tickSizePaise: 5, rowCount: 128 };

// ---------------------------------------------------------------- fixtures

interface Captured {
  events: Array<{ type: JournalEventType; payload: unknown }>;
  sink: <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;
}
function capture(): Captured {
  const events: Captured['events'] = [];
  return { events, sink: (type, payload) => events.push({ type, payload }) };
}

function goodProbes(clock: ManualClock, overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    resolveChain: () => CHAIN,
    lastTickTs: () => clock.now() - 1_000,
    feedStaleMs: 5_000,
    killSelfTest: () => ({ ok: true, checks: [{ name: 'kill.dry', ok: true }] }),
    journalReady: () => Promise.resolve(),
    configs: [
      { name: 'market', hash: 'a'.repeat(64), path: 'config/market/india-nse-options.json' },
      { name: 'risk', hash: 'b'.repeat(64), path: 'config/risk/paper-default.json' },
      { name: 'strategy', hash: 'c'.repeat(64), path: 'config/strategy/s1-momentum-burst.json' },
    ],
    ...overrides,
  };
}

function mkPosition(): Position {
  return {
    positionId: 'pos-so-1' as Position['positionId'],
    sessionId: SESSION,
    strategyId: 's1',
    instrumentId: CE,
    side: 'BUY',
    qty: LOT,
    avgEntryPricePaise: 15_000,
    state: 'OPEN',
    realizedGrossPaise: 0,
    openedTs: 1_000,
    updatedTs: 1_000,
  };
}

/** In-memory OMS surface capturing submitted flatten intents. */
class FakeExecPort implements FlattenOmsPort {
  orders: Order[] = [];
  positions: Position[] = [];
  submitted: OrderIntent[] = [];
  getOrders(): Order[] {
    return this.orders;
  }
  getPositions(): Position[] {
    return this.positions;
  }
  async cancel(): Promise<void> {
    /* nothing working in these fixtures */
  }
  async submit(intent: OrderIntent): Promise<SubmitResult> {
    this.submitted.push(intent);
    this.positions = this.positions.filter((p) => p.instrumentId !== intent.instrumentId);
    return {
      order: { ...(mkOrderShell()), intentId: intent.intentId, purpose: intent.purpose, state: 'FILLED' },
      accepted: true,
    };
  }
}
function mkOrderShell(): Order {
  return {
    clientOrderId: 'ord-so' as ClientOrderId,
    intentId: 'int-so' as Order['intentId'],
    sessionId: SESSION,
    instrumentId: CE,
    side: 'SELL',
    qty: LOT,
    filledQty: LOT,
    avgFillPricePaise: 14_900,
    type: 'LIMIT',
    limitPricePaise: 14_875,
    state: 'FILLED',
    purpose: 'SQUARE_OFF',
    tag: 'squareoff',
    createdTs: 1,
    updatedTs: 1,
  };
}

function flattenPortsFor(port: FlattenOmsPort, clock: ManualClock, cap: Captured): FlattenPorts {
  return {
    sessionId: SESSION,
    oms: port,
    gate: new RiskGate(market, risk),
    gateContext: (): RiskGateContext => ({
      nowMs: clock.now(),
      nowHHMM: '15:12',
      allowedInstruments: new Set([CE]),
      optionRows: new Map(),
      openPositions: port.getPositions(),
      session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
    }),
    ids: new IdFactory(SESSION),
    market,
    markPrice: () => 14_900,
    clock,
    journal: cap.sink,
    protectTicks: 5,
  };
}

function buildSession(clock: ManualClock, cap: Captured, port: FlattenOmsPort, probes: PreflightProbes): {
  session: SessionManager;
  target: { disarmed: number; disarm(): void };
} {
  const target = {
    disarmed: 0,
    disarm(): void {
      target.disarmed++;
    },
  };
  const session = new SessionManager({
    sessionId: SESSION,
    mode: 'paper',
    date: '2026-07-03',
    market,
    target,
    flattenPorts: () => flattenPortsFor(port, clock, cap),
    preflight: probes,
    clock,
    journal: cap.sink,
  });
  return { session, target };
}

/** Minimal Gateway stand-in capturing command handlers. */
class FakeGateway {
  readonly handlers = new Map<string, CommandHandler>();
  onCommand(type: string, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }
  async invoke(type: string, payload: Record<string, unknown> = {}): Promise<CommandResult> {
    const h = this.handlers.get(type);
    if (h === undefined) return { accepted: false, reason: 'UNKNOWN_COMMAND' };
    return h(payload);
  }
}

// ---------------------------------------------------------------- preflight

describe('preflight checklist', () => {
  it('all probes pass → technicalOk, every check named + journaled', async () => {
    const clock = new ManualClock(ist(10, 0));
    const cap = capture();
    const { session } = buildSession(clock, cap, new FakeExecPort(), goodProbes(clock));

    const result = await session.runPreflight();
    expect(result.ok).toBe(true);
    const names = result.checks.map((c) => c.name);
    expect(names).toEqual([
      'instrument.master',
      'feed.fresh',
      'config.loaded:market',
      'config.loaded:risk',
      'config.loaded:strategy',
      'kill.selftest',
      'journal.writable',
    ]);
    expect(result.checks.every((c) => c.ok)).toBe(true);

    // session.started once, config.loaded ×3, one session.preflight.
    const types = cap.events.map((e) => e.type);
    expect(types.filter((t) => t === 'session.started').length).toBe(1);
    expect(types.filter((t) => t === 'config.loaded').length).toBe(3);
    const pf = cap.events.find((e) => e.type === 'session.preflight')?.payload as { ok: boolean; checks: unknown[] };
    expect(pf.ok).toBe(true);
    expect(pf.checks.length).toBe(7);
  });

  it('any failing probe blocks the technical gate (feed stale, chain unresolved, kill selftest, disk)', async () => {
    const clock = new ManualClock(ist(10, 0));
    const cases: Array<[string, Partial<PreflightProbes>]> = [
      ['feed.fresh', { lastTickTs: () => clock.now() - 10_000 }],
      ['instrument.master', { resolveChain: () => undefined }],
      ['kill.selftest', { killSelfTest: () => ({ ok: false, checks: [{ name: 'gate', ok: false }] }) }],
      ['journal.writable', { journalReady: () => Promise.reject(new Error('ENOSPC')) }],
    ];
    for (const [failing, override] of cases) {
      const cap = capture();
      const { session } = buildSession(clock, cap, new FakeExecPort(), goodProbes(clock, override));
      const result = await session.runPreflight();
      expect(result.ok, failing).toBe(false);
      expect(result.checks.find((c) => c.name === failing)?.ok, failing).toBe(false);
      expect(session.canArm()).toMatchObject({ ok: false });
    }
  });
});

// ------------------------------------------------------------------- ACK/ARM

describe('operator ACK + ARM gating', () => {
  it('ACK refused before preflight and while failed; accepted once technical checks pass', async () => {
    const clock = new ManualClock(ist(10, 0));
    const cap = capture();
    const { session: bad } = buildSession(clock, cap, new FakeExecPort(), goodProbes(clock, { resolveChain: () => undefined }));
    expect(bad.acknowledge()).toMatchObject({ accepted: false, reason: 'PREFLIGHT_NOT_RUN' });
    await bad.runPreflight();
    expect(bad.acknowledge()).toMatchObject({ accepted: false, reason: 'PREFLIGHT_FAILED' });

    const { session } = buildSession(clock, cap, new FakeExecPort(), goodProbes(clock));
    await session.runPreflight();
    expect(session.acknowledge('operator-1')).toMatchObject({ accepted: true });
  });

  it('ARM refused until preflight passes, operator ACKs, and the session is OPEN', async () => {
    const clock = new ManualClock(ist(8, 0)); // before market open
    const cap = capture();
    const port = new FakeExecPort();
    const { session } = buildSession(clock, cap, port, goodProbes(clock, { lastTickTs: () => clock.now() - 500 }));

    let lifecycle: StrategyLifecycle = 'DISARMED';
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
    const gw = new FakeGateway();
    registerRunnerCommands(gw as unknown as Gateway, runner, { canArm: () => session.canArm() });
    registerSessionCommands(gw as unknown as Gateway, session);

    // Before preflight: refused.
    expect(await gw.invoke('ARM')).toMatchObject({ accepted: false, reason: 'PREFLIGHT_FAILED' });

    await session.runPreflight();
    expect(await gw.invoke('ARM')).toMatchObject({ accepted: false, reason: 'PREFLIGHT_NOT_ACKED' });

    // ACK before market open → acked, but still PREFLIGHT (not OPEN yet).
    expect(await gw.invoke('ACK_PREFLIGHT', { operator: 'op' })).toMatchObject({ accepted: true });
    expect(session.phase()).toBe('PREFLIGHT');
    expect(await gw.invoke('ARM')).toMatchObject({ accepted: false, reason: 'NOT_OPEN' });

    // Advance past open → onTimer promotes to OPEN → ARM works.
    clock.set(ist(9, 20));
    await session.onTimer(clock.now());
    expect(session.phase()).toBe('OPEN');
    expect(await gw.invoke('ARM')).toMatchObject({ accepted: true, reason: 'ARMED' });
  });
});

// ---------------------------------------------------------------- scheduler

describe('phase machine + square-off', () => {
  it('OPEN → ENTRY_CUTOFF → SQUARE_OFF → CLOSED on the wall clock; square-off flattens but does NOT lock', async () => {
    const clock = new ManualClock(ist(9, 20));
    const cap = capture();
    const port = new FakeExecPort();
    port.positions = [mkPosition()];
    const { session, target } = buildSession(clock, cap, port, goodProbes(clock));

    await session.runPreflight();
    session.acknowledge('op');
    await session.onTimer(clock.now());
    expect(session.phase()).toBe('OPEN');

    clock.set(ist(15, 1)); // past entry cutoff (15:00)
    await session.onTimer(clock.now());
    expect(session.phase()).toBe('ENTRY_CUTOFF');

    clock.set(ist(15, 13)); // past hard square-off (15:12)
    await session.onTimer(clock.now());
    expect(session.phase()).toBe('CLOSED');

    // Flatten happened via the shared helper under purpose SQUARE_OFF.
    expect(port.submitted.length).toBe(1);
    expect(port.submitted[0]).toMatchObject({ side: 'SELL', purpose: 'SQUARE_OFF' });
    expect(target.disarmed).toBeGreaterThanOrEqual(1);

    // Square-off is NOT a kill: no kill events, session.closed present.
    const types = cap.events.map((e) => e.type);
    expect(types).not.toContain('kill.tripped');
    expect(types).toContain('session.closed');
    expect(session.canArm()).toMatchObject({ ok: false, reason: 'SESSION_CLOSED' });
  });

  it('square-off is idempotent (a second onTimer does not re-flatten)', async () => {
    const clock = new ManualClock(ist(9, 20));
    const cap = capture();
    const port = new FakeExecPort();
    port.positions = [mkPosition()];
    const { session } = buildSession(clock, cap, port, goodProbes(clock));
    await session.runPreflight();
    session.acknowledge('op'); // opens at 09:20
    expect(session.phase()).toBe('OPEN');

    clock.set(ist(15, 13)); // past hard square-off
    await session.onTimer(clock.now());
    await session.onTimer(clock.now());
    expect(port.submitted.length).toBe(1);
    expect(session.phase()).toBe('CLOSED');
  });

  it('halt blocks ARM; onKill drives KILLED and back', async () => {
    const clock = new ManualClock(ist(10, 0));
    const cap = capture();
    const { session } = buildSession(clock, cap, new FakeExecPort(), goodProbes(clock));
    await session.runPreflight();
    session.acknowledge('op');
    await session.onTimer(clock.now());
    expect(session.phase()).toBe('OPEN');

    session.onKill('TRIPPED');
    expect(session.phase()).toBe('KILLED');
    expect(session.canArm()).toMatchObject({ ok: false, reason: 'KILL_LOCKED' });
    session.onKill('REARMED');
    expect(session.phase()).toBe('OPEN');

    session.halt('operator halt');
    expect(session.phase()).toBe('HALTED');
    expect(session.canArm()).toMatchObject({ ok: false, reason: 'SESSION_HALTED' });
  });
});

// -------------------------------------------------- integration: real OMS + kill

describe('integration: square-off a real position without locking the kill switch', () => {
  it('flattens the open position into a trade, closes the session, kill stays READY', async () => {
    const clock = new ManualClock(ist(9, 20));
    const ids = new IdFactory(SESSION);
    const paper = new PaperBroker({ clock });
    paper.setQuote(CE, { bidPaise: 14_900, askPaise: 15_000, ltpPaise: 15_000 });
    const cap = capture();
    const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: cap.sink });

    // Open a position honestly through the OMS.
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
    expect(oms.getPositions().filter((p) => p.state === 'OPEN').length).toBe(1);

    const gateContext = (): RiskGateContext => ({
      nowMs: clock.now(),
      nowHHMM: '15:12',
      allowedInstruments: new Set([CE]),
      optionRows: new Map(),
      openPositions: oms.getPositions(),
      session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
    });
    const target = { disarm: (): void => undefined };
    const kill = new KillSwitch({
      sessionId: SESSION,
      target,
      oms,
      gate: new RiskGate(market, risk),
      gateContext,
      ids,
      market,
      markPrice: () => 14_900,
      clock,
      journal: cap.sink,
    });

    const ports = (): FlattenPorts => ({
      sessionId: SESSION,
      oms,
      gate: new RiskGate(market, risk),
      gateContext,
      ids,
      market,
      markPrice: () => 14_900,
      clock,
      journal: cap.sink,
      protectTicks: 5,
    });
    const session = new SessionManager({
      sessionId: SESSION,
      mode: 'paper',
      date: '2026-07-03',
      market,
      target,
      flattenPorts: ports,
      preflight: goodProbes(clock, { killSelfTest: () => kill.selfTest() }),
      clock,
      journal: cap.sink,
    });

    await session.runPreflight();
    session.acknowledge('op'); // opens at 09:20
    expect(session.phase()).toBe('OPEN');

    clock.set(ist(15, 13));
    await session.onTimer(clock.now()); // 15:13 → square-off

    expect(session.phase()).toBe('CLOSED');
    expect(oms.getPositions().every((p) => p.state === 'CLOSED' || p.qty === 0)).toBe(true);
    expect(cap.events.some((e) => e.type === 'trade.completed')).toBe(true);
    // The kill switch was never involved — square-off does not lock.
    expect(kill.state()).toBe('READY');
    expect(kill.isLocked()).toBe(false);
  });
});
