import type { InstrumentId } from '../domain/ids.js';
import type { Bar, Tick, Timeframe } from '../domain/marketdata.js';

/**
 * Builds 1-second and 1-minute bars from a tick stream.
 * Each finished bar is delivered to the registered callback.
 * Late ticks (tick.ts < current bar's startTs) are assigned to the current
 * bar rather than the past — the bar timestamp is determined by the first
 * tick, not wall time.
 */
export class BarBuilder {
  private bars = new Map<Timeframe, Bar | null>([
    ['1s', null],
    ['1m', null],
  ]);

  private readonly windowMs: Record<Timeframe, number> = {
    '1s': 1_000,
    '1m': 60_000,
  };

  constructor(
    private readonly instrumentId: InstrumentId,
    private readonly onBar: (bar: Bar) => void,
  ) {}

  onTick(tick: Tick): void {
    for (const tf of ['1s', '1m'] as Timeframe[]) {
      this.update(tick, tf);
    }
  }

  private update(tick: Tick, tf: Timeframe): void {
    const windowMs = this.windowMs[tf];
    let bar = this.bars.get(tf) ?? null;
    const barStart = Math.floor(tick.ts / windowMs) * windowMs;

    if (bar === null || barStart > bar.startTs) {
      if (bar !== null) this.onBar(bar);
      bar = {
        instrumentId: this.instrumentId,
        tf,
        startTs: barStart,
        o: tick.ltpPaise,
        h: tick.ltpPaise,
        l: tick.ltpPaise,
        c: tick.ltpPaise,
        volume: tick.qty,
        tickCount: 1,
      };
    } else {
      bar = {
        ...bar,
        h: Math.max(bar.h, tick.ltpPaise),
        l: Math.min(bar.l, tick.ltpPaise),
        c: tick.ltpPaise,
        volume: bar.volume + tick.qty,
        tickCount: bar.tickCount + 1,
      };
    }
    this.bars.set(tf, bar);
  }

  /** Force-close any open bar (call at end-of-session). */
  flush(): void {
    for (const [tf, bar] of this.bars) {
      if (bar !== null) {
        this.onBar(bar);
        this.bars.set(tf, null);
      }
    }
  }
}
