import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import { isTerminalOrderState, type Order, type OrderState } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import { systemClock, type Clock } from '../domain/time.js';

export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

/**
 * Reconciliation traffic light:
 * - GREEN: OMS and broker agree on net position and working orders.
 * - AMBER: a working order exists on one side only — order-level drift, a
 *   warning worth surfacing but not dangerous. Does not trip.
 * - RED: net position quantity disagrees for some instrument. This is the
 *   one that can bankrupt you — trips the kill switch immediately.
 */
export type ReconState = 'GREEN' | 'AMBER' | 'RED';

/** Both the OMS and any IBrokerAdapter satisfy this structurally. */
export interface ReconBookPort {
  getOrders(): Order[];
  getPositions(): Position[];
}

/** The slice of the kill switch the reconciler needs. */
export interface ReconKillPort {
  trip(source: 'AUTO', reason: string): Promise<unknown>;
  isLocked(): boolean;
}

export interface ReconcilerOptions {
  /** Our own order/position book (the OMS). */
  oms: ReconBookPort;
  /** The broker's book (adapter.getOrders()/getPositions()). */
  adapter: ReconBookPort;
  kill: ReconKillPort;
  clock?: Clock;
  journal?: JournalSink;
}

export interface PositionDiff {
  instrumentId: string;
  omsNet: number;
  brokerNet: number;
}

export interface OrderDiff {
  clientOrderId: string;
  issue: 'OMS_WORKING_ONLY' | 'BROKER_WORKING_ONLY';
  state?: OrderState;
}

export interface ReconResult {
  state: ReconState;
  positionDiffs: PositionDiff[];
  orderDiffs: OrderDiff[];
}

/**
 * Reconciliation loop (02-CODING-PLAN M9, 01-DESIGN §6/§9). Diffs the OMS
 * book against the broker's book. Meant to be called on a timer cadence AND
 * after every order event; both are the wiring's job (kept caller-driven and
 * side-effect-free apart from the journal + trip, so it stays deterministic
 * in replay/tests — same rationale as the exit escalator).
 *
 * `recon.result` is journaled deduplicated on STATE CHANGE only, so a healthy
 * session logs a single GREEN and every subsequent transition, never per-tick
 * spam. A RED result trips the kill switch (AUTO / RECON_MISMATCH) once.
 */
export class Reconciler {
  private lastState: ReconState | undefined;
  private readonly clock: Clock;

  constructor(private readonly opts: ReconcilerOptions) {
    this.clock = opts.clock ?? systemClock;
  }

  lastReconState(): ReconState | undefined {
    return this.lastState;
  }

  reconcile(): ReconResult {
    const positionDiffs = this.diffPositions();
    const orderDiffs = this.diffOrders();
    const state: ReconState =
      positionDiffs.length > 0 ? 'RED' : orderDiffs.length > 0 ? 'AMBER' : 'GREEN';
    const result: ReconResult = { state, positionDiffs, orderDiffs };

    if (state !== this.lastState) {
      this.lastState = state;
      this.opts.journal?.('recon.result', {
        ok: state === 'GREEN',
        ...(state === 'GREEN' ? {} : { diffs: { state, positionDiffs, orderDiffs } }),
      });
    }

    // RED = position mismatch: the dangerous case. Trip once (kill is
    // idempotent, but skip the call when already locked to avoid noise).
    if (state === 'RED' && !this.opts.kill.isLocked()) {
      void this.opts.kill.trip('AUTO', 'RECON_MISMATCH');
    }

    return result;
  }

  // --------------------------------------------------------------- internals

  private diffPositions(): PositionDiff[] {
    const oms = netByInstrument(this.opts.oms.getPositions());
    const broker = netByInstrument(this.opts.adapter.getPositions());
    const diffs: PositionDiff[] = [];
    for (const instrumentId of unionKeys(oms, broker)) {
      const omsNet = oms.get(instrumentId) ?? 0;
      const brokerNet = broker.get(instrumentId) ?? 0;
      if (omsNet !== brokerNet) diffs.push({ instrumentId, omsNet, brokerNet });
    }
    return diffs;
  }

  private diffOrders(): OrderDiff[] {
    const oms = workingByCoid(this.opts.oms.getOrders());
    const broker = workingByCoid(this.opts.adapter.getOrders());
    const diffs: OrderDiff[] = [];
    for (const coid of unionKeys(oms, broker)) {
      const omsState = oms.get(coid);
      const brokerState = broker.get(coid);
      if (omsState !== undefined && brokerState === undefined) {
        diffs.push({ clientOrderId: coid, issue: 'OMS_WORKING_ONLY', state: omsState });
      } else if (omsState === undefined && brokerState !== undefined) {
        diffs.push({ clientOrderId: coid, issue: 'BROKER_WORKING_ONLY', state: brokerState });
      }
    }
    return diffs;
  }
}

/** Net signed exposure per instrument, ignoring closed / zero-qty legs. */
function netByInstrument(positions: readonly Position[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of positions) {
    if (p.state === 'CLOSED' || p.qty <= 0) continue;
    const signed = p.side === 'BUY' ? p.qty : -p.qty;
    m.set(p.instrumentId, (m.get(p.instrumentId) ?? 0) + signed);
  }
  return m;
}

/** Working (non-terminal) orders keyed by clientOrderId. */
function workingByCoid(orders: readonly Order[]): Map<string, OrderState> {
  const m = new Map<string, OrderState>();
  for (const o of orders) {
    if (isTerminalOrderState(o.state)) continue;
    m.set(o.clientOrderId, o.state);
  }
  return m;
}

function unionKeys(a: Map<string, unknown>, b: Map<string, unknown>): Set<string> {
  const s = new Set<string>(a.keys());
  for (const k of b.keys()) s.add(k);
  return s;
}
