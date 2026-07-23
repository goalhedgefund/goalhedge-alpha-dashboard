import type { RiskProfile } from '../config/schemas.js';
import type { SessionStopKind } from '../domain/risk.js';

export interface SessionRiskSnapshot {
  realizedNetPnlPaise: number;
  peakNetPnlPaise: number;
  lossStreak: number;
  tradesTaken: number;
  latchedStop?: SessionStopKind;
}

export class SessionRiskState {
  private lossStreakDisabled = false;
  private snapshot: SessionRiskSnapshot = {
    realizedNetPnlPaise: 0,
    peakNetPnlPaise: 0,
    lossStreak: 0,
    tradesTaken: 0,
  };

  constructor(private readonly profile: RiskProfile) {}

  recordTrade(netPnlPaise: number): SessionRiskSnapshot {
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
  }

  operatorReset(): void {
    const { latchedStop: _latchedStop, ...rest } = this.snapshot;
    // A lockout reset is a fresh loss-streak window. Keep realised P&L,
    // peak P&L, and the daily trade count for all other risk limits.
    this.snapshot = { ...rest, lossStreak: 0 };
  }

  disableLossStreak(): void {
    this.lossStreakDisabled = true;
  }

  current(): SessionRiskSnapshot {
    return { ...this.snapshot };
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
