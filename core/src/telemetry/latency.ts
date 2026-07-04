/**
 * Latency instrumentation (01-DESIGN §7, 03-TESTING-PLAN §6).
 *
 * The internal decision slice — tick-in → order-out — is the only latency we
 * control; broker/exchange RTT (~50–200 ms) dominates and is out of scope. We
 * time it in hops so a regression names the hop that slowed:
 *
 *   t_recv →[features]→ t_features →[signal]→ t_signal →[risk]→ t_risk →[sent]→ t_sent
 *
 * Budget: total (recv→sent) p99 < 5 ms.
 *
 * Measurement uses a monotonic high-resolution clock (`performance.now()`,
 * fractional ms) — deliberately NOT the epoch clock, because deltas must be
 * monotonic and sub-millisecond. The per-decision timer is a single reusable
 * object (one decision in flight per runner, single-threaded), so the hot path
 * allocates nothing except the tiny hops record built only when an order is
 * actually sent (rare — journaled as `latency.sample`).
 */

/** Monotonic high-resolution clock, fractional milliseconds. */
export type HiResClock = () => number;

const defaultHiResClock: HiResClock = () => performance.now();

/** Timed segments, each named by the hop it ends at, in pipeline order. */
export const LATENCY_HOPS = ['features', 'signal', 'risk', 'sent'] as const;
export type LatencyHop = (typeof LATENCY_HOPS)[number];

/** recv=0, then one slot per hop. */
const HOP_INDEX: Record<LatencyHop, number> = { features: 1, signal: 2, risk: 3, sent: 4 };
const SENT_INDEX = HOP_INDEX.sent;

/**
 * Fixed-capacity ring of recent latency samples with nearest-rank
 * percentiles. A typed array + no-comparator `.sort()` sorts numerically
 * ascending (the reason we use Float64Array, not a plain array).
 */
export class RollingLatency {
  private readonly buf: Float64Array;
  private len = 0;
  private head = 0;
  private total = 0;

  constructor(private readonly capacity = 8192) {
    if (capacity <= 0) throw new Error('RollingLatency capacity must be > 0');
    this.buf = new Float64Array(capacity);
  }

  record(ms: number): void {
    this.buf[this.head] = ms;
    this.head = (this.head + 1) % this.capacity;
    if (this.len < this.capacity) this.len++;
    this.total++;
  }

  /** Total samples ever recorded (not just those retained in the window). */
  get count(): number {
    return this.total;
  }

  /** Samples currently retained in the window. */
  get size(): number {
    return this.len;
  }

  /** Nearest-rank percentile over the retained window. `q` in [0,1]. */
  percentile(q: number): number {
    if (this.len === 0) return 0;
    const sorted = this.buf.slice(0, this.len).sort();
    const rank = Math.min(this.len - 1, Math.max(0, Math.ceil(q * this.len) - 1));
    return sorted[rank] as number;
  }

  p50(): number {
    return this.percentile(0.5);
  }

  p99(): number {
    return this.percentile(0.99);
  }

  max(): number {
    let m = 0;
    for (let i = 0; i < this.len; i++) {
      const v = this.buf[i] as number;
      if (v > m) m = v;
    }
    return m;
  }

  reset(): void {
    this.len = 0;
    this.head = 0;
    this.total = 0;
  }
}

export interface HopStats {
  p50Ms: number;
  p99Ms: number;
}

export interface LatencySnapshot {
  /** recv→sent (or furthest hop reached) total — the budget metric. */
  total: { p50Ms: number; p99Ms: number; maxMs: number; count: number };
  /** Per-segment p50/p99 so a regression names its hop. */
  hops: Record<LatencyHop, HopStats>;
}

/**
 * Times decision hops and keeps rolling percentiles for the HUD + benchmark.
 *
 * Usage on the hot path:
 *   sampler.begin();                    // stamps t_recv
 *   ...compute features...  sampler.mark('features');
 *   ...strategy.decide...   sampler.mark('signal');
 *   ...risk gate...         sampler.mark('risk');
 *   ...order handed off...  sampler.mark('sent');
 *   const hops = sampler.end();         // records into rolling stats
 *   if (hops) journal('latency.sample', { hops });  // only when an order went out
 *
 * `end()` must be called exactly once per `begin()`. Early-return paths still
 * call it: the total is recorded up to the furthest hop reached, so no-signal
 * ticks contribute their real hot-path cost (features+decide) to the HUD.
 */
export class LatencySampler {
  private readonly clock: HiResClock;
  private readonly totalStats: RollingLatency;
  private readonly hopStats: Record<LatencyHop, RollingLatency>;
  // Reusable per-decision timestamps: 0=recv, 1=features, 2=signal, 3=risk, 4=sent.
  private readonly t = new Float64Array(5);
  private reached = 0;

  constructor(opts: { clock?: HiResClock; capacity?: number } = {}) {
    this.clock = opts.clock ?? defaultHiResClock;
    const cap = opts.capacity ?? 8192;
    this.totalStats = new RollingLatency(cap);
    this.hopStats = {
      features: new RollingLatency(cap),
      signal: new RollingLatency(cap),
      risk: new RollingLatency(cap),
      sent: new RollingLatency(cap),
    };
  }

  /** Start timing a decision; stamps t_recv from the monotonic clock. */
  begin(): void {
    this.t[0] = this.clock();
    this.reached = 0;
  }

  /** Stamp a hop as reached (reads the monotonic clock). */
  mark(hop: LatencyHop): void {
    const i = HOP_INDEX[hop];
    this.t[i] = this.clock();
    this.reached = i;
  }

  /**
   * Finalize: record total (recv→furthest hop) and each bounded segment into
   * the rolling stats. Returns per-hop microseconds ONLY when the decision
   * reached 'sent' (an order went out) so callers journal a `latency.sample`
   * on real orders; returns undefined otherwise.
   */
  end(): Record<string, number> | undefined {
    if (this.reached === 0) return undefined; // nothing meaningful timed
    const t = this.t;
    const recv = t[0] as number;
    this.totalStats.record((t[this.reached] as number) - recv);
    for (const hop of LATENCY_HOPS) {
      const i = HOP_INDEX[hop];
      if (i > this.reached) break;
      this.hopStats[hop].record((t[i] as number) - (t[i - 1] as number));
    }
    if (this.reached < SENT_INDEX) return undefined;
    return {
      features: micros(recv, t[1] as number),
      signal: micros(t[1] as number, t[2] as number),
      risk: micros(t[2] as number, t[3] as number),
      sent: micros(t[3] as number, t[4] as number),
      total: micros(recv, t[4] as number),
    };
  }

  snapshot(): LatencySnapshot {
    return {
      total: {
        p50Ms: this.totalStats.p50(),
        p99Ms: this.totalStats.p99(),
        maxMs: this.totalStats.max(),
        count: this.totalStats.count,
      },
      hops: {
        features: hopStats(this.hopStats.features),
        signal: hopStats(this.hopStats.signal),
        risk: hopStats(this.hopStats.risk),
        sent: hopStats(this.hopStats.sent),
      },
    };
  }

  reset(): void {
    this.totalStats.reset();
    for (const hop of LATENCY_HOPS) this.hopStats[hop].reset();
    this.reached = 0;
  }
}

function hopStats(r: RollingLatency): HopStats {
  return { p50Ms: r.p50(), p99Ms: r.p99() };
}

/** Milliseconds delta → integer microseconds (journal-readable). */
function micros(a: number, b: number): number {
  return Math.round((b - a) * 1000);
}
