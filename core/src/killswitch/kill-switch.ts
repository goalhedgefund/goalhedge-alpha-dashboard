import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import type { ClientOrderId, IdFactory, InstrumentId, SessionId } from '../domain/ids.js';
import { isTerminalOrderState, type Order, type OrderIntent } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import type { RiskVerdict } from '../domain/risk.js';
import { systemClock, type Clock } from '../domain/time.js';
import type { SubmitResult } from '../oms/oms.js';
import type { RiskGate, RiskGateContext } from '../risk/risk-gate.js';

export type KillState = 'READY' | 'TRIPPING' | 'LOCKED';
export type KillSource = 'MANUAL' | 'AUTO';
export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

/** The narrow OMS surface the kill switch needs (Oms satisfies structurally). */
export interface KillOmsPort {
  getOrders(): Order[];
  getPositions(): Position[];
  cancel(clientOrderId: ClientOrderId): Promise<void>;
  submit(intent: OrderIntent, verdict: RiskVerdict): Promise<SubmitResult>;
}

export interface KillReport {
  state: KillState;
  alreadyTripped: boolean;
  reason?: string;
  durationMs: number;
  cancelledOrders: number;
  flattenedPositions: number;
}

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface KillSwitchOptions {
  sessionId: SessionId;
  /** Strategy runner (or anything that can stop proposing entries). */
  target: { disarm(): void };
  oms: KillOmsPort;
  gate: RiskGate;
  gateContext: () => RiskGateContext;
  ids: IdFactory;
  market: MarketProfile;
  /** Best-effort exit mark (bid side); undefined → market order. */
  markPrice: (instrumentId: InstrumentId) => number | undefined;
  clock?: Clock;
  journal?: JournalSink;
  notify?: (event: 'TRIPPED' | 'REARMED', detail: string) => void;
  /** Protect-limit distance for flatten exits (aggressive: crosses spread). */
  protectTicks?: number;
  /** AUTO trip: feed silence while positioned. */
  feedStaleMs?: number;
  /** AUTO trip: broker reject storm. */
  rejectStormCount?: number;
  rejectStormWindowMs?: number;
}

/**
 * The kill switch (01-DESIGN §6). Dependency-minimal: it sees the OMS
 * through a four-method port, the gate through evaluate(), and nothing from
 * strategy or marketdata.
 *
 * Action sequence (always the same order): disarm strategies → cancel all
 * open orders → flatten all positions via KILL-purpose intents (the gate's
 * exit lane approves these under ANY latched stop / spread / limit
 * condition) → LOCK. Re-arming requires the literal typed confirmation
 * 'REARM' plus a non-empty reason, both journaled.
 */
export class KillSwitch {
  private mode: KillState = 'READY';
  private tripReason: string | undefined;
  private lastTickTs = 0;
  private rejectTs: number[] = [];

  private readonly clock: Clock;
  private readonly protectTicks: number;
  private readonly feedStaleMs: number;
  private readonly rejectStormCount: number;
  private readonly rejectStormWindowMs: number;

  constructor(private readonly opts: KillSwitchOptions) {
    this.clock = opts.clock ?? systemClock;
    this.protectTicks = opts.protectTicks ?? 5;
    this.feedStaleMs = opts.feedStaleMs ?? 5_000;
    this.rejectStormCount = opts.rejectStormCount ?? 5;
    this.rejectStormWindowMs = opts.rejectStormWindowMs ?? 60_000;
  }

  state(): KillState {
    return this.mode;
  }

  isLocked(): boolean {
    return this.mode !== 'READY';
  }

  lastTripReason(): string | undefined {
    return this.tripReason;
  }

  // ------------------------------------------------------------ auto trips

  /** Feed every normalized tick timestamp here (any instrument). */
  noteTick(ts: number): void {
    if (ts > this.lastTickTs) this.lastTickTs = ts;
  }

  /** Feed broker REJECT events here; N within the window trips the switch. */
  noteReject(ts: number): void {
    this.rejectTs.push(ts);
    const cutoff = ts - this.rejectStormWindowMs;
    this.rejectTs = this.rejectTs.filter((t) => t >= cutoff);
    if (this.mode === 'READY' && this.rejectTs.length >= this.rejectStormCount) {
      void this.trip('AUTO', 'REJECT_STORM');
    }
  }

  /** Call on the timer cadence. Trips only when POSITIONED and silent. */
  checkFeedStale(nowMs: number): boolean {
    if (this.mode !== 'READY' || this.lastTickTs === 0) return false;
    if (nowMs - this.lastTickTs <= this.feedStaleMs) return false;
    const positioned = this.opts.oms.getPositions().some((p) => p.state !== 'CLOSED' && p.qty > 0);
    if (!positioned) return false;
    void this.trip('AUTO', 'FEED_STALE');
    return true;
  }

  // ------------------------------------------------------------ trip / rearm

  async trip(source: KillSource, reason: string): Promise<KillReport> {
    if (this.mode !== 'READY') {
      return {
        state: this.mode,
        alreadyTripped: true,
        ...(this.tripReason !== undefined ? { reason: this.tripReason } : {}),
        durationMs: 0,
        cancelledOrders: 0,
        flattenedPositions: 0,
      };
    }
    this.mode = 'TRIPPING';
    this.tripReason = reason;
    const started = this.clock.now();
    this.journal('kill.tripped', { source, reason });

    // 1. No new entries, ever again this session (until typed re-arm).
    this.opts.target.disarm();

    // 2. Cancel everything still working at the broker.
    let cancelled = 0;
    for (const order of this.opts.oms.getOrders()) {
      if (isTerminalOrderState(order.state)) continue;
      try {
        await this.opts.oms.cancel(order.clientOrderId);
        cancelled++;
      } catch (err) {
        this.journal('diag.error', { where: 'killswitch.cancel', message: String(err) });
      }
    }

    // 3. Flatten every open position through the gate's exit lane.
    let flattened = 0;
    for (const pos of this.opts.oms.getPositions()) {
      if (pos.state === 'CLOSED' || pos.qty <= 0) continue;
      const intent = this.exitIntent(pos, reason);
      this.journal('intent.proposed', { intent });
      const verdict = this.opts.gate.evaluate(intent, this.opts.gateContext());
      this.journal('risk.verdict', { verdict });
      if (!verdict.approved) {
        this.journal('diag.error', {
          where: 'killswitch.flatten',
          message: `gate rejected KILL exit: ${verdict.reason ?? 'unknown'}`,
        });
        continue;
      }
      try {
        const result = await this.opts.oms.submit(intent, verdict);
        if (result.accepted) flattened++;
      } catch (err) {
        this.journal('diag.error', { where: 'killswitch.flatten', message: String(err) });
      }
    }

    this.mode = 'LOCKED';
    const durationMs = this.clock.now() - started;
    this.journal('kill.completed', { durationMs, cancelledOrders: cancelled, flattenedPositions: flattened });
    this.opts.notify?.('TRIPPED', reason);
    return {
      state: this.mode,
      alreadyTripped: false,
      reason,
      durationMs,
      cancelledOrders: cancelled,
      flattenedPositions: flattened,
    };
  }

  /** Typed confirmation required: confirm === 'REARM' and a non-empty reason. */
  rearm(confirm: string, reason: string): { accepted: boolean; reason?: string } {
    if (this.mode !== 'LOCKED') return { accepted: false, reason: 'NOT_LOCKED' };
    if (confirm !== 'REARM' || reason.trim().length === 0) {
      return { accepted: false, reason: 'CONFIRMATION_REQUIRED' };
    }
    this.mode = 'READY';
    this.tripReason = undefined;
    this.rejectTs = [];
    this.journal('kill.rearmed', { reason });
    this.opts.notify?.('REARMED', reason);
    return { accepted: true };
  }

  // ------------------------------------------------------------ self-test

  /**
   * Preflight self-test (dry): proves the kill path is executable — ports
   * readable, a KILL exit intent for a whitelisted instrument passes the
   * gate, clock sane. Runs every session start; failure must block ARM.
   */
  selfTest(): { ok: boolean; checks: SelfTestCheck[] } {
    const checks: SelfTestCheck[] = [];
    const push = (name: string, fn: () => boolean, detail?: string): void => {
      try {
        checks.push({ name, ok: fn(), ...(detail !== undefined ? { detail } : {}) });
      } catch (err) {
        checks.push({ name, ok: false, detail: String(err) });
      }
    };

    push('oms.orders.readable', () => Array.isArray(this.opts.oms.getOrders()));
    push('oms.positions.readable', () => Array.isArray(this.opts.oms.getPositions()));
    push('clock.sane', () => this.clock.now() > 0);
    push('gate.approves.kill.exit', () => {
      const ctx = this.opts.gateContext();
      const instrumentId = ctx.allowedInstruments.values().next().value as InstrumentId | undefined;
      if (instrumentId === undefined) return false;
      const fake: Position = {
        positionId: this.opts.ids.positionId(),
        sessionId: this.opts.sessionId,
        strategyId: 'selftest',
        instrumentId,
        side: 'BUY',
        qty: this.opts.market.contract.lotSize,
        avgEntryPricePaise: 10_000,
        state: 'OPEN',
        realizedGrossPaise: 0,
        openedTs: this.clock.now(),
        updatedTs: this.clock.now(),
      };
      return this.opts.gate.evaluate(this.exitIntent(fake, 'SELF_TEST'), ctx).approved;
    });

    return { ok: checks.every((c) => c.ok), checks };
  }

  // ------------------------------------------------------------ internals

  private exitIntent(pos: Position, reason: string): OrderIntent {
    const mark = this.opts.markPrice(pos.instrumentId);
    const tick = this.opts.market.tickSizePaise;
    const hasMark = mark !== undefined && mark > 0;
    return {
      intentId: this.opts.ids.intentId(),
      sessionId: this.opts.sessionId,
      strategyId: pos.strategyId,
      ts: this.clock.now(),
      side: 'SELL',
      instrumentId: pos.instrumentId,
      qty: pos.qty,
      // With a mark: aggressive protect-limit that crosses the spread.
      // Without one: pure market — getting flat beats price improvement.
      type: hasMark ? 'LIMIT' : 'MARKET_PROTECT',
      ...(hasMark ? { limitPricePaise: Math.max(tick, mark - this.protectTicks * tick) } : {}),
      protectTicks: this.protectTicks,
      ttlMs: 2_000,
      tag: `kill:${reason}`,
      purpose: 'KILL',
    };
  }

  private journal<K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void {
    this.opts.journal?.(type, payload);
  }
}
