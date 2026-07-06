/**
 * M9b step 6 — the "angry desk" chaos / fault-injection suite (03-TESTING-PLAN
 * §4). Each scenario is scripted, deterministic (ManualClock + 0-latency paper
 * fills), and asserts a SPECIFIC defensive behavior:
 *   - feed freeze while positioned      → FEED_STALE kill → flat + locked
 *   - reject storm                      → REJECT_STORM kill
 *   - main-loop stall                   → WATCHDOG kill
 *   - clock skew                        → CLOCK_SKEW kill (and NOT plain staleness)
 *   - reconciliation mismatch (RED)     → RECON_MISMATCH kill
 *   - crash mid-position + restart      → journal replay rebuilds the exact book
 *   - journal disk-full (latched)       → new entries refused, protection intact
 *
 * Duplicate / out-of-order / fill-after-cancel acks are covered in oms.test.ts
 * (PaperBroker dedupes on brokerEventId; the OMS state machine is idempotent).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
import type { JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeSessionId } from '../src/domain/ids.js';
import type { OrderIntent } from '../src/domain/orders.js';
import type { Position } from '../src/domain/positions.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { JournalWriter } from '../src/journal/writer.js';
import { KillSwitch } from '../src/killswitch/kill-switch.js';
import { Oms } from '../src/oms/oms.js';
import { Reconciler } from '../src/oms/reconciler.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import { SessionRiskState } from '../src/risk/session-risk.js';
import { recoverFromJournal } from '../src/session/recovery.js';
import { StopEngine } from '../src/stops/stop-engine.js';
import { StrategyRunner, type MarketViewProvider } from '../src/strategy/runner.js';
import { S1MomentumBurst } from '../src/strategy/strategies/s1-momentum-burst.js';
import { ATM_STRIKE, CE_ID } from './helpers/strategy-fixtures.js';

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
const LOT = market.contract.lotSize;
const START = Date.UTC(2026, 6, 3, 4, 35, 0); // 10:05 IST — inside the session

// ---------------------------------------------------------------- helpers

interface Captured {
  events: Array<{ type: JournalEventType; payload: unknown }>;
  sink: <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;
}
function capture(): Captured {
  const events: Captured['events'] = [];
  return { events, sink: (type, payload) => events.push({ type, payload }) };
}

/** Let a `void this.trip(...)` (auto-trip) settle its awaited helpers. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

function benignCtx(oms: Oms, clock: ManualClock): () => RiskGateContext {
  return () => ({
    nowMs: clock.now(),
    nowHHMM: '10:05',
    allowedInstruments: new Set([CE_ID]),
    optionRows: new Map(),
    openPositions: oms.getPositions(),
    session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
  });
}

function entryIntent(ids: IdFactory, clock: ManualClock): OrderIntent {
  return {
    intentId: ids.intentId(),
    sessionId: SESSION,
    strategyId: 's1',
    ts: clock.now(),
    side: 'BUY',
    instrumentId: CE_ID,
    qty: LOT,
    type: 'LIMIT',
    limitPricePaise: 15_000,
    ttlMs: 1_500,
    tag: 's1:entry',
    purpose: 'ENTRY',
    stopPlan: { hardStopPremiumPaise: 11_250, timeStopSec: 90 },
  };
}

interface Desk {
  clock: ManualClock;
  paper: PaperBroker;
  oms: Oms;
  kill: KillSwitch;
  cap: Captured;
  openPosition: () => Promise<void>;
}

function makeDesk(killOverrides: Partial<ConstructorParameters<typeof KillSwitch>[0]> = {}): Desk {
  const clock = new ManualClock(START);
  const ids = new IdFactory(SESSION);
  const paper = new PaperBroker({ clock });
  paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });
  const cap = capture();
  const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: cap.sink });
  const gate = new RiskGate(market, risk);
  const kill = new KillSwitch({
    sessionId: SESSION,
    target: { disarm: (): void => undefined },
    oms,
    gate,
    gateContext: benignCtx(oms, clock),
    ids,
    market,
    markPrice: () => 14_990,
    clock,
    journal: cap.sink,
    ...killOverrides,
  });
  return {
    clock,
    paper,
    oms,
    kill,
    cap,
    openPosition: async (): Promise<void> => {
      const intent = entryIntent(ids, clock);
      await oms.submit(intent, { intentId: intent.intentId, ts: clock.now(), approved: true });
    },
  };
}

// ---------------------------------------------------------- automatic trips

describe('chaos: automatic kill trips', () => {
  it('feed freeze while positioned → FEED_STALE trip → flat + locked', async () => {
    const desk = makeDesk({ feedStaleMs: 5_000 });
    await desk.openPosition();
    expect(desk.oms.getPositions().some((p) => p.state === 'OPEN' && p.qty > 0)).toBe(true);

    desk.kill.noteTick(desk.clock.now());
    desk.clock.advance(6_000); // ticks stop for > feedStaleMs
    expect(desk.kill.checkFeedStale(desk.clock.now())).toBe(true);
    await settle();

    expect(desk.kill.state()).toBe('LOCKED');
    expect(desk.kill.lastTripReason()).toBe('FEED_STALE');
    // The kill sequence flattened the position and locked trading.
    expect(desk.oms.getPositions().every((p) => p.state === 'CLOSED' || p.qty === 0)).toBe(true);
    expect(desk.cap.events.some((e) => e.type === 'trade.completed')).toBe(true);
  });

  it('feed freeze while FLAT does not trip (nothing to protect)', () => {
    const desk = makeDesk({ feedStaleMs: 5_000 });
    desk.kill.noteTick(desk.clock.now());
    desk.clock.advance(6_000);
    expect(desk.kill.checkFeedStale(desk.clock.now())).toBe(false);
    expect(desk.kill.state()).toBe('READY');
  });

  it('reject storm → REJECT_STORM trip', async () => {
    const desk = makeDesk({ rejectStormCount: 3, rejectStormWindowMs: 1_000 });
    desk.kill.noteReject(1_000);
    desk.kill.noteReject(1_500);
    expect(desk.kill.state()).toBe('READY'); // 2 in window
    desk.kill.noteReject(1_900); // 3rd within 1s
    await settle();
    expect(desk.kill.state()).toBe('LOCKED');
    expect(desk.kill.lastTripReason()).toBe('REJECT_STORM');
  });

  it('main-loop stall → WATCHDOG trip', async () => {
    const desk = makeDesk({ watchdogMs: 1_000 });
    desk.kill.petWatchdog(1_000);
    expect(desk.kill.checkWatchdog(1_800)).toBe(false); // within budget
    expect(desk.kill.checkWatchdog(2_500)).toBe(true); // > 1s since last pet
    await settle();
    expect(desk.kill.state()).toBe('LOCKED');
    expect(desk.kill.lastTripReason()).toBe('WATCHDOG');
  });

  it('an un-petted watchdog never trips (must be armed by a first pet)', () => {
    const desk = makeDesk({ watchdogMs: 1_000 });
    expect(desk.kill.checkWatchdog(10_000)).toBe(false);
    expect(desk.kill.state()).toBe('READY');
  });

  it('future-stamped ticks → CLOCK_SKEW trip; last-trade lag and plain staleness do not', async () => {
    // Positive lag, feed still fresh: local clock 2s ahead of the last-trade stamp.
    const a = makeDesk({ clockSkewMs: 1_000, feedStaleMs: 10_000 });
    a.kill.noteTick(10_000);
    expect(a.kill.checkClockSkew(10_500)).toBe(false); // 0.5s within tolerance
    expect(a.kill.checkClockSkew(12_000)).toBe(false); // 2s last-trade lag is not clock skew
    expect(a.kill.state()).toBe('READY');

    // Negative skew: a tick stamped 3s in the FUTURE relative to local time.
    const b = makeDesk({ clockSkewMs: 1_000, feedStaleMs: 10_000 });
    b.kill.noteTick(20_000);
    expect(b.kill.checkClockSkew(17_000)).toBe(true);
    await settle();
    expect(b.kill.state()).toBe('LOCKED');
    expect(b.kill.lastTripReason()).toBe('CLOCK_SKEW');

    // A large positive gap is feed staleness, not skew — not this trip's job.
    const c = makeDesk({ clockSkewMs: 1_000, feedStaleMs: 5_000 });
    c.kill.noteTick(0);
    expect(c.kill.checkClockSkew(9_000)).toBe(false);
    expect(c.kill.state()).toBe('READY');
  });
});

// ------------------------------------------------------------ reconciliation

describe('chaos: reconciliation mismatch', () => {
  it('an out-of-band broker fill reconciles RED and trips RECON_MISMATCH', async () => {
    const desk = makeDesk();
    await desk.openPosition();
    const recon = new Reconciler({
      oms: desk.oms,
      adapter: desk.paper,
      kill: desk.kill,
      clock: desk.clock,
      journal: desk.cap.sink,
    });
    // Clean to start: both books agree.
    expect(recon.reconcile().state).toBe('GREEN');

    // Inject a phantom broker position the OMS never saw (a fill we missed).
    const phantom: Position = {
      positionId: 'paper-phantom' as Position['positionId'],
      sessionId: SESSION,
      strategyId: 's1',
      instrumentId: CE_ID,
      side: 'BUY',
      qty: LOT * 2,
      avgEntryPricePaise: 15_000,
      state: 'OPEN',
      realizedGrossPaise: 0,
      openedTs: START,
      updatedTs: START,
    };
    desk.paper.setPositionQty(CE_ID, phantom);

    const result = recon.reconcile();
    expect(result.state).toBe('RED');
    expect(result.positionDiffs[0]).toMatchObject({ instrumentId: CE_ID, omsNet: LOT, brokerNet: LOT * 2 });
    await settle();

    expect(desk.kill.state()).toBe('LOCKED');
    expect(desk.kill.lastTripReason()).toBe('RECON_MISMATCH');
    // recon.result journaled the RED transition.
    const red = desk.cap.events.find(
      (e) => e.type === 'recon.result' && (e.payload as { ok: boolean }).ok === false,
    );
    expect(red).toBeDefined();
  });
});

// -------------------------------------------------------------- crash recovery

describe('chaos: crash mid-position + restart', () => {
  it('journal replay rebuilds the exact live book and resumes seq gap-free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scalper-chaos-recover-'));
    const clock = new ManualClock(START);
    const ids = new IdFactory(SESSION);
    const paper = new PaperBroker({ clock });
    paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });
    const writer = new JournalWriter({ dir, clock, fsync: 'always' });
    await writer.ready();

    const sink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void => {
      writer.append(type, payload);
    };
    const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: sink });

    // Open a position, then "crash": flush what's on disk but never close cleanly.
    const intent = entryIntent(ids, clock);
    await oms.submit(intent, { intentId: intent.intentId, ts: clock.now(), approved: true });
    const liveOrders = oms.getOrders();
    const livePositions = oms.getPositions();
    expect(livePositions.some((p) => p.state === 'OPEN')).toBe(true);
    await writer.flush();
    const crashSeq = writer.lastSeq();

    // Restart: rebuild from the journal on disk.
    const recovered = await recoverFromJournal(writer.path, { riskProfile: risk });
    expect(recovered.partialTail).toBe(false);
    expect(recovered.lastSeq).toBe(crashSeq);
    expect(recovered.orders).toEqual(liveOrders);
    expect(recovered.positions).toEqual(livePositions);

    // The resuming writer continues at lastSeq+1 with no gap.
    const resumed = new JournalWriter({ dir, clock, resume: { startSeq: recovered.lastSeq + 1 } });
    await resumed.ready();
    const next = resumed.append('diag.error', { where: 'chaos', message: 'post-recovery' });
    expect(next.seq).toBe(crashSeq + 1);
    await resumed.close();
  });
});

// -------------------------------------------------------------- journal health

describe('chaos: journal disk-full', () => {
  it('a latched journal-write failure flips healthy() and makes append throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scalper-chaos-diskfull-'));
    // A pre-existing file makes the exclusive ('ax') open reject — stands in
    // for any un-writable journal (disk full, permissions, bad mount).
    writeFileSync(join(dir, 'events.jsonl'), '{"seq":1}\n');
    const broken = new JournalWriter({ dir, clock: new ManualClock(START) });
    await expect(broken.ready()).rejects.toBeTruthy();
    expect(broken.healthy()).toBe(false);
    expect(() => broken.append('diag.error', { where: 'x', message: 'y' })).toThrow(/refusing to continue/);
  });

  it('runner refuses NEW entries while the journal is unhealthy (protection unaffected)', async () => {
    const clock = new ManualClock(START);
    const ids = new IdFactory(SESSION);
    const paper = new PaperBroker({ clock });
    paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });
    const cap = capture();
    const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: cap.sink });

    // View methods are never reached: the health guard short-circuits before
    // eligibility or the strategy is consulted.
    const view: MarketViewProvider = {
      strategyView: () => {
        throw new Error('strategyView should not be called when the journal is unhealthy');
      },
      allowedInstruments: () => new Set([CE_ID]),
      optionRows: () => new Map(),
      atmStrikePaise: () => ATM_STRIKE,
      spotPaise: () => 2_450_000,
    };

    let journalHealthy = true;
    const runner = new StrategyRunner({
      sessionId: SESSION,
      strategy: new S1MomentumBurst(),
      params: { impulsePct: 0.0008, confirmTicks: 2, lots: 1, ttlMs: 1500, tickSizePaise: 5, timeStopSec: 90, hardStopPremiumPct: 25, breakevenAtPct: 12, trailStepPct: 8, trailLockPct: 50 },
      market,
      gate: new RiskGate(market, risk),
      oms,
      stopEngine: new StopEngine({ ids, tickSizePaise: 5 }),
      sessionRisk: new SessionRiskState(risk),
      ids,
      clock,
      view,
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
      journal: cap.sink,
      journalHealthy: () => journalHealthy,
    });
    runner.arm();

    // Disk fills up: the journal latches unhealthy.
    journalHealthy = false;
    await runner.onUnderlyingTick(clock.now());

    // No order left the desk, and the refusal was journaled (not a silent drop).
    expect(oms.getOrders().length).toBe(0);
    expect(
      cap.events.some(
        (e) => e.type === 'strategy.noTrade' && (e.payload as { reason: string }).reason === 'JOURNAL_UNHEALTHY',
      ),
    ).toBe(true);
  });
});
