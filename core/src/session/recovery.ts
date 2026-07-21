import { appendFile, readFile, truncate } from 'node:fs/promises';
import type { RiskProfile } from '../config/schemas.js';
import type { JournalEvent } from '../domain/events.js';
import type { Order } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import type { Trade } from '../domain/positions.js';
import type { SessionPhase, SessionState } from '../domain/session.js';
import { diffNetPositions, type PositionDiff } from '../oms/reconciler.js';
import { readJournal } from '../journal/reader.js';
import { SessionRiskState } from '../risk/session-risk.js';

export interface RecoveryOptions {
  /** Profile to rebuild the session-risk latches deterministically. */
  riskProfile: RiskProfile;
  /** Enforce gap-free seq during read (default true). */
  strictSeq?: boolean;
}

export interface RecoveredState {
  /** Original events, replayed into the gateway after a process restart. */
  events: JournalEvent[];
  session: SessionState | undefined;
  /** Last journaled phase (before the crash). */
  phase: SessionPhase | undefined;
  configHashes: Record<string, string>;
  /** Every order last-seen, terminal included (matches Oms.getOrders()). */
  orders: Order[];
  /** Live positions only — closed ones are dropped, as PositionKeeper does. */
  positions: Position[];
  trades: Trade[];
  /** Rebuilt by replaying completed-trade net P&L through the risk profile. */
  sessionRisk: SessionRiskState;
  /** Highest seq present; resume the writer at lastSeq + 1. */
  lastSeq: number;
  /** True if the file ended in an incomplete line (dropped + truncated). */
  partialTail: boolean;
}

/**
 * Pure reducer over a journal event stream (02-CODING-PLAN M9, 01-DESIGN §9).
 * Rebuilds order/position/trade/session state from the append-only log —
 * mirrors mirror.ts's switch shape so the two never drift. Order and position
 * events carry FULL snapshots, so the last snapshot per id IS the state; a
 * `position.closed` drops the book exactly as PositionKeeper does on a full
 * exit (so the rebuilt `positions` equals `Oms.getPositions()`).
 */
export function reduceJournal(events: readonly JournalEvent[], riskProfile: RiskProfile): Omit<RecoveredState, 'partialTail'> {
  let session: SessionState | undefined;
  let phase: SessionPhase | undefined;
  const configHashes: Record<string, string> = {};
  const orders = new Map<string, Order>();
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const sessionRisk = new SessionRiskState(riskProfile);
  let lastSeq = 0;

  for (const ev of events) {
    lastSeq = ev.seq;
    switch (ev.type) {
      case 'session.started':
        session = ev.payload.session;
        phase = ev.payload.session.phase;
        break;
      case 'session.phase':
        phase = ev.payload.phase;
        break;
      case 'config.loaded':
        configHashes[ev.payload.name] = ev.payload.hash;
        break;
      case 'order.created':
      case 'order.updated':
        orders.set(ev.payload.order.clientOrderId, ev.payload.order);
        break;
      case 'position.opened':
      case 'position.updated':
        positions.set(ev.payload.position.positionId, ev.payload.position);
        break;
      case 'position.closed':
        // PositionKeeper deletes a fully-closed book — mirror that so the
        // rebuilt live book matches Oms.getPositions() exactly.
        positions.delete(ev.payload.positionId);
        break;
      case 'trade.completed':
        trades.push(ev.payload.trade);
        sessionRisk.recordTrade(ev.payload.trade.netPnlPaise);
        break;
      default:
        break;
    }
  }

  return {
    events: [...events],
    session,
    phase,
    configHashes,
    orders: [...orders.values()],
    positions: [...positions.values()].filter((p) => p.state !== 'CLOSED' && p.qty > 0),
    trades,
    sessionRisk,
    lastSeq,
  };
}

/**
 * Recover from a journal file on disk: read → reduce → (crash-safe) prepare
 * the file for the resuming writer. A trailing partial line (process died
 * mid-write) is dropped from the rebuilt state AND physically truncated from
 * the file, so the resumed writer never appends onto a torn line — the seq
 * stream stays gap-free and re-parseable.
 */
export async function recoverFromJournal(path: string, opts: RecoveryOptions): Promise<RecoveredState> {
  const { events, partialTail } = await readJournal(path, { strictSeq: opts.strictSeq ?? true });
  const reduced = reduceJournal(events, opts.riskProfile);
  await prepareJournalForResume(path);
  return { ...reduced, events, partialTail };
}

/**
 * Ensure the file ends on a clean newline after the last VALID event, so a
 * writer opened in append mode (resume) starts a fresh line at the right seq.
 * - unparseable trailing line → truncate it away.
 * - valid trailing line without a newline → add the newline.
 * - already clean → no-op.
 */
export async function prepareJournalForResume(path: string): Promise<void> {
  const raw = await readFile(path, 'utf8');
  if (raw.length === 0 || raw.endsWith('\n')) return;

  const lastNl = raw.lastIndexOf('\n');
  const throughLastNl = lastNl + 1; // 0 if there is no newline at all
  const tail = raw.slice(throughLastNl);

  let tailIsValidEvent = false;
  try {
    const parsed = JSON.parse(tail) as { seq?: unknown; type?: unknown };
    tailIsValidEvent = typeof parsed.seq === 'number' && typeof parsed.type === 'string';
  } catch {
    tailIsValidEvent = false;
  }

  if (tailIsValidEvent) {
    // A complete event that just lost its trailing newline — terminate it.
    await appendFile(path, '\n');
  } else {
    // Drop the torn tail entirely.
    await truncate(path, Buffer.byteLength(raw.slice(0, throughLastNl)));
  }
}

/**
 * Reconcile the rebuilt live positions against the broker's positions. A
 * non-empty result means the two disagree on exposure — the caller must
 * safe-halt (phase HALTED, do NOT ARM) rather than resume trading blind.
 */
export function reconcileRecovered(
  recovered: Pick<RecoveredState, 'positions'>,
  brokerPositions: readonly Position[],
): PositionDiff[] {
  return diffNetPositions(recovered.positions, brokerPositions);
}
