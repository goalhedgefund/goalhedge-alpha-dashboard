import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import type { SessionId, SessionMode } from '../domain/ids.js';
import type { PreflightCheck, SessionPhase, SessionState } from '../domain/session.js';
import { formatHHMMIst, systemClock, type Clock } from '../domain/time.js';
import type { WeeklyChainResult } from '../marketdata/instrument-master.js';
import {
  cancelAllOpenOrders,
  flattenAllPositions,
  type FlattenPorts,
} from '../oms/flatten.js';

export type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

/** A loaded, hashed config to be journaled as `config.loaded` at preflight. */
export interface LoadedConfigRef {
  name: string;
  hash: string;
  path: string;
}

/**
 * The dependency probes the preflight checklist calls. Each is a thin
 * closure the wiring supplies; the session module owns none of them.
 */
export interface PreflightProbes {
  /** Instrument master → resolved NIFTY weekly chain (undefined = not loaded). */
  resolveChain: () => WeeklyChainResult | undefined;
  /** Timestamp (epoch ms) of the last normalized tick, 0 if none yet. */
  lastTickTs: () => number;
  /** Max tolerated tick age at preflight before the feed is deemed stale. */
  feedStaleMs: number;
  /** Kill switch dry self-test — proves the exit path is executable. */
  killSelfTest: () => { ok: boolean; checks: PreflightCheck[] };
  /** Resolves iff the journal file is open and writable. */
  journalReady: () => Promise<void>;
  /** Loaded config descriptors: each journaled `config.loaded`, each a check. */
  configs: ReadonlyArray<LoadedConfigRef>;
}

export interface SessionManagerOptions {
  sessionId: SessionId;
  mode: SessionMode;
  /** Trading date YYYY-MM-DD (IST). */
  date: string;
  market: MarketProfile;
  /** Strategy target disarmed at square-off / halt (never re-armed by us). */
  target: { disarm(): void };
  /**
   * Shared flatten ports for the SQUARE_OFF path. Reuses the exact helper the
   * kill switch uses, but with purpose SQUARE_OFF — which does NOT lock the
   * session (only a kill locks).
   */
  flattenPorts: () => FlattenPorts;
  preflight: PreflightProbes;
  clock?: Clock;
  journal?: JournalSink;
  notify?: (event: 'PHASE', phase: SessionPhase) => void;
}

export interface SquareOffReport {
  cancelledOrders: number;
  flattenedPositions: number;
}

export interface ArmReadiness {
  ok: boolean;
  reason?: string;
}

/**
 * Session lifecycle & scheduler (02-CODING-PLAN M9, 01-DESIGN §9).
 *
 * Owns the phase machine (PREFLIGHT → OPEN → ENTRY_CUTOFF → SQUARE_OFF →
 * CLOSED, plus HALTED / KILLED), the preflight checklist that gates ARM, and
 * the wall-clock scheduler that fires the entry cutoff and the hard
 * square-off. It calls INTO the kill switch (self-test) but the kill switch
 * never calls back — dependency stays one-directional.
 *
 * Preflight is two gates: the technical checks (instrument master, feed
 * freshness, config hashes, kill self-test, journal writable) AND an explicit
 * operator acknowledgement (ACK_PREFLIGHT). ARM is refused until both pass and
 * the session is OPEN.
 */
export class SessionManager {
  private phaseValue: SessionPhase = 'PREFLIGHT';
  private readonly clock: Clock;
  private readonly startedTs: number;
  private readonly configHashes: Record<string, string>;

  private started = false;
  private checks: PreflightCheck[] = [];
  private technicalOk = false;
  private preflightRan = false;
  private acked = false;
  private squareOffStarted = false;
  private squareOffCancelled = 0;
  private squareOffFlattened = 0;

  constructor(private readonly opts: SessionManagerOptions) {
    this.clock = opts.clock ?? systemClock;
    this.startedTs = this.clock.now();
    this.configHashes = Object.fromEntries(opts.preflight.configs.map((c) => [c.name, c.hash]));
  }

  phase(): SessionPhase {
    return this.phaseValue;
  }

  state(): SessionState {
    return {
      sessionId: this.opts.sessionId,
      mode: this.opts.mode,
      date: this.opts.date,
      phase: this.phaseValue,
      configHashes: { ...this.configHashes },
      startedTs: this.startedTs,
    };
  }

  /** The full checklist for the UI: technical checks + the operator ACK. */
  preflightChecks(): PreflightCheck[] {
    return [...this.checks, { name: 'operator.ack', ok: this.acked }];
  }

  // ---------------------------------------------------------------- preflight

  /**
   * Run the preflight checklist. Journals `session.started` (once), a
   * `config.loaded` per config, and one `session.preflight` with every named
   * check. Returns the technical result; ARM still additionally requires the
   * operator ACK. Never throws — a probe that throws becomes a failed check.
   */
  async runPreflight(): Promise<{ ok: boolean; checks: PreflightCheck[] }> {
    this.begin();
    const checks: PreflightCheck[] = [];

    // 1. Instrument master loaded + weekly expiry resolved.
    try {
      const chain = this.opts.preflight.resolveChain();
      if (chain === undefined || chain.rowCount <= 0) {
        checks.push({ name: 'instrument.master', ok: false, detail: 'weekly chain unresolved' });
      } else {
        checks.push({ name: 'instrument.master', ok: true, detail: `expiry ${chain.expiryDate} (${chain.rowCount} rows)` });
      }
    } catch (err) {
      checks.push({ name: 'instrument.master', ok: false, detail: String(err) });
    }

    // 2. Feed freshness (last tick age vs clock).
    const lastTick = this.opts.preflight.lastTickTs();
    const age = this.clock.now() - lastTick;
    const feedOk = lastTick > 0 && age <= this.opts.preflight.feedStaleMs;
    checks.push({
      name: 'feed.fresh',
      ok: feedOk,
      detail: lastTick > 0 ? `${age}ms old` : 'no tick yet',
    });

    // 3. Config hashes journaled (config.loaded ×N).
    for (const cfg of this.opts.preflight.configs) {
      this.journal('config.loaded', {
        sessionId: this.opts.sessionId,
        name: cfg.name,
        hash: cfg.hash,
        path: cfg.path,
      });
      checks.push({ name: `config.loaded:${cfg.name}`, ok: cfg.hash.length > 0, detail: cfg.hash.slice(0, 12) });
    }

    // 4. Kill switch self-test (proves the exit path is executable).
    try {
      const kill = this.opts.preflight.killSelfTest();
      const failed = kill.checks.filter((c) => !c.ok).map((c) => c.name);
      checks.push({
        name: 'kill.selftest',
        ok: kill.ok,
        ...(failed.length > 0 ? { detail: `failed: ${failed.join(', ')}` } : {}),
      });
    } catch (err) {
      checks.push({ name: 'kill.selftest', ok: false, detail: String(err) });
    }

    // 5. Journal disk writable.
    try {
      await this.opts.preflight.journalReady();
      checks.push({ name: 'journal.writable', ok: true });
    } catch (err) {
      checks.push({ name: 'journal.writable', ok: false, detail: String(err) });
    }

    this.checks = checks;
    this.technicalOk = checks.every((c) => c.ok);
    this.preflightRan = true;
    this.journal('session.preflight', { sessionId: this.opts.sessionId, ok: this.technicalOk, checks });
    return { ok: this.technicalOk, checks };
  }

  /**
   * Operator acknowledgement of the preflight checklist (ACK_PREFLIGHT). Only
   * meaningful once the technical checks have passed. Once acked and the
   * market is open, the session promotes itself to OPEN.
   */
  acknowledge(operator?: string): { accepted: boolean; reason?: string } {
    if (!this.preflightRan) return { accepted: false, reason: 'PREFLIGHT_NOT_RUN' };
    if (!this.technicalOk) return { accepted: false, reason: 'PREFLIGHT_FAILED' };
    if (this.phaseValue === 'HALTED' || this.phaseValue === 'KILLED') {
      return { accepted: false, reason: this.phaseValue };
    }
    this.acked = true;
    this.maybeOpen(this.clock.now());
    return { accepted: true, reason: operator !== undefined ? `acked:${operator}` : this.phaseValue };
  }

  /** ARM gate: both preflight gates must pass and the session must be OPEN. */
  canArm(): ArmReadiness {
    if (this.phaseValue === 'HALTED') return { ok: false, reason: 'SESSION_HALTED' };
    if (this.phaseValue === 'KILLED') return { ok: false, reason: 'KILL_LOCKED' };
    if (this.phaseValue === 'SQUARE_OFF' || this.phaseValue === 'CLOSED') {
      return { ok: false, reason: 'SESSION_CLOSED' };
    }
    if (!this.preflightRan || !this.technicalOk) return { ok: false, reason: 'PREFLIGHT_FAILED' };
    if (!this.acked) return { ok: false, reason: 'PREFLIGHT_NOT_ACKED' };
    if (this.phaseValue !== 'OPEN') return { ok: false, reason: 'NOT_OPEN' };
    return { ok: true };
  }

  // --------------------------------------------------------------- scheduler

  /**
   * Drive the wall-clock phase machine. Call on the timer cadence. Promotes
   * PREFLIGHT → OPEN at market open (once ready), OPEN → ENTRY_CUTOFF at the
   * entry cutoff, and fires the hard square-off. Idempotent per phase.
   */
  async onTimer(nowMs: number): Promise<void> {
    const hhmm = formatHHMMIst(nowMs);
    const { entryCutoff, hardSquareOff } = this.opts.market;

    if (this.phaseValue === 'PREFLIGHT') this.maybeOpen(nowMs);

    if (hhmm >= hardSquareOff) {
      if (this.phaseValue === 'OPEN' || this.phaseValue === 'ENTRY_CUTOFF') {
        await this.squareOff();
      } else if (this.phaseValue === 'SQUARE_OFF') {
        // Exits still working: retry any position that lost its exit (the
        // flatten helper skips positions already being chased), then close
        // only once the book is actually flat.
        const ports = this.opts.flattenPorts();
        this.squareOffFlattened += await flattenAllPositions(ports, 'SQUARE_OFF', 'squareoff:retry');
        this.completeSquareOffIfFlat();
      }
      return;
    }

    if (this.phaseValue === 'OPEN' && hhmm >= entryCutoff) {
      this.transitionTo('ENTRY_CUTOFF', 'entry cutoff');
    }
  }

  /**
   * Flatten every open position under purpose SQUARE_OFF and close the
   * session. Does NOT lock — square-off is routine, not a kill. Idempotent.
   *
   * CLOSED is only claimed once the book is ACTUALLY flat: with instant paper
   * fills that is immediately; with real fill latency the phase stays
   * SQUARE_OFF and onTimer retries/verifies until flat — the session never
   * reports "closed" while positions are still live.
   */
  async squareOff(): Promise<SquareOffReport> {
    if (this.squareOffStarted) {
      this.completeSquareOffIfFlat();
      return { cancelledOrders: 0, flattenedPositions: 0 };
    }
    this.squareOffStarted = true;
    this.transitionTo('SQUARE_OFF', 'hard square-off');
    this.opts.target.disarm();

    const ports = this.opts.flattenPorts();
    const cancelledOrders = await cancelAllOpenOrders(ports);
    const flattenedPositions = await flattenAllPositions(ports, 'SQUARE_OFF', 'squareoff');
    this.squareOffCancelled += cancelledOrders;
    this.squareOffFlattened += flattenedPositions;

    this.completeSquareOffIfFlat();
    return { cancelledOrders, flattenedPositions };
  }

  // ------------------------------------------------------------------- halts

  /** Safe-halt: stop entries, block ARM. Used by recovery + journal-failure. */
  halt(reason: string): void {
    if (this.phaseValue === 'CLOSED') return;
    this.transitionTo('HALTED', reason);
    this.opts.target.disarm();
  }

  /**
   * Reflect a kill switch transition into the phase. Wired via the kill
   * switch's `notify` callback so the kill module never imports the session.
   */
  onKill(event: 'TRIPPED' | 'REARMED'): void {
    if (event === 'TRIPPED') {
      this.transitionTo('KILLED', 'kill switch tripped');
    } else if (this.phaseValue === 'KILLED') {
      // Re-armed: back to OPEN; onTimer reconciles the phase to wall time.
      this.transitionTo('OPEN', 'kill switch re-armed');
    }
  }

  // --------------------------------------------------------------- internals

  private begin(): void {
    if (this.started) return;
    this.started = true;
    this.journal('session.started', { session: this.state() });
  }

  private isFlat(): boolean {
    return this.opts
      .flattenPorts()
      .oms.getPositions()
      .every((p) => p.state === 'CLOSED' || p.qty <= 0);
  }

  /** SQUARE_OFF → CLOSED, but only when every position is really flat. */
  private completeSquareOffIfFlat(): void {
    if (this.phaseValue !== 'SQUARE_OFF' || !this.isFlat()) return;
    this.transitionTo('CLOSED', 'square-off complete');
    this.journal('session.closed', {
      sessionId: this.opts.sessionId,
      summary: { cancelledOrders: this.squareOffCancelled, flattenedPositions: this.squareOffFlattened },
    });
  }

  private maybeOpen(nowMs: number): void {
    if (this.phaseValue !== 'PREFLIGHT' || !this.technicalOk || !this.acked) return;
    const hhmm = formatHHMMIst(nowMs);
    if (hhmm >= this.opts.market.hardSquareOff) return; // too late to open a session
    if (hhmm < this.opts.market.session.open) return; // not open yet
    this.transitionTo('OPEN');
  }

  private transitionTo(next: SessionPhase, reason?: string): void {
    if (this.phaseValue === next) return;
    this.phaseValue = next;
    this.journal('session.phase', {
      sessionId: this.opts.sessionId,
      phase: next,
      ...(reason !== undefined ? { reason } : {}),
    });
    this.opts.notify?.('PHASE', next);
  }

  private journal<K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void {
    this.opts.journal?.(type, payload);
  }
}
