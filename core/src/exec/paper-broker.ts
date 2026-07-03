import type { InstrumentId, PositionId } from '../domain/ids.js';
import type { Fill, Order } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import { systemClock, type Clock } from '../domain/time.js';
import type { BrokerOrderEvent, IBrokerAdapter } from './adapter.js';

export interface PaperQuote {
  bidPaise: number;
  askPaise: number;
  ltpPaise: number;
}

export interface PaperBrokerOptions {
  clock?: Clock;
  slippageTicks?: number;
  tickSizePaise?: number;
  ackLatencyMs?: number;
  fillLatencyMs?: number;
  rejectNext?: string;
  partialFillQty?: number;
}

export class PaperBroker implements IBrokerAdapter {
  readonly adapterId = 'paper';
  private readonly clock: Clock;
  private readonly slippagePaise: number;
  private readonly ackLatencyMs: number;
  private readonly fillLatencyMs: number;
  private readonly orders = new Map<string, Order>();
  private readonly positions = new Map<InstrumentId, Position>();
  private readonly handlers = new Set<(ev: BrokerOrderEvent) => void>();
  private readonly seenEventIds = new Set<string>();
  private quotes = new Map<InstrumentId, PaperQuote>();
  private rejectReason: string | undefined;
  private partialQty: number | undefined;
  private seq = 0;

  constructor(opts: PaperBrokerOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.slippagePaise = (opts.slippageTicks ?? 0) * (opts.tickSizePaise ?? 5);
    this.ackLatencyMs = opts.ackLatencyMs ?? 0;
    this.fillLatencyMs = opts.fillLatencyMs ?? 0;
    this.rejectReason = opts.rejectNext;
    this.partialQty = opts.partialFillQty;
  }

  setQuote(instrumentId: InstrumentId, quote: PaperQuote): void {
    this.quotes.set(instrumentId, quote);
  }

  rejectNext(reason: string): void {
    this.rejectReason = reason;
  }

  partialFillNext(qty: number): void {
    this.partialQty = qty;
  }

  onOrderEvent(cb: (ev: BrokerOrderEvent) => void): () => void {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }

  async placeOrder(order: Order): Promise<void> {
    this.orders.set(order.clientOrderId, order);
    const reject = this.rejectReason;
    this.rejectReason = undefined;
    if (reject !== undefined) {
      this.later(this.ackLatencyMs, () =>
        {
          const ts = this.clock.now();
          this.orders.set(order.clientOrderId, { ...order, state: 'REJECTED', rejectReason: reject, updatedTs: ts });
          this.emit({
            type: 'REJECT',
            clientOrderId: order.clientOrderId,
            reason: reject,
            ts,
            brokerEventId: this.eventId('reject'),
          });
        },
      );
      return;
    }

    this.later(this.ackLatencyMs, () => {
      const ackTs = this.clock.now();
      this.orders.set(order.clientOrderId, { ...order, state: 'ACKED', brokerOrderId: `PAPER-${order.clientOrderId}`, updatedTs: ackTs });
      this.emit({
        type: 'ACK',
        clientOrderId: order.clientOrderId,
        brokerOrderId: `PAPER-${order.clientOrderId}`,
        ts: ackTs,
        brokerEventId: this.eventId('ack'),
      });
      this.later(this.fillLatencyMs, () => this.fillOrder(order));
    });
  }

  async cancelOrder(clientOrderId: Order['clientOrderId']): Promise<void> {
    const existing = this.orders.get(clientOrderId);
    const ts = this.clock.now();
    if (existing !== undefined) this.orders.set(clientOrderId, { ...existing, state: 'CANCELLED', updatedTs: ts });
    this.emit({
      type: 'CANCELLED',
      clientOrderId,
      ts,
      brokerEventId: this.eventId('cancel'),
    });
  }

  getOrders(): Order[] {
    return Array.from(this.orders.values());
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  emitDuplicate(ev: BrokerOrderEvent): void {
    this.emit(ev);
  }

  private fillOrder(order: Order): void {
    const quote = this.quotes.get(order.instrumentId);
    const base = order.side === 'BUY'
      ? quote?.askPaise ?? order.limitPricePaise ?? quote?.ltpPaise ?? 0
      : quote?.bidPaise ?? order.limitPricePaise ?? quote?.ltpPaise ?? 0;
    if (base <= 0) {
      this.emit({
        type: 'REJECT',
        clientOrderId: order.clientOrderId,
        reason: 'NO_QUOTE',
        ts: this.clock.now(),
        brokerEventId: this.eventId('reject'),
      });
      return;
    }
    const fillQty = Math.min(order.qty, this.partialQty ?? order.qty);
    this.partialQty = undefined;
    const pricePaise = order.side === 'BUY' ? base + this.slippagePaise : Math.max(1, base - this.slippagePaise);
    const fill: Fill = {
      clientOrderId: order.clientOrderId,
      fillId: this.eventId('fill'),
      ts: this.clock.now(),
      qty: fillQty,
      pricePaise,
    };
    const existing = this.orders.get(order.clientOrderId) ?? order;
    const filledQty = existing.filledQty + fillQty;
    const avgFillPricePaise = Math.round((existing.avgFillPricePaise * existing.filledQty + fillQty * pricePaise) / filledQty);
    this.orders.set(order.clientOrderId, {
      ...existing,
      filledQty,
      avgFillPricePaise,
      state: filledQty >= order.qty ? 'FILLED' : 'PARTIAL',
      updatedTs: fill.ts,
    });
    this.applyPosition(order, fill);
    this.emit({ type: 'FILL', clientOrderId: order.clientOrderId, fill, brokerEventId: fill.fillId });
  }

  private applyPosition(order: Order, fill: Fill): void {
    const existing = this.positions.get(order.instrumentId);
    if (order.side === 'BUY') {
      const oldQty = existing?.qty ?? 0;
      const oldValue = (existing?.avgEntryPricePaise ?? 0) * oldQty;
      const qty = oldQty + fill.qty;
      this.positions.set(order.instrumentId, {
        positionId: existing?.positionId ?? (`paper-${order.instrumentId}` as PositionId),
        sessionId: order.sessionId,
        strategyId: order.tag.split(':')[0] ?? order.tag,
        instrumentId: order.instrumentId,
        side: 'BUY',
        qty,
        avgEntryPricePaise: Math.round((oldValue + fill.qty * fill.pricePaise) / qty),
        state: 'OPEN',
        realizedGrossPaise: existing?.realizedGrossPaise ?? 0,
        openedTs: existing?.openedTs ?? fill.ts,
        updatedTs: fill.ts,
      });
      return;
    }

    if (existing === undefined) return;
    const qty = Math.max(0, existing.qty - fill.qty);
    const realizedGrossPaise = existing.realizedGrossPaise + (fill.pricePaise - existing.avgEntryPricePaise) * Math.min(fill.qty, existing.qty);
    if (qty === 0) {
      this.positions.delete(order.instrumentId);
      return;
    }
    this.positions.set(order.instrumentId, {
      ...existing,
      qty,
      realizedGrossPaise,
      updatedTs: fill.ts,
    });
  }

  private later(delayMs: number, fn: () => void): void {
    if (delayMs <= 0) fn();
    else setTimeout(fn, delayMs).unref();
  }

  private eventId(kind: string): string {
    this.seq++;
    return `${kind}-${this.seq}`;
  }

  private emit(ev: BrokerOrderEvent): void {
    if (this.seenEventIds.has(ev.brokerEventId)) return;
    this.seenEventIds.add(ev.brokerEventId);
    for (const h of this.handlers) h(ev);
  }
}
