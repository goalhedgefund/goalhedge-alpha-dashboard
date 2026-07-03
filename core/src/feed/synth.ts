import type { InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import type { IFeedAdapter, FeedHealth, SubscribeRequest } from './interface.js';
import { ManualClock, systemClock, type Clock } from '../domain/time.js';

/** Synthetic market regime. */
export type SynthRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'CHOPPY' | 'GAPPING';

export interface SynthFeedOptions {
  instrumentId: InstrumentId;
  /** Starting price in paise. */
  initialPricePaise: number;
  /** Spread in ticks (each tick = 5p for NIFTY options). */
  spreadTicks?: number;
  tickSizePaise?: number;
  /** Volatility: std dev of the per-tick return (fraction). */
  sigma?: number;
  /** Trend per-tick drift (fraction). Applied every tick. */
  drift?: number;
  /** Starting regime. */
  regime?: SynthRegime;
  /** Regime switch probability per tick. */
  regimeSwitchProb?: number;
  seed?: number;
  clock?: Clock;
  /** ms between generated ticks (default 200). */
  tickIntervalMs?: number;
}

/** mulberry32 seeded PRNG — deterministic across platforms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform → standard normal sample. */
function randn(rng: () => number): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Generates a deterministic synthetic tick stream for dev/testing.
 * The stream is configurable by regime and volatility — useful for
 * hitting specific scenarios (gap-through-stop, trend, chop) without
 * needing market data or market hours.
 */
export class SynthFeed implements IFeedAdapter {
  readonly adapterId = 'synth';
  private handler: ((tick: Tick) => void) | undefined;
  private readonly rng: () => number;
  private readonly clock: Clock;
  private readonly opts: Required<Omit<SynthFeedOptions, 'clock'>>;
  private pricePaise: number;
  private regime: SynthRegime;
  private totalVolume = 0;
  private emitted = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: SynthFeedOptions) {
    this.rng = mulberry32(opts.seed ?? 42);
    this.clock = opts.clock ?? systemClock;
    this.opts = {
      instrumentId: opts.instrumentId,
      initialPricePaise: opts.initialPricePaise,
      spreadTicks: opts.spreadTicks ?? 2,
      tickSizePaise: opts.tickSizePaise ?? 5,
      sigma: opts.sigma ?? 0.0008,
      drift: opts.drift ?? 0,
      regime: opts.regime ?? 'CHOPPY',
      regimeSwitchProb: opts.regimeSwitchProb ?? 0.005,
      seed: opts.seed ?? 42,
      tickIntervalMs: opts.tickIntervalMs ?? 200,
    };
    this.pricePaise = opts.initialPricePaise;
    this.regime = opts.regime ?? 'CHOPPY';
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(_r: SubscribeRequest[]): void {}


  setTickHandler(cb: (tick: Tick) => void): void {
    this.handler = cb;
  }

  health(): FeedHealth {
    return { status: 'CONNECTED', lastTickTs: 0, tickRatePerSec: 0 };
  }

  close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    return Promise.resolve();
  }

  /** Emit N ticks synchronously into the registered handler. */
  generateTicks(count: number): Tick[] {
    const ticks: Tick[] = [];
    for (let i = 0; i < count; i++) {
      const tick = this.nextTick();
      ticks.push(tick);
      this.handler?.(tick);
    }
    return ticks;
  }

  private nextTick(): Tick {
    const { spreadTicks, tickSizePaise, sigma, drift, regimeSwitchProb, instrumentId } = this.opts;
    const spreadPaise = spreadTicks * tickSizePaise;
    const ts = this.clock.now();

    // Possibly switch regime.
    if (this.rng() < regimeSwitchProb) {
      const regimes: SynthRegime[] = ['TRENDING_UP', 'TRENDING_DOWN', 'CHOPPY', 'GAPPING'];
      this.regime = regimes[Math.floor(this.rng() * regimes.length)] as SynthRegime;
    }

    let move = randn(this.rng) * sigma * this.pricePaise;
    let extra = 0;
    switch (this.regime) {
      case 'TRENDING_UP':
        extra = drift * this.pricePaise + Math.abs(move) * 0.3;
        break;
      case 'TRENDING_DOWN':
        extra = -drift * this.pricePaise - Math.abs(move) * 0.3;
        break;
      case 'GAPPING':
        move = move * 5;
        break;
      default:
        break;
    }

    this.pricePaise = Math.max(tickSizePaise, Math.round(this.pricePaise + move + extra));
    // Snap to tick grid.
    this.pricePaise = Math.round(this.pricePaise / tickSizePaise) * tickSizePaise;

    const ltpPaise = this.pricePaise;
    const bidPaise = ltpPaise - Math.floor(spreadPaise / 2);
    const askPaise = ltpPaise + Math.ceil(spreadPaise / 2);
    const qty = (1 + Math.floor(this.rng() * 10)) * 65;
    this.totalVolume += qty;

    const tick: Tick = {
      instrumentId,
      ts,
      recvTs: ts + 1,
      ltpPaise,
      qty,
      volume: this.totalVolume,
      bidPaise: Math.max(tickSizePaise, bidPaise),
      askPaise,
      bidQty: (1 + Math.floor(this.rng() * 5)) * 65,
      askQty: (1 + Math.floor(this.rng() * 5)) * 65,
    };
    this.emitted++;
    if (this.clock instanceof ManualClock) this.clock.advance(1);
    return tick;
  }

  /** Start emitting ticks at `tickIntervalMs` via setInterval. */
  startLive(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      const tick = this.nextTick();
      this.handler?.(tick);
    }, this.opts.tickIntervalMs);
    this.timer.unref();
  }

  get ticksEmitted(): number {
    return this.emitted;
  }
}
