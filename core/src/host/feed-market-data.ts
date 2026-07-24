import type { InstrumentId } from '../domain/ids.js';
import type { Instrument, OptionRight } from '../domain/instrument.js';
import type { Bar, OptionChainRow, Tick } from '../domain/marketdata.js';
import { BarBuilder } from '../feed/bar-builder.js';
import { computeOptionFeatures, computeUnderlyingFeatures } from '../marketdata/features/library.js';
import { OptionChainState } from '../marketdata/chain-state.js';
import type { MarketViewProvider } from '../strategy/runner.js';
import type { OptionView, StrategyView } from '../strategy/types.js';

export interface OptionSpec {
  instrumentId: InstrumentId;
  strikePaise: number;
  right: OptionRight;
  expiry: string;
}

export interface FeedMarketDataOptions {
  spotInstrumentId: InstrumentId;
  options: OptionSpec[];
  strikeStepPaise: number;
  /** Spot ticks retained for the feature window (default 240 ≈ 1 min @ 250ms). */
  spotRingSize?: number;
  /** Option ticks retained per instrument for premium velocity/spread stability. */
  optionRingSize?: number;
  chainDepth?: number;
  /**
   * Reject ticks whose exchange `ts` is before this epoch-ms (typically 00:00
   * IST of the session date). Guards against prior-day carryover/reconnect
   * snapshots that otherwise seed the session VWAP with a stale price. When
   * omitted, no ticks are gated (back-compatible for replays).
   */
  sessionFloorMs?: number;
}

export type TickKind = 'spot' | 'option' | 'unknown' | 'stale';

/**
 * Feed-driven market view for the live/paper host (M10). Turns a normalized
 * tick stream into everything the StrategyRunner + Risk Gate read: a spot ring
 * for the underlying features, an OptionChainState for per-strike quotes + ATM
 * tracking, and the ATM CE/PE lookup. This is the production replacement for
 * the demo's hand-rolled provider.
 *
 * Greeks/IV analytics (chain.applyAnalytics) are intentionally NOT driven here
 * — paper-on-synth validates platform wiring, not option pricing; that lights
 * up with the live data feed (M11).
 */
export class FeedMarketData implements MarketViewProvider {
  readonly spotInstrumentId: InstrumentId;
  private readonly chain: OptionChainState;
  private readonly optionIds: ReadonlySet<InstrumentId>;
  private readonly byStrikeRight = new Map<string, InstrumentId>();
  private readonly strikes: number[];
  private readonly ringSize: number;
  private readonly optionRingSize: number;
  private readonly spotTicks: Tick[] = [];
  private readonly optionTicks = new Map<InstrumentId, Tick[]>();
  private readonly sessionFloorMs: number | undefined;
  private atmStrike: number | undefined;
  // Session VWAP accumulators (design §2.2: VWAP of the DAY, not of the ring).
  private cumTurnover = 0;
  private cumQty = 0;
  // Spot 1m bars for ATR / codex features + the UI chart.
  private readonly bars1m: Bar[] = [];
  private readonly barBuilder: BarBuilder;
  private barSink: ((bar: Bar) => void) | undefined;

  constructor(opts: FeedMarketDataOptions) {
    this.spotInstrumentId = opts.spotInstrumentId;
    this.barBuilder = new BarBuilder(opts.spotInstrumentId, (bar) => {
      if (bar.tf !== '1m') return;
      this.bars1m.push(bar);
      if (this.bars1m.length > 60) this.bars1m.splice(0, this.bars1m.length - 60);
      this.barSink?.(bar);
    });
    this.ringSize = opts.spotRingSize ?? 240;
    this.optionRingSize = opts.optionRingSize ?? 120;
    this.sessionFloorMs = opts.sessionFloorMs;
    const instruments: Instrument[] = opts.options.map((o) => ({
      id: o.instrumentId,
      kind: 'OPTION',
      symbol: String(o.instrumentId),
      underlying: 'NIFTY',
      exchange: 'NSE',
      segment: 'NSE_FNO',
      lotSize: 1,
      tickSizePaise: 5,
      expiry: o.expiry,
      strikePaise: o.strikePaise,
      right: o.right,
    }));
    this.chain = new OptionChainState({
      instruments,
      strikeStepPaise: opts.strikeStepPaise,
      ...(opts.chainDepth !== undefined ? { depth: opts.chainDepth } : {}),
    });
    this.optionIds = new Set(opts.options.map((o) => o.instrumentId));
    for (const o of opts.options) {
      this.byStrikeRight.set(key(o.strikePaise, o.right), o.instrumentId);
      this.optionTicks.set(o.instrumentId, []);
    }
    this.strikes = [...new Set(opts.options.map((o) => o.strikePaise))].sort((a, b) => a - b);
  }

  classify(tick: Tick): TickKind {
    if (tick.instrumentId === this.spotInstrumentId) return 'spot';
    if (this.optionIds.has(tick.instrumentId)) return 'option';
    return 'unknown';
  }

  /** Route a tick into the right book; returns which kind it was. */
  ingest(tick: Tick): TickKind {
    // Drop prior-day carryover/reconnect snapshots before they touch the spot
    // ring, session VWAP, or option chain. Their stale exchange `ts` is the tell.
    if (this.sessionFloorMs !== undefined && tick.ts < this.sessionFloorMs) return 'stale';
    const kind = this.classify(tick);
    if (kind === 'spot') {
      this.spotTicks.push(tick);
      if (this.spotTicks.length > this.ringSize) this.spotTicks.splice(0, this.spotTicks.length - this.ringSize);
      this.cumTurnover += tick.ltpPaise * tick.qty;
      this.cumQty += tick.qty;
      this.barBuilder.onTick(tick);
      this.atmStrike = this.chain.updateSpot(tick.ltpPaise).atmStrikePaise;
    } else if (kind === 'option') {
      const ticks = this.optionTicks.get(tick.instrumentId) ?? [];
      ticks.push(tick);
      if (ticks.length > this.optionRingSize) ticks.splice(0, ticks.length - this.optionRingSize);
      this.optionTicks.set(tick.instrumentId, ticks);
      this.chain.updateTick(tick);
    }
    return kind;
  }

  /** Receive each finished spot 1m bar (the host journals them as md.bar). */
  setBarSink(cb: (bar: Bar) => void): void {
    this.barSink = cb;
  }

  // --------------------------------------------------------- MarketViewProvider

  strategyView(nowMs: number): Omit<StrategyView, 'params'> {
    const spot = this.spotPaise();
    const features = computeUnderlyingFeatures(this.spotTicks, this.bars1m);
    // Session VWAP overrides the ring-window value the library computes.
    if (this.cumQty > 0) features.vwapPaise = this.cumTurnover / this.cumQty;
    return {
      nowMs,
      ...(spot !== undefined ? { spotPaise: spot } : {}),
      underlyingFeatures: features,
      ...(this.atmStrike !== undefined ? { atmStrikePaise: this.atmStrike } : {}),
      atmOption: (right) => this.atmOption(right),
    };
  }

  allowedInstruments(): ReadonlySet<InstrumentId> {
    return this.optionIds;
  }

  optionRows(): ReadonlyMap<InstrumentId, OptionChainRow> {
    const m = new Map<InstrumentId, OptionChainRow>();
    for (const row of this.chain.allRows()) m.set(row.instrumentId, row);
    return m;
  }

  atmStrikePaise(): number | undefined {
    return this.atmStrike;
  }

  spotPaise(): number | undefined {
    return this.spotTicks[this.spotTicks.length - 1]?.ltpPaise;
  }

  // ---------------------------------------------------------------- host extras

  /** All chain rows (strike-sorted) for the gateway chain strip. */
  chainRows(): OptionChainRow[] {
    return this.chain.allRows();
  }

  lastSpotTs(): number {
    return this.spotTicks[this.spotTicks.length - 1]?.ts ?? 0;
  }

  private atmOption(right: OptionRight): OptionView | undefined {
    const strike = this.atmStrike ?? this.nearestStrike();
    if (strike === undefined) return undefined;
    const id = this.byStrikeRight.get(key(strike, right)) ?? this.nearestId(strike, right);
    if (id === undefined) return undefined;
    const row = this.chain.row(id);
    if (row === undefined) return undefined;
    return {
      instrumentId: id,
      row,
      features: computeOptionFeatures(row, this.optionTicks.get(id) ?? [], this.atmStrike),
    };
  }

  private nearestStrike(): number | undefined {
    return this.strikes[Math.floor(this.strikes.length / 2)];
  }

  private nearestId(target: number, right: OptionRight): InstrumentId | undefined {
    let best: InstrumentId | undefined;
    let bestDist = Infinity;
    for (const strike of this.strikes) {
      const id = this.byStrikeRight.get(key(strike, right));
      if (id === undefined) continue;
      const d = Math.abs(strike - target);
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    return best;
  }
}

function key(strikePaise: number, right: OptionRight): string {
  return `${strikePaise}:${right}`;
}
