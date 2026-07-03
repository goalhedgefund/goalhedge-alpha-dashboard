import { systemClock, type Clock } from '../domain/time.js';

export interface TokenBucketOptions {
  capacity: number;
  refillPerSec: number;
  clock?: Clock;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock: Clock;
  private tokens: number;
  private lastRefillMs: number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.refillPerMs = opts.refillPerSec / 1000;
    this.clock = opts.clock ?? systemClock;
    this.tokens = opts.capacity;
    this.lastRefillMs = this.clock.now();
  }

  tryTake(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = Math.max(0, now - this.lastRefillMs);
    if (elapsed === 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = now;
  }
}
