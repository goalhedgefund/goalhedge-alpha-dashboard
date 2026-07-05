import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MarketProfile } from '../src/config/schemas.js';
import { MarketProfileSchema } from '../src/config/schemas.js';
import { loadConfig } from '../src/config/loader.js';
import type { BrokerOrderEvent, IBrokerAdapter } from '../src/exec/adapter.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { TradesWriter } from '../src/exec/trades-writer.js';
import { IdFactory, makeInstrumentId, makeSessionId, type ClientOrderId } from '../src/domain/ids.js';
import { ORDER_STATES, type Order, type OrderIntent } from '../src/domain/orders.js';
import type { Position } from '../src/domain/positions.js';
import type { RiskVerdict } from '../src/domain/risk.js';
import { ManualClock } from '../src/domain/time.js';
import { Oms } from '../src/oms/oms.js';
import { canTransition, IllegalOrderTransitionError, transitionOrder } from '../src/oms/state-machine.js';
import { TokenBucket } from '../src/oms/throttle.js';

const configDir = new URL('../../config/', import.meta.url);
const profile: MarketProfile = loadConfig(
  MarketProfileSchema,
  fileURLToPath(new URL('market/india-nse-options.json', configDir)),
).value;
const SESSION = makeSessionId('2026-07-03', 'paper');
const INSTR = makeInstrumentId('NSE', '35022');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'scalper-m5-'));
}

function intent(ids: IdFactory, side: 'BUY' | 'SELL', qty = 65): OrderIntent {
  const base = {
    intentId: ids.intentId(),
    sessionId: SESSION,
    strategyId: 's1',
    ts: 1,
    side,
    instrumentId: INSTR,
    qty,
    type: 'LIMIT',
    limitPricePaise: side === 'BUY' ? 10_010 : 10_490,
    ttlMs: 1000,
    tag: side === 'BUY' ? 's1:entry' : 's1:exit',
    purpose: side === 'BUY' ? 'ENTRY' : 'EXIT',
  } as const;
  return side === 'BUY'
    ? { ...base, stopPlan: { hardStopPremiumPaise: 9000, timeStopSec: 60 } }
    : base;
}

function approved(intentId: OrderIntent['intentId']): RiskVerdict {
  return { intentId, ts: 1, approved: true, riskPaise: 1000 };
}

class SilentAdapter implements IBrokerAdapter {
  readonly adapterId = 'silent';
  orders: Order[] = [];
  cancelled: ClientOrderId[] = [];
  private handler: ((ev: BrokerOrderEvent) => void) | undefined;

  async placeOrder(order: Order): Promise<void> {
    this.orders.push(order);
  }

  async cancelOrder(id: ClientOrderId): Promise<void> {
    this.cancelled.push(id);
  }

  getOrders(): Order[] {
    return this.orders;
  }

  getPositions(): Position[] {
    return [];
  }

  onOrderEvent(cb: (ev: BrokerOrderEvent) => void): () => void {
    this.handler = cb;
    return () => {
      this.handler = undefined;
    };
  }

  emit(ev: BrokerOrderEvent): void {
    this.handler?.(ev);
  }
}

describe('OMS state machine', () => {
  it('allows legal transitions and rejects illegal ones', () => {
    const ids = new IdFactory(SESSION);
    const base: Order = {
      clientOrderId: ids.clientOrderId(),
      intentId: ids.intentId(),
      sessionId: SESSION,
      instrumentId: INSTR,
      side: 'BUY',
      qty: 65,
      filledQty: 0,
      avgFillPricePaise: 0,
      type: 'LIMIT',
      limitPricePaise: 10_000,
      state: 'DRAFT',
      purpose: 'ENTRY',
      tag: 's1:entry',
      createdTs: 1,
      updatedTs: 1,
    };
    const approvedOrder = transitionOrder(base, 'RISK_APPROVED', 2);
    expect(approvedOrder.state).toBe('RISK_APPROVED');
    expect(() => transitionOrder(base, 'SENT', 2)).toThrow(IllegalOrderTransitionError);
  });

  it('pins the full legal transition table', () => {
    const expected = new Map<string, readonly string[]>([
      ['DRAFT', ['RISK_APPROVED']],
      ['RISK_APPROVED', ['SENT', 'EXPIRED']],
      ['SENT', ['ACKED', 'PARTIAL', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']],
      ['ACKED', ['PARTIAL', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED']],
      ['PARTIAL', ['PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED']],
      ['FILLED', []],
      ['REJECTED', []],
      ['CANCELLED', []],
      ['EXPIRED', []],
    ]);

    for (const from of ORDER_STATES) {
      for (const to of ORDER_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected.get(from)?.includes(to) ?? false);
      }
    }
  });
});

describe('TokenBucket broker-limit windows', () => {
  it('enforces burst capacity and clamps refill at capacity', () => {
    const clock = new ManualClock(0);
    const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, clock });

    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
    clock.advance(10_000);
    expect(bucket.available()).toBe(3);
  });

  it('refills at the sustained rate without granting early tokens', () => {
    const clock = new ManualClock(0);
    const bucket = new TokenBucket({ capacity: 2, refillPerSec: 2, clock });

    expect(bucket.tryTake(2)).toBe(true);
    clock.advance(249);
    expect(bucket.tryTake()).toBe(false);
    clock.advance(251);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it('composes per-second, per-minute, and per-day windows by requiring all buckets', () => {
    const clock = new ManualClock(0);
    const perSecond = new TokenBucket({ capacity: 2, refillPerSec: 2, clock });
    const perMinute = new TokenBucket({ capacity: 3, refillPerSec: 3 / 60, clock });
    const perDay = new TokenBucket({ capacity: 4, refillPerSec: 0, clock });
    const takeAll = (): boolean => {
      if (perSecond.available() < 1 || perMinute.available() < 1 || perDay.available() < 1) return false;
      return perSecond.tryTake() && perMinute.tryTake() && perDay.tryTake();
    };

    expect([takeAll(), takeAll(), takeAll()]).toEqual([true, true, false]); // second window is exhausted
    clock.advance(1_000);
    expect(takeAll()).toBe(true); // second window refilled; minute/day still had room
    expect(takeAll()).toBe(false); // minute window is exhausted
    clock.advance(20_000);
    expect(takeAll()).toBe(true); // minute window refilled one token; day cap now exhausted
    clock.advance(86_400_000);
    expect(takeAll()).toBe(false); // day bucket has no refill in this scoped composition
  });
});

describe('PaperBroker conformance', () => {
  it('emits ack then fill at touch and exposes broker book', async () => {
    const ids = new IdFactory(SESSION);
    const broker = new PaperBroker({ clock: new ManualClock(10), slippageTicks: 1, tickSizePaise: 5 });
    broker.setQuote(INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
    const events: BrokerOrderEvent[] = [];
    broker.onOrderEvent((ev) => events.push(ev));
    const order: Order = {
      clientOrderId: ids.clientOrderId(),
      intentId: ids.intentId(),
      sessionId: SESSION,
      instrumentId: INSTR,
      side: 'BUY',
      qty: 65,
      filledQty: 0,
      avgFillPricePaise: 0,
      type: 'LIMIT',
      limitPricePaise: 10_020,
      state: 'SENT',
      purpose: 'ENTRY',
      tag: 's1:entry',
      createdTs: 10,
      updatedTs: 10,
    };
    await broker.placeOrder(order);
    expect(events.map((e) => e.type)).toEqual(['ACK', 'FILL']);
    expect(events[1]?.type === 'FILL' ? events[1].fill.pricePaise : 0).toBe(10_015);
    expect(broker.getPositions()).toHaveLength(1);
  });

  it('cancel emits a cancellation event', async () => {
    const ids = new IdFactory(SESSION);
    const broker = new PaperBroker({ clock: new ManualClock(1) });
    const events: BrokerOrderEvent[] = [];
    broker.onOrderEvent((ev) => events.push(ev));
    await broker.cancelOrder(ids.clientOrderId());
    expect(events[0]?.type).toBe('CANCELLED');
  });
});

describe('OMS + PaperBroker lifecycle', () => {
  it('runs entry and exit end-to-end with deterministic trades.jsonl', async () => {
    const run = async (): Promise<string> => {
      const dir = tempDir();
      const clock = new ManualClock(100);
      const ids = new IdFactory(SESSION);
      const broker = new PaperBroker({ clock });
      broker.setQuote(INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      const writer = new TradesWriter({ dir });
      const oms = new Oms({ sessionId: SESSION, adapter: broker, marketProfile: profile, clock, ids, tradesWriter: writer });

      const entry = intent(ids, 'BUY');
      await oms.submit(entry, approved(entry.intentId));
      expect(oms.getOrders()[0]?.state).toBe('FILLED');
      expect(oms.getPositions()[0]?.qty).toBe(65);

      clock.advance(1000);
      broker.setQuote(INSTR, { bidPaise: 10_500, askPaise: 10_510, ltpPaise: 10_505 });
      const exit = intent(ids, 'SELL');
      await oms.submit(exit, approved(exit.intentId));
      expect(oms.getPositions()).toHaveLength(0);
      await writer.close();
      return readFileSync(writer.path, 'utf8');
    };

    const a = await run();
    const b = await run();
    expect(a).toBe(b);
    expect(a).toContain('"kind":"trade"');
    expect(a).toContain('"netPnlPaise"');
  });

  it('handles partial fills', async () => {
    const ids = new IdFactory(SESSION);
    const broker = new PaperBroker({ clock: new ManualClock(1) });
    broker.setQuote(INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
    broker.partialFillNext(65);
    const oms = new Oms({ sessionId: SESSION, adapter: broker, marketProfile: profile, clock: new ManualClock(1), ids });
    const entry = intent(ids, 'BUY', 130);
    await oms.submit(entry, approved(entry.intentId));
    expect(oms.getOrders()[0]?.state).toBe('PARTIAL');
    expect(oms.getOrders()[0]?.filledQty).toBe(65);
    expect(oms.getPositions()[0]?.qty).toBe(65);
  });

  it('handles adapter rejects', async () => {
    const ids = new IdFactory(SESSION);
    const broker = new PaperBroker({ clock: new ManualClock(1) });
    broker.rejectNext('NO_MARGIN');
    const oms = new Oms({ sessionId: SESSION, adapter: broker, marketProfile: profile, clock: new ManualClock(1), ids });
    const entry = intent(ids, 'BUY');
    await oms.submit(entry, approved(entry.intentId));
    expect(oms.getOrders()[0]?.state).toBe('REJECTED');
    expect(oms.getOrders()[0]?.rejectReason).toBe('NO_MARGIN');
  });

  it('cancel-and-verify is triggered for unacked orders', async () => {
    const clock = new ManualClock(1);
    const ids = new IdFactory(SESSION);
    const adapter = new SilentAdapter();
    const oms = new Oms({ sessionId: SESSION, adapter, marketProfile: profile, clock, ids, unackedTimeoutMs: 50 });
    const entry = intent(ids, 'BUY');
    const res = await oms.submit(entry, approved(entry.intentId));
    clock.advance(51);
    expect(oms.cancelUnacked()).toEqual([res.order.clientOrderId]);
    expect(adapter.cancelled).toEqual([res.order.clientOrderId]);
  });

  it('fill-after-cancel race still creates the correct position', async () => {
    const clock = new ManualClock(1);
    const ids = new IdFactory(SESSION);
    const adapter = new SilentAdapter();
    const oms = new Oms({ sessionId: SESSION, adapter, marketProfile: profile, clock, ids });
    const entry = intent(ids, 'BUY');
    const res = await oms.submit(entry, approved(entry.intentId));
    adapter.emit({ type: 'CANCELLED', clientOrderId: res.order.clientOrderId, ts: 2, brokerEventId: 'c1' });
    adapter.emit({
      type: 'FILL',
      clientOrderId: res.order.clientOrderId,
      brokerEventId: 'f1',
      fill: { clientOrderId: res.order.clientOrderId, fillId: 'f1', ts: 3, qty: 65, pricePaise: 10_010 },
    });
    expect(oms.getOrder(res.order.clientOrderId)?.state).toBe('FILLED');
    expect(oms.getPositions()[0]?.qty).toBe(65);
  });

  it('property: no order reaches SENT without RISK_APPROVED first', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), async (approvals) => {
        const events: Array<{ type: string; order: Order }> = [];
        const clock = new ManualClock(1);
        const ids = new IdFactory(SESSION);
        const adapter = new SilentAdapter();
        const oms = new Oms({
          sessionId: SESSION,
          adapter,
          marketProfile: profile,
          clock,
          ids,
          journal: (type, payload) => {
            if (type === 'order.updated') {
              const orderPayload = payload as { order: Order };
              events.push({ type: orderPayload.order.state, order: orderPayload.order });
            }
          },
          throttle: new TokenBucket({ capacity: 100, refillPerSec: 100, clock }),
        });
        for (const ok of approvals) {
          const next = intent(ids, 'BUY');
          await oms.submit(next, ok ? approved(next.intentId) : { intentId: next.intentId, ts: 1, approved: false, reason: 'TEST_REJECT' });
        }
        const seenApproved = new Set<string>();
        for (const ev of events) {
          if (ev.type === 'RISK_APPROVED') seenApproved.add(ev.order.clientOrderId);
          if (ev.type === 'SENT') expect(seenApproved.has(ev.order.clientOrderId)).toBe(true);
        }
      }),
    );
  });
});
