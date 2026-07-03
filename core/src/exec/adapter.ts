import type { ClientOrderId } from '../domain/ids.js';
import type { Fill, Order } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';

export type BrokerOrderEvent =
  | { type: 'ACK'; clientOrderId: ClientOrderId; brokerOrderId: string; ts: number; brokerEventId: string }
  | { type: 'FILL'; clientOrderId: ClientOrderId; fill: Fill; brokerEventId: string }
  | { type: 'REJECT'; clientOrderId: ClientOrderId; reason: string; ts: number; brokerEventId: string }
  | { type: 'CANCELLED'; clientOrderId: ClientOrderId; ts: number; brokerEventId: string };

export interface IBrokerAdapter {
  readonly adapterId: string;
  placeOrder(order: Order): Promise<void>;
  cancelOrder(clientOrderId: ClientOrderId): Promise<void>;
  getOrders(): Order[];
  getPositions(): Position[];
  onOrderEvent(cb: (ev: BrokerOrderEvent) => void): () => void;
}
