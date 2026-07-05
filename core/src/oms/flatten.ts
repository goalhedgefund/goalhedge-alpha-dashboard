import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import type { ClientOrderId, IdFactory, InstrumentId, SessionId } from '../domain/ids.js';
import { isTerminalOrderState, type Order, type OrderIntent } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import type { RiskVerdict } from '../domain/risk.js';
import type { Clock } from '../domain/time.js';
import type { SubmitResult } from './oms.js';
import type { RiskGate, RiskGateContext } from '../risk/risk-gate.js';
import type { ExitEscalator } from './escalation.js';

export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

/** Narrow OMS surface for cancel-all / flatten-all (Oms satisfies structurally). */
export interface FlattenOmsPort {
  getOrders(): Order[];
  getPositions(): Position[];
  cancel(clientOrderId: ClientOrderId): Promise<void>;
  submit(intent: OrderIntent, verdict: RiskVerdict): Promise<SubmitResult>;
}

export interface FlattenPorts {
  sessionId: SessionId;
  oms: FlattenOmsPort;
  gate: RiskGate;
  gateContext: () => RiskGateContext;
  ids: IdFactory;
  market: MarketProfile;
  /** Best-effort exit mark (bid side); undefined → market order. */
  markPrice: (instrumentId: InstrumentId) => number | undefined;
  clock: Clock;
  journal?: JournalSink;
  protectTicks: number;
  /** When present, submitted exits are tracked for reprice→market escalation. */
  escalator?: ExitEscalator;
}

/**
 * Build one flatten exit intent. With a mark: aggressive protect-limit that
 * crosses the spread. Without one: pure market — getting flat beats price.
 * Shared by the kill switch (purpose KILL) and the session square-off
 * (purpose SQUARE_OFF, which must NOT lock the session — only kill locks).
 */
export function buildFlattenIntent(
  p: FlattenPorts,
  pos: Position,
  purpose: 'KILL' | 'SQUARE_OFF' | 'EXIT',
  tag: string,
): OrderIntent {
  const mark = p.markPrice(pos.instrumentId);
  const tick = p.market.tickSizePaise;
  const hasMark = mark !== undefined && mark > 0;
  return {
    intentId: p.ids.intentId(),
    sessionId: p.sessionId,
    strategyId: pos.strategyId,
    ts: p.clock.now(),
    side: 'SELL',
    instrumentId: pos.instrumentId,
    qty: pos.qty,
    type: hasMark ? 'LIMIT' : 'MARKET_PROTECT',
    ...(hasMark ? { limitPricePaise: Math.max(tick, mark - p.protectTicks * tick) } : {}),
    protectTicks: p.protectTicks,
    ttlMs: 2_000,
    tag,
    purpose,
  };
}

/** Cancel every order still working at the broker. Returns the count. */
export async function cancelAllOpenOrders(p: FlattenPorts): Promise<number> {
  let cancelled = 0;
  for (const order of p.oms.getOrders()) {
    if (isTerminalOrderState(order.state)) continue;
    try {
      await p.oms.cancel(order.clientOrderId);
      cancelled++;
    } catch (err) {
      p.journal?.('diag.error', { where: 'flatten.cancel', message: String(err) });
    }
  }
  return cancelled;
}

/**
 * Flatten every open position through the gate's exit lane (approves under
 * any latched stop / spread / limit condition). Returns positions flattened.
 */
export async function flattenAllPositions(
  p: FlattenPorts,
  purpose: 'KILL' | 'SQUARE_OFF' | 'EXIT',
  tag: string,
): Promise<number> {
  // Re-callable without stacking sells: skip positions that already have a
  // working exit order (the escalator chases those). Makes retry loops safe.
  const chasing = new Set(
    p.oms
      .getOrders()
      .filter((o) => !isTerminalOrderState(o.state) && o.side === 'SELL')
      .map((o) => o.instrumentId),
  );
  let flattened = 0;
  for (const pos of p.oms.getPositions()) {
    if (pos.state === 'CLOSED' || pos.qty <= 0) continue;
    if (chasing.has(pos.instrumentId)) continue;
    const intent = buildFlattenIntent(p, pos, purpose, tag);
    p.journal?.('intent.proposed', { intent });
    const verdict = p.gate.evaluate(intent, p.gateContext());
    p.journal?.('risk.verdict', { verdict });
    if (!verdict.approved) {
      p.journal?.('diag.error', {
        where: 'flatten.submit',
        message: `gate rejected ${purpose} exit: ${verdict.reason ?? 'unknown'}`,
      });
      continue;
    }
    try {
      const result = await p.oms.submit(intent, verdict);
      if (result.accepted) {
        flattened++;
        p.escalator?.track(result.order, intent);
      }
    } catch (err) {
      p.journal?.('diag.error', { where: 'flatten.submit', message: String(err) });
    }
  }
  return flattened;
}
