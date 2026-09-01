import type { RiskProfile } from '../config/schemas.js';
import type { SessionStopKind } from '../domain/risk.js';
import { systemClock, type Clock } from '../domain/time.js';

export interface SessionRiskSnapshot {
  realizedNetPnlPaise: number;
  peakNetPnlPaise: number;
  lossStreak: number;
  tradesTaken: number;
  latchedStop?: SessionStopKind;
}

export class SessionRiskState {
  private lossStreakDisabled = false;
  /** When the current LOSS_STREAK latch was applied, for cooldown expiry. */
  private lossStreakLatchedAtMs: number | undefined;
  /** Set when a cooldown elapses, so the host can journal the resume once. */
  private lossStreakResumePending = false;
  private snapshot: SessionRiskSnapshot = {
    realizedNetPnlPaise: 0,
    peakNetPnlPaise: 0,
    lossStreak: 0,
    tradesTaken: 0,
  };

  constructor(
    private readonly profile: RiskProfile,
    private readonly clock: Clock = systemClock,
  ) {}

  recordTrade(netPnlPaise: number): SessionRiskSnapshot {
    this.expireLossStreakCooldown();
    this.snapshot = {
      ...this.snapshot,
      realizedNetPnlPaise: this.snapshot.realizedNetPnlPaise + netPnlPaise,
      tradesTaken: this.snapshot.tradesTaken + 1,
      lossStreak: netPnlPaise < 0 ? this.snapshot.lossStreak + 1 : 0,
    };
    this.snapshot.peakNetPnlPaise = Math.max(this.snapshot.peakNetPnlPaise, this.snapshot.realizedNetPnlPaise);
    this.evaluateLatches();
    return this.current();
  }

  latch(kind: SessionStopKind): void {
    this.snapshot = { ...this.snapshot, latchedStop: kind };
    if (kind === 'LOSS_STREAK') this.lossStreakLatchedAtMs = this.clock.now();
  }

  operatorReset(): void {
    const { latchedStop: _latchedStop, ...rest } = this.snapshot;
    // A lockout reset is a fresh loss-streak window. Keep realised P&L,
    // peak P&L, and the daily trade count for all other risk limits.
    this.snapshot = { ...rest, lossStreak: 0 };
    this.lossStreakLatchedAtMs = undefined;
    this.lossStreakResumePending = false;
  }

  disableLossStreak(): void {
    this.lossStreakDisabled = true;
  }

  current(): SessionRiskSnapshot {
    this.expireLossStreakCooldown();
    return { ...this.snapshot };
  }

  /**
   * True exactly once after a LOSS_STREAK cooldown elapses, so the host can
   * journal the resume. Consuming it is what makes the transition observable —
   * without it the journal shows a stop and never a restart.
   */
  takeLossStreakResume(): boolean {
    this.expireLossStreakCooldown();
    const pending = this.lossStreakResumePending;
    this.lossStreakResumePending = false;
    return pending;
  }

  /**
   * LOSS_STREAK is a cooling-off period, not a session kill: `lossStreak.cooldownMin`
   * states how long the desk sits out. Every other latch — DAILY_LOSS, GIVE_BACK,
   * MAX_TRADES — stays terminal for the session.
   *
   * Expiry is lazy rather than polled so that every reader (risk gate, runners,
   * gateway) observes the same state with no ordering hazard between a timer
   * tick and an entry decision. The streak counter resets with the latch;
   * otherwise the next single loss would re-latch immediately.
   *
   * On crash recovery the replayed latch is stamped with the recovery time, not
   * the original, so a recovered desk serves a full fresh cooldown. Deliberately
   * the conservative direction.
   */
  private expireLossStreakCooldown(): void {
    if (this.snapshot.latchedStop !== 'LOSS_STREAK') return;
    if (this.lossStreakLatchedAtMs === undefined) return;
    const elapsedMs = this.clock.now() - this.lossStreakLatchedAtMs;
    if (elapsedMs < this.profile.lossStreak.cooldownMin * 60_000) return;
    const { latchedStop: _latchedStop, ...rest } = this.snapshot;
    this.snapshot = { ...rest, lossStreak: 0 };
    this.lossStreakLatchedAtMs = undefined;
    this.lossStreakResumePending = true;
  }

  private evaluateLatches(): void {
    if (this.snapshot.latchedStop !== undefined) return;
    const capital = this.profile.capitalPaise;
    if (this.snapshot.realizedNetPnlPaise <= -Math.round(capital * (this.profile.dailyMaxLossPct / 100))) {
      this.latch('DAILY_LOSS');
      return;
    }
    const armAt = Math.round(capital * (this.profile.giveBack.armAtPct / 100));
    if (this.snapshot.peakNetPnlPaise >= armAt) {
      const retained = this.snapshot.peakNetPnlPaise === 0 ? 0 : this.snapshot.realizedNetPnlPaise / this.snapshot.peakNetPnlPaise;
      if (retained < this.profile.giveBack.retainPct / 100) {
        this.latch('GIVE_BACK');
        return;
      }
    }
    if (!this.lossStreakDisabled && this.snapshot.lossStreak >= this.profile.lossStreak.count) {
      this.latch('LOSS_STREAK');
      return;
    }
    if (this.snapshot.tradesTaken >= this.profile.maxTradesPerDay) this.latch('MAX_TRADES');
  }
}
