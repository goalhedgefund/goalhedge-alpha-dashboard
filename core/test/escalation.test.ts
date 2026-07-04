/**
 * M9b step 1 acceptance: exit escalation ladder (PROTECT → REPRICE → MARKET)
 * and its integration with the kill switch's shared flatten path.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import {
  MarketProfileSchema,
  RiskProfileSchema,
  type MarketProfile,
  type RiskProfile,
} from '../src/config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';
import type { OrderIntent } from '../src/domain/orders.js';
import type { RiskVerdict } from '../src/domain/risk.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { KillSwitch } from '../src/killswitch/kill-switch.js';
import { ExitEscalator } from '../src/oms/escalation.js';
import { Oms } from '../src/oms/oms.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';

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
const TICK = market.tickSizePaise;

interface Harness {
  clock: ManualClock;
  ids: IdFactory;
  paper: PaperBroker;
  oms: Oms;
  gate: RiskGate;
  esc: ExitEscalator;
  events: Array<{ type: JournalEventType; payload: unknown }>;
  gateCtx: () => RiskGateContext;
  openPosition: (qty?: number) => Promise<void>;
  submitStopExit: (qty?: number, limit?: number) => Promise<OrderIntent>;
}

function build(overrides: { stageTimeoutMs?: number; latchedSession?: boolean } = {}): Harness {
  const clock = new ManualClock(Date.UTC(2026, 6, 3, 4, 30)); // 10:00 IST
  const ids = new IdFactory(SESSION);
  const paper = new PaperBroker({ clock });
  paper.setQuote(CE, { bidPaise: 14_900, askPaise: 15_000, ltpPaise: 15_000 });
  const events: Harness['events'] = [];
  const sink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void => {
    events.push({ type, payload });
  };
  const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: sink });
  const gate = new RiskGate(market, risk);
  const gateCtx = (): RiskGateContext => ({
    nowMs: clock.now(),
    nowHHMM: '10:05',
    allowedInstruments: new Set([CE]),
    optionRows: new Map(),
    openPositions: oms.getPositions(),
    session: overrides.latchedSession === true
      ? { realizedNetPnlPaise: -9_999_999, peakNetPnlPaise: 0, lossStreak: 9, tradesTaken: 99, latchedStop: 'DAILY_LOSS' }
      : { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
  });
  const esc = new ExitEscalator({
    oms,
    gate,
    gateContext: gateCtx,
    ids,
    market,
    markPrice: () => 14_900,
    clock,
    journal: sink,
    stageTimeoutMs: overrides.stageTimeoutMs ?? 750,
    repriceTicks: 10,
  });

  const openPosition = async (qty = LOT): Promise<void> => {
    const entry: OrderIntent = {
      intentId: ids.intentId(),
      sessionId: SESSION,
      strategyId: 's1',
      ts: clock.now(),
      side: 'BUY',
      instrumentId: CE,
      qty,
      type: 'LIMIT',
      limitPricePaise: 15_000,
      ttlMs: 1_500,
      tag: 's1:entry',
      purpose: 'ENTRY',
      stopPlan: { hardStopPremiumPaise: 11_250, timeStopSec: 90 },
    };
    const ok: RiskVerdict = { intentId: entry.intentId, ts: clock.now(), approved: true };
    await oms.submit(entry, ok);
  };

  const submitStopExit = async (qty = LOT, limit = 14_885): Promise<OrderIntent> => {
    const intent: OrderIntent = {
      intentId: ids.intentId(),
      sessionId: SESSION,
      strategyId: 's1',
      ts: clock.now(),
      side: 'SELL',
      instrumentId: CE,
      qty,
      type: 'LIMIT',
      limitPricePaise: limit,
      protectTicks: 3,
      ttlMs: 500,
      tag: 's1:stop:L1_HARD_PREMIUM',
      purpose: 'STOP',
    };
    const verdict = gate.evaluate(intent, gateCtx());
    expect(verdict.approved).toBe(true);
    const result = await oms.submit(intent, verdict);
    expect(result.accepted).toBe(true);
    esc.track(result.order, intent);
    return intent;
  };

  return { clock, ids, paper, oms, gate, esc, events, gateCtx, openPosition, submitStopExit };
}

function escalations(h: Harness): Array<{ stage: string; remainingQty: number }> {
  return h.events
    .filter((e) => e.type === 'exit.escalated')
    .map((e) => e.payload as { stage: string; remainingQty: number });
}

describe('escalation ladder', () => {
  it('unfilled protect-limit → REPRICE at a worse limit, old order cancelled', async () => {
    const h = build();
    await h.openPosition();
    h.paper.holdFills(CE, 1); // stop exit rests ACKED
    await h.submitStopExit();
    expect(h.esc.trackedCount()).toBe(1);

    // Before the stage timeout: nothing happens.
    h.clock.advance(500);
    await h.esc.poll();
    expect(escalations(h).length).toBe(0);

    // Past the timeout: cancel + chase.
    h.clock.advance(300);
    await h.esc.poll();
    const esc1 = escalations(h);
    expect(esc1.length).toBe(1);
    expect(esc1[0]).toMatchObject({ stage: 'REPRICE', remainingQty: LOT });

    const orders = h.oms.getOrders().filter((o) => o.side === 'SELL');
    expect(orders.length).toBe(2);
    const [first, second] = orders;
    expect(first?.state).toBe('CANCELLED');
    // Worse limit: mark 14900 − 10 ticks. The chase FILLED instantly (hold
    // was consumed by the first order), closing the position at the bid.
    expect(second?.limitPricePaise).toBe(14_900 - 10 * TICK);
    expect(second?.state).toBe('FILLED');
    expect(second?.tag).toContain('esc-reprice');
    expect(h.oms.getPositions().every((p) => p.state === 'CLOSED' || p.qty === 0)).toBe(true);
    expect(h.events.some((e) => e.type === 'trade.completed')).toBe(true);
  });

  it('still unfilled after REPRICE → pure MARKET, position flat', async () => {
    const h = build();
    await h.openPosition();
    h.paper.holdFills(CE, 2); // protect AND reprice both rest unfilled
    await h.submitStopExit();

    h.clock.advance(800);
    await h.esc.poll(); // → REPRICE (held)
    h.clock.advance(800);
    await h.esc.poll(); // → MARKET (fills)

    const stages = escalations(h).map((e) => e.stage);
    expect(stages).toEqual(['REPRICE', 'MARKET']);
    const marketOrder = h.oms.getOrders().find((o) => o.type === 'MARKET');
    expect(marketOrder?.state).toBe('FILLED');
    expect(marketOrder?.tag).toContain('esc-market');
    expect(h.oms.getPositions().every((p) => p.state === 'CLOSED' || p.qty === 0)).toBe(true);
    await h.esc.poll(); // next cadence observes the fill and drops tracking
    expect(h.esc.trackedCount()).toBe(0);
  });

  it('a filled exit is dropped from tracking — no chase, no duplicate orders', async () => {
    const h = build();
    await h.openPosition();
    await h.submitStopExit(); // no hold → fills instantly
    h.clock.advance(2_000);
    await h.esc.poll();
    expect(escalations(h).length).toBe(0);
    expect(h.esc.trackedCount()).toBe(0);
    expect(h.oms.getOrders().filter((o) => o.side === 'SELL').length).toBe(1);
  });

  it('partial fill: only the REMAINING quantity is chased', async () => {
    const h = build();
    await h.openPosition(2 * LOT);
    h.paper.partialFillNext(LOT); // stop exit fills half, then rests PARTIAL
    await h.submitStopExit(2 * LOT);

    h.clock.advance(800);
    await h.esc.poll();
    const esc1 = escalations(h);
    expect(esc1.length).toBe(1);
    expect(esc1[0]).toMatchObject({ stage: 'REPRICE', remainingQty: LOT });
    const chase = h.oms.getOrders().find((o) => o.tag.includes('esc-reprice'));
    expect(chase?.qty).toBe(LOT);
    expect(h.oms.getPositions().every((p) => p.state === 'CLOSED' || p.qty === 0)).toBe(true);
  });

  it('escalated exits pass the gate under a latched session stop (exit lane)', async () => {
    const h = build({ latchedSession: true });
    await h.openPosition();
    h.paper.holdFills(CE, 1);
    await h.submitStopExit();
    h.clock.advance(800);
    await h.esc.poll();
    const verdicts = h.events.filter((e) => e.type === 'risk.verdict').map((e) => (e.payload as { verdict: RiskVerdict }).verdict);
    // The escalated exit's verdict is approved despite the latch (exit lane).
    expect(verdicts.length).toBeGreaterThanOrEqual(1);
    expect(verdicts.every((v) => v.approved)).toBe(true);
    expect(escalations(h).length).toBe(1);
  });

  it('entries are never escalated by design', async () => {
    const h = build();
    h.paper.holdFills(CE, 1);
    const entry: OrderIntent = {
      intentId: h.ids.intentId(),
      sessionId: SESSION,
      strategyId: 's1',
      ts: h.clock.now(),
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
    const ok: RiskVerdict = { intentId: entry.intentId, ts: h.clock.now(), approved: true };
    const result = await h.oms.submit(entry, ok);
    h.esc.track(result.order, entry); // must be a no-op
    expect(h.esc.trackedCount()).toBe(0);
    h.clock.advance(5_000);
    await h.esc.poll();
    expect(escalations(h).length).toBe(0);
  });

  it('kill switch flatten rides the ladder: held kill exit escalates to flat', async () => {
    const h = build();
    await h.openPosition();
    h.paper.holdFills(CE, 1); // the kill's protect-limit exit will rest

    const kill = new KillSwitch({
      sessionId: SESSION,
      target: { disarm: () => undefined },
      oms: h.oms,
      gate: h.gate,
      gateContext: h.gateCtx,
      ids: h.ids,
      market,
      markPrice: () => 14_900,
      clock: h.clock,
      journal: (type, payload) => h.events.push({ type, payload }),
      escalator: h.esc,
    });

    const report = await kill.trip('MANUAL', 'drill');
    expect(report.flattenedPositions).toBe(1); // submitted, but resting unfilled
    expect(h.esc.trackedCount()).toBe(1); // tracked via shared flatten path

    h.clock.advance(800);
    await h.esc.poll(); // REPRICE chase fills (hold consumed)
    expect(escalations(h).map((e) => e.stage)).toEqual(['REPRICE']);
    expect(h.oms.getPositions().every((p) => p.state === 'CLOSED' || p.qty === 0)).toBe(true);
    expect(kill.state()).toBe('LOCKED');
  });
});
