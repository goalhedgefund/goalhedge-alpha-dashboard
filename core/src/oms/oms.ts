import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import { IdFactory } from '../domain/ids.js';
import type { ClientOrderId, SessionId } from '../domain/ids.js';
import type { Fill, Order, OrderIntent, OrderState, OrderType } from '../domain/orders.js';
import { isTerminalOrderState } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import type { RiskVerdict } from '../domain/risk.js';
import { systemClock, type Clock } from '../domain/time.js';
import type { BrokerOrderEvent, IBrokerAdapter } from '../exec/adapter.js';
import type { TradesWriter } from '../exec/trades-writer.js';
import { PositionKeeper } from './position-keeper.js';
import { TokenBucket } from './throttle.js';
import { transitionOrder } from './state-machine.js';

export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

export interface OmsOptions {
  sessionId: SessionId;
  adapter: IBrokerAdapter;
  marketProfile: MarketProfile;
  clock?: Clock;
  ids?: IdFactory;
  journal?: JournalSink;
  tradesWriter?: TradesWriter;
  throttle?: TokenBucket;
  /**
   * Reserved lane for exits (STOP/EXIT/SQUARE_OFF/KILL): a stop exit must
   * never be starved because entries drained the main bucket.
   */
  exitThrottle?: TokenBucket;
  unackedTimeoutMs?: number;
}

export interface SubmitResult {
  order: Order;
  accepted: boolean;
  reason?: string;
}

export class Oms {
  private readonly adapter: IBrokerAdapter;
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly journal: JournalSink | undefined;
  private readonly tradesWriter: TradesWriter | undefined;
  private readonly throttle: TokenBucket;
  private readonly exitThrottle: TokenBucket;
  private readonly unackedTimeoutMs: number;
  private readonly positionKeeper: PositionKeeper;
  private readonly orders = new Map<ClientOrderId, Order>();
  private readonly ttlMs = new Map<ClientOrderId, number>();
  private readonly brokerEvents = new Set<string>();
  private readonly fillIds = new Set<string>();

  constructor(opts: OmsOptions) {
    this.adapter = opts.adapter;
    this.clock = opts.clock ?? systemClock;
    this.ids = opts.ids ?? new IdFactory(opts.sessionId);
    this.journal = opts.journal;
    this.tradesWriter = opts.tradesWriter;
    this.throttle = opts.throttle ?? new TokenBucket({ capacity: 10, refillPerSec: 10, clock: this.clock });
    this.exitThrottle =
      opts.exitThrottle ?? new TokenBucket({ capacity: 20, refillPerSec: 20, clock: this.clock });
    this.unackedTimeoutMs = opts.unackedTimeoutMs ?? 1000;
    this.positionKeeper = new PositionKeeper(opts.sessionId, opts.marketProfile, this.ids);
    this.adapter.onOrderEvent((ev) => this.onBrokerEvent(ev));
  }

  /**
   * `onSent` (optional) fires synchronously the instant the order reaches SENT,
   * BEFORE the adapter's wire call — it stamps the internal latency hop t_sent
   * so the tick→order budget never includes broker RTT (01-DESIGN §7).
   */
  async submit(intent: OrderIntent, verdict: RiskVerdict, onSent?: () => void): Promise<SubmitResult> {
    if (!verdict.approved) return { order: this.draftOrder(intent), accepted: false, reason: verdict.reason ?? 'RISK_REJECTED' };
    const bucket = intent.purpose === 'ENTRY' ? this.throttle : this.exitThrottle;
    if (!bucket.tryTake()) return { order: this.draftOrder(intent), accepted: false, reason: 'THROTTLED' };

    const draft = this.draftOrder(intent);
    this.orders.set(draft.clientOrderId, draft);
    this.ttlMs.set(draft.clientOrderId, intent.ttlMs);
    this.emit('order.created', { order: draft });
    const approved = this.transition(draft, 'RISK_APPROVED');
    const sent = this.transition(approved, 'SENT');
    onSent?.();
    await this.adapter.placeOrder(sent);
    return { order: sent, accepted: true };
  }

  cancel(clientOrderId: ClientOrderId): Promise<void> {
    return this.adapter.cancelOrder(clientOrderId);
  }

  expireTtl(now = this.clock.now()): Order[] {
    const expired: Order[] = [];
    for (const order of this.orders.values()) {
      if (isTerminalOrderState(order.state)) continue;
      const ttl = this.ttlMs.get(order.clientOrderId) ?? Infinity;
      const age = now - order.createdTs;
      if (age < ttl) continue;
      if (order.state === 'RISK_APPROVED' || order.state === 'SENT' || order.state === 'ACKED' || order.state === 'PARTIAL') {
        const next = this.transition(order, 'EXPIRED');
        expired.push(next);
      }
    }
    return expired;
  }

  cancelUnacked(now = this.clock.now()): ClientOrderId[] {
    const cancelled: ClientOrderId[] = [];
    for (const order of this.orders.values()) {
      if (order.state === 'SENT' && now - order.updatedTs >= this.unackedTimeoutMs) {
        cancelled.push(order.clientOrderId);
        void this.adapter.cancelOrder(order.clientOrderId);
      }
    }
    return cancelled;
  }

  getOrder(clientOrderId: ClientOrderId): Order | undefined {
    return this.orders.get(clientOrderId);
  }

  getOrders(): Order[] {
    return Array.from(this.orders.values());
  }

  getPositions(): Position[] {
    return this.positionKeeper.getPositions();
  }

  private draftOrder(intent: OrderIntent): Order {
    const now = this.clock.now();
    const type: OrderType = intent.type === 'LIMIT' ? 'LIMIT' : intent.limitPricePaise !== undefined ? 'LIMIT' : 'MARKET';
    return {
      clientOrderId: this.ids.clientOrderId(),
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      instrumentId: intent.instrumentId,
      side: intent.side,
      qty: intent.qty,
      filledQty: 0,
      avgFillPricePaise: 0,
      type,
      ...(intent.limitPricePaise !== undefined ? { limitPricePaise: intent.limitPricePaise } : {}),
      state: 'DRAFT',
      purpose: intent.purpose,
      tag: intent.tag,
      createdTs: now,
      updatedTs: now,
    };
  }

  private onBrokerEvent(ev: BrokerOrderEvent): void {
    if (this.brokerEvents.has(ev.brokerEventId)) return;
    this.brokerEvents.add(ev.brokerEventId);
    this.tradesWriter?.append({ kind: 'orderEvent', event: ev });
    const order = this.orders.get(ev.clientOrderId);
    if (order === undefined) return;

    if (ev.type === 'ACK') {
      if (order.state === 'SENT') {
        const acked = this.transition({ ...order, brokerOrderId: ev.brokerOrderId }, 'ACKED');
        this.orders.set(acked.clientOrderId, acked);
      }
      return;
    }

    if (ev.type === 'REJECT') {
      if (!isTerminalOrderState(order.state)) {
        this.transition({ ...order, rejectReason: ev.reason }, 'REJECTED');
      }
      return;
    }

    if (ev.type === 'CANCELLED') {
      if (!isTerminalOrderState(order.state)) this.transition(order, 'CANCELLED');
      return;
    }

    if (this.fillIds.has(ev.fill.fillId)) return;
    this.fillIds.add(ev.fill.fillId);
    this.applyFill(order, ev.fill);
  }

  private applyFill(order: Order, fill: Fill): void {
    const totalQty = order.filledQty + fill.qty;
    const totalValue = order.avgFillPricePaise * order.filledQty + fill.pricePaise * fill.qty;
    const state: OrderState = totalQty >= order.qty ? 'FILLED' : 'PARTIAL';
    const next: Order = {
      ...order,
      filledQty: totalQty,
      avgFillPricePaise: Math.round(totalValue / totalQty),
      state: order.state,
      updatedTs: fill.ts,
    };
    const transitioned = isTerminalOrderState(order.state)
      ? { ...next, state }
      : this.transition(next, state, fill);
    this.orders.set(transitioned.clientOrderId, transitioned);
    const updates = this.positionKeeper.onFill(transitioned, fill);
    for (const position of updates.positions) {
      const isFreshOpen = transitioned.side === 'BUY' && position.openedTs === fill.ts;
      if (isFreshOpen) this.emit('position.opened', { position });
      else this.emit('position.updated', { position });
      if (position.state === 'CLOSED') this.emit('position.closed', { positionId: position.positionId, sessionId: position.sessionId });
    }
    for (const trade of updates.trades) {
      this.emit('trade.completed', { trade });
      this.tradesWriter?.append({ kind: 'trade', trade });
    }
  }

  private transition(order: Order, to: OrderState, fill?: Fill): Order {
    const from = order.state;
    const next = transitionOrder(order, to, this.clock.now());
    this.orders.set(next.clientOrderId, next);
    this.emit('order.updated', { order: next, cause: fill !== undefined ? 'FILL' : 'TRANSITION', from, ...(fill !== undefined ? { fill } : {}) });
    return next;
  }

  private emit<K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void {
    this.journal?.(type, payload);
  }
}
