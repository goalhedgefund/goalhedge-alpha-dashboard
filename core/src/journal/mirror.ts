import type { JournalEvent } from '../domain/events.js';
import type { Persistence } from '../persistence/db.js';

/**
 * Mirror one journal event into SQLite. High-volume analytical events
 * (ticks, bars, signals, latency samples) intentionally stay journal-only.
 * Rebuilding the whole DB = replaying the journal through this function.
 */
export function mirrorEvent(db: Persistence, ev: JournalEvent): void {
  switch (ev.type) {
    case 'session.started':
      db.upsertSession(ev.payload.session);
      break;
    case 'session.phase':
      db.setSessionPhase(ev.payload.sessionId, ev.payload.phase);
      break;
    case 'session.closed':
      db.closeSession(ev.payload.sessionId, ev.ts);
      break;
    case 'config.loaded':
      db.recordConfigHash(ev.payload.sessionId, ev.payload.name, ev.payload.hash, ev.payload.path);
      break;
    case 'order.created':
      db.upsertOrder(ev.payload.order);
      db.insertOrderEvent(
        ev.payload.order.sessionId,
        ev.seq,
        ev.payload.order.clientOrderId,
        ev.ts,
        'created',
        JSON.stringify({ state: ev.payload.order.state }),
      );
      break;
    case 'order.updated': {
      const { order, cause, from, fill } = ev.payload;
      db.upsertOrder(order);
      db.insertOrderEvent(
        order.sessionId,
        ev.seq,
        order.clientOrderId,
        ev.ts,
        cause === 'FILL' ? 'fill' : 'transition',
        JSON.stringify({ from, to: order.state, fill }),
      );
      break;
    }
    case 'position.opened':
    case 'position.updated':
      db.upsertPosition(ev.payload.position);
      break;
    case 'position.closed':
      db.markPositionClosed(ev.payload.positionId);
      break;
    case 'trade.completed':
      db.insertTrade(ev.payload.trade);
      break;
    default:
      break;
  }
}
