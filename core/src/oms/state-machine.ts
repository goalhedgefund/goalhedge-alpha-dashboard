import type { Order, OrderState } from '../domain/orders.js';

const LEGAL: ReadonlyMap<OrderState, ReadonlySet<OrderState>> = new Map([
  ['DRAFT', new Set(['RISK_APPROVED'])],
  ['RISK_APPROVED', new Set(['SENT'])],
  ['SENT', new Set(['ACKED', 'REJECTED', 'CANCELLED', 'EXPIRED'])],
  ['ACKED', new Set(['PARTIAL', 'FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'])],
  ['PARTIAL', new Set(['PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED'])],
  ['FILLED', new Set()],
  ['REJECTED', new Set()],
  ['CANCELLED', new Set()],
  ['EXPIRED', new Set()],
]);

export class IllegalOrderTransitionError extends Error {
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`illegal order transition: ${from} -> ${to}`);
    this.name = 'IllegalOrderTransitionError';
  }
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return LEGAL.get(from)?.has(to) ?? false;
}

export function transitionOrder(order: Order, to: OrderState, ts: number): Order {
  if (!canTransition(order.state, to)) throw new IllegalOrderTransitionError(order.state, to);
  return { ...order, state: to, updatedTs: ts };
}
