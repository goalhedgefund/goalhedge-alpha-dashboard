import { describe, expect, it } from 'vitest';
import type { BrokerOrderEvent, IBrokerAdapter } from '../../src/exec/adapter.js';
import { makeInstrumentId, makeSessionId, type ClientOrderId, type InstrumentId, type IntentId, type SessionId } from '../../src/domain/ids.js';
import type { Order, Side } from '../../src/domain/orders.js';

/**
 * Adapter conformance suite (02-CODING-PLAN M5 contract, M11 acceptance gate).
 *
 * The broker-agnostic contract EVERY `IBrokerAdapter` must satisfy — PaperBroker
 * today, a real broker (Dhan/…) before it can go live. The harness supplies the
 * adapter-specific arrangement (quotes, latency settling, optional chaos); the
 * assertions here are the guaranteed contract. A real adapter's reject/partial
 * behavior that can't be forced on demand is covered separately by recorded
 * fixtures (M11), so those checks are capability-gated.
 */

export const CONF_SESSION: SessionId = makeSessionId('2026-07-03', 'paper');
export const CONF_INSTR: InstrumentId = makeInstrumentId('NSE', 'CONF1');

export interface AdapterHarness {
  adapter: IBrokerAdapter;
  /** Set the touch so a marketable order fills predictably. */
  quote(instrumentId: InstrumentId, q: { bidPaise: number; askPaise: number; ltpPaise: number }): void;
  /** Resolve any pending async acks/fills (no-op for a synchronous adapter). */
  settle(): Promise<void>;
  /** Optional: force the NEXT placed order to reject with `reason`. */
  rejectNext?(reason: string): void;
  /** Optional: force the NEXT fill to be partial (`qty`). */
  partialNext?(qty: number): void;
  /** Optional: re-emit an already-delivered event (must be deduped by the adapter). */
  emitDuplicate?(ev: BrokerOrderEvent): void;
}

let coidSeq = 0;

function mkSentOrder(opts: { instrumentId: InstrumentId; side: Side; qty: number; limitPricePaise?: number }): Order {
  coidSeq++;
  return {
    clientOrderId: `conf-ord-${coidSeq}` as ClientOrderId,
    intentId: `conf-int-${coidSeq}` as IntentId,
    sessionId: CONF_SESSION,
    instrumentId: opts.instrumentId,
    side: opts.side,
    qty: opts.qty,
    filledQty: 0,
    avgFillPricePaise: 0,
    type: opts.limitPricePaise !== undefined ? 'LIMIT' : 'MARKET',
    ...(opts.limitPricePaise !== undefined ? { limitPricePaise: opts.limitPricePaise } : {}),
    state: 'SENT',
    purpose: 'ENTRY',
    tag: 'conf:entry',
    createdTs: 1,
    updatedTs: 1,
  };
}

function netQty(adapter: IBrokerAdapter, instrumentId: InstrumentId): number {
  return adapter
    .getPositions()
    .filter((p) => p.instrumentId === instrumentId && p.state !== 'CLOSED')
    .reduce((n, p) => n + (p.side === 'BUY' ? p.qty : -p.qty), 0);
}

/** Register the full conformance suite against an adapter harness factory. */
export function describeAdapterConformance(name: string, make: () => AdapterHarness): void {
  describe(`IBrokerAdapter conformance — ${name}`, () => {
    it('exposes a non-empty adapterId', () => {
      expect(make().adapter.adapterId.length).toBeGreaterThan(0);
    });

    it('a marketable order acks then fills, and the book reflects it', async () => {
      const h = make();
      h.quote(CONF_INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      const events: BrokerOrderEvent[] = [];
      h.adapter.onOrderEvent((ev) => events.push(ev));

      const order = mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65, limitPricePaise: 10_020 });
      await h.adapter.placeOrder(order);
      await h.settle();

      expect(events.map((e) => e.type)).toEqual(['ACK', 'FILL']);
      const ack = events[0];
      expect(ack?.type === 'ACK' && ack.brokerOrderId.length).toBeGreaterThan(0);
      const fill = events[1];
      expect(fill?.type === 'FILL' && fill.fill.qty).toBe(65); // full fill
      expect(fill?.type === 'FILL' && fill.fill.clientOrderId).toBe(order.clientOrderId);
      expect(netQty(h.adapter, CONF_INSTR)).toBe(65);
      expect(h.adapter.getOrders().some((o) => o.clientOrderId === order.clientOrderId)).toBe(true);
    });

    it('every emitted event carries a unique brokerEventId', async () => {
      const h = make();
      h.quote(CONF_INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      const ids: string[] = [];
      h.adapter.onOrderEvent((ev) => ids.push(ev.brokerEventId));
      await h.adapter.placeOrder(mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65 }));
      await h.settle();
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('a BUY then equal SELL nets the position flat', async () => {
      const h = make();
      h.quote(CONF_INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      await h.adapter.placeOrder(mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65 }));
      await h.settle();
      expect(netQty(h.adapter, CONF_INSTR)).toBe(65);
      await h.adapter.placeOrder(mkSentOrder({ instrumentId: CONF_INSTR, side: 'SELL', qty: 65 }));
      await h.settle();
      expect(netQty(h.adapter, CONF_INSTR)).toBe(0);
    });

    it('cancelOrder emits a CANCELLED event', async () => {
      const h = make();
      const events: BrokerOrderEvent[] = [];
      h.adapter.onOrderEvent((ev) => events.push(ev));
      const order = mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65, limitPricePaise: 1 });
      await h.adapter.cancelOrder(order.clientOrderId);
      await h.settle();
      expect(events.some((e) => e.type === 'CANCELLED' && e.clientOrderId === order.clientOrderId)).toBe(true);
    });

    it('onOrderEvent returns an unsubscribe that stops delivery', async () => {
      const h = make();
      h.quote(CONF_INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      const events: BrokerOrderEvent[] = [];
      const off = h.adapter.onOrderEvent((ev) => events.push(ev));
      off();
      await h.adapter.placeOrder(mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65 }));
      await h.settle();
      expect(events).toHaveLength(0);
    });

    it('delivers events to every registered handler', async () => {
      const h = make();
      h.quote(CONF_INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      const a: BrokerOrderEvent[] = [];
      const b: BrokerOrderEvent[] = [];
      h.adapter.onOrderEvent((ev) => a.push(ev));
      h.adapter.onOrderEvent((ev) => b.push(ev));
      await h.adapter.placeOrder(mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65 }));
      await h.settle();
      expect(a.map((e) => e.type)).toEqual(['ACK', 'FILL']);
      expect(b.map((e) => e.type)).toEqual(['ACK', 'FILL']);
    });

    it('rejects instead of filling when arranged [capability]', async () => {
      const h = make();
      if (h.rejectNext === undefined) return; // real adapters: covered by recorded fixtures
      h.quote(CONF_INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      const events: BrokerOrderEvent[] = [];
      h.adapter.onOrderEvent((ev) => events.push(ev));
      h.rejectNext('INSUFFICIENT_MARGIN');
      await h.adapter.placeOrder(mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65 }));
      await h.settle();
      expect(events.some((e) => e.type === 'REJECT' && e.reason === 'INSUFFICIENT_MARGIN')).toBe(true);
      expect(events.some((e) => e.type === 'FILL')).toBe(false);
      expect(netQty(h.adapter, CONF_INSTR)).toBe(0);
    });

    it('fills partially when arranged, and the book reflects the partial qty [capability]', async () => {
      const h = make();
      if (h.partialNext === undefined) return;
      h.quote(CONF_INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      const events: BrokerOrderEvent[] = [];
      h.adapter.onOrderEvent((ev) => events.push(ev));
      h.partialNext(25);
      await h.adapter.placeOrder(mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65 }));
      await h.settle();
      const fill = events.find((e) => e.type === 'FILL');
      expect(fill?.type === 'FILL' && fill.fill.qty).toBe(25);
      expect(netQty(h.adapter, CONF_INSTR)).toBe(25);
    });

    it('deduplicates a re-emitted broker event [capability]', async () => {
      const h = make();
      if (h.emitDuplicate === undefined) return;
      h.quote(CONF_INSTR, { bidPaise: 10_000, askPaise: 10_010, ltpPaise: 10_005 });
      const events: BrokerOrderEvent[] = [];
      h.adapter.onOrderEvent((ev) => events.push(ev));
      await h.adapter.placeOrder(mkSentOrder({ instrumentId: CONF_INSTR, side: 'BUY', qty: 65 }));
      await h.settle();
      const fill = events.find((e) => e.type === 'FILL');
      expect(fill).toBeDefined();
      if (fill !== undefined) h.emitDuplicate(fill);
      await h.settle();
      expect(events.filter((e) => e.type === 'FILL')).toHaveLength(1);
    });
  });
}
