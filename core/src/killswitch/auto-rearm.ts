import type { KillState } from './kill-switch.js';

export interface FeedRecoveryRearmOptions {
  /** Feed must be continuously fresh this long before a re-arm fires. */
  stableMs: number;
  /** Auto re-arms allowed per session; beyond this the LOCK is operator-only. */
  maxPerDay: number;
  /** A tick within this window counts as a fresh feed (match feedStaleMs). */
  feedFreshMs: number;
}

/**
 * Automatic recovery policy for FEED_STALE kill trips ONLY.
 *
 * A feed-stale trip has already flattened every position — the lock is
 * protecting nothing but re-entry. Once the feed streams again and stays
 * fresh for stableMs, the desk may re-arm itself: new entries still have to
 * re-qualify through the regime gate, spread/liquidity gates, and cooldowns.
 *
 * Every other trip reason (RECON_MISMATCH, REJECT_STORM, WATCHDOG,
 * CLOCK_SKEW, MANUAL, …) states something the feed's return does not repair —
 * those stay operator-only, as does a feed that flaps more than maxPerDay
 * times. This class only decides; the host performs the actual rearm so the
 * KillSwitch's typed-confirmation contract stays intact and journaled.
 */
export class FeedRecoveryRearm {
  private used = 0;
  private recoveredSinceMs: number | undefined;

  constructor(private readonly opts: FeedRecoveryRearmOptions) {}

  usedCount(): number {
    return this.used;
  }

  /** Call on the timer cadence. Returns the rearm reason when due, else undefined. */
  poll(nowMs: number, killState: KillState, tripReason: string | undefined, lastTickTs: number): string | undefined {
    if (killState !== 'LOCKED' || tripReason !== 'FEED_STALE') {
      this.recoveredSinceMs = undefined;
      return undefined;
    }
    if (this.used >= this.opts.maxPerDay) return undefined;
    const fresh = lastTickTs > 0 && nowMs - lastTickTs <= this.opts.feedFreshMs;
    if (!fresh) {
      this.recoveredSinceMs = undefined;
      return undefined;
    }
    this.recoveredSinceMs ??= nowMs;
    if (nowMs - this.recoveredSinceMs < this.opts.stableMs) return undefined;
    this.used++;
    this.recoveredSinceMs = undefined;
    return `AUTO_FEED_RECOVERY ${this.used}/${this.opts.maxPerDay}`;
  }
}
