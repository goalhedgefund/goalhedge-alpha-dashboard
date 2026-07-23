import { describe, expect, it } from 'vitest';
import { FeedRecoveryRearm } from '../src/killswitch/auto-rearm.js';

const T0 = 1_000_000;

function make(): FeedRecoveryRearm {
  return new FeedRecoveryRearm({ stableMs: 60_000, maxPerDay: 2, feedFreshMs: 5_000 });
}

describe('FeedRecoveryRearm', () => {
  it('only ever considers a LOCKED FEED_STALE trip', () => {
    const rearm = make();
    expect(rearm.poll(T0, 'READY', undefined, T0)).toBeUndefined();
    expect(rearm.poll(T0, 'TRIPPING', 'FEED_STALE', T0)).toBeUndefined();
    expect(rearm.poll(T0, 'LOCKED', 'RECON_MISMATCH', T0)).toBeUndefined();
    expect(rearm.poll(T0, 'LOCKED', 'REJECT_STORM', T0)).toBeUndefined();
    // Even after a full stable window, a non-feed reason never auto-rearms.
    expect(rearm.poll(T0 + 120_000, 'LOCKED', 'MANUAL', T0 + 120_000)).toBeUndefined();
  });

  it('requires the feed to stay fresh for the whole stable window', () => {
    const rearm = make();
    expect(rearm.poll(T0, 'LOCKED', 'FEED_STALE', T0 - 60_000)).toBeUndefined(); // still silent
    expect(rearm.poll(T0 + 10_000, 'LOCKED', 'FEED_STALE', T0 + 10_000)).toBeUndefined(); // window opens
    expect(rearm.poll(T0 + 40_000, 'LOCKED', 'FEED_STALE', T0 + 40_000)).toBeUndefined(); // 30s in
    expect(rearm.poll(T0 + 70_000, 'LOCKED', 'FEED_STALE', T0 + 70_000)).toBe('AUTO_FEED_RECOVERY 1/2');
  });

  it('resets the stability window when the feed flaps mid-recovery', () => {
    const rearm = make();
    expect(rearm.poll(T0, 'LOCKED', 'FEED_STALE', T0)).toBeUndefined(); // window opens
    // 30s later the last tick is 20s old → flap: window must reset.
    expect(rearm.poll(T0 + 30_000, 'LOCKED', 'FEED_STALE', T0 + 10_000)).toBeUndefined();
    // Fresh again: a full new window is required from here.
    expect(rearm.poll(T0 + 40_000, 'LOCKED', 'FEED_STALE', T0 + 40_000)).toBeUndefined();
    expect(rearm.poll(T0 + 90_000, 'LOCKED', 'FEED_STALE', T0 + 90_000)).toBeUndefined(); // only 50s
    expect(rearm.poll(T0 + 101_000, 'LOCKED', 'FEED_STALE', T0 + 101_000)).toBe('AUTO_FEED_RECOVERY 1/2');
  });

  it('caps auto re-arms per session; beyond the cap the lock is operator-only', () => {
    const rearm = make();
    expect(rearm.poll(T0, 'LOCKED', 'FEED_STALE', T0)).toBeUndefined();
    expect(rearm.poll(T0 + 60_000, 'LOCKED', 'FEED_STALE', T0 + 60_000)).toBe('AUTO_FEED_RECOVERY 1/2');
    // Second trip later in the day.
    const t2 = T0 + 600_000;
    expect(rearm.poll(t2, 'LOCKED', 'FEED_STALE', t2)).toBeUndefined();
    expect(rearm.poll(t2 + 60_000, 'LOCKED', 'FEED_STALE', t2 + 60_000)).toBe('AUTO_FEED_RECOVERY 2/2');
    // Third trip: stays locked no matter how stable the feed is.
    const t3 = t2 + 600_000;
    expect(rearm.poll(t3, 'LOCKED', 'FEED_STALE', t3)).toBeUndefined();
    expect(rearm.poll(t3 + 300_000, 'LOCKED', 'FEED_STALE', t3 + 300_000)).toBeUndefined();
    expect(rearm.usedCount()).toBe(2);
  });
});
