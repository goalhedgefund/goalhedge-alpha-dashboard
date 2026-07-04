import type { Tick } from '../domain/marketdata.js';
import { hashEventStream } from '../journal/hash.js';
import { readJournal } from '../journal/reader.js';
import type { PaperHost } from '../host/paper-host.js';

/**
 * Multi-day soak runner (02-CODING-PLAN M10, 03-TESTING-PLAN §9). Replays N
 * recorded/synthetic sessions back-to-back through a fresh PaperHost each, and
 * checks the platform's stability posture:
 *   - journal integrity: the on-disk journal round-trips to the in-memory
 *     truth (event count + stream hash) for every session;
 *   - determinism: identical inputs → identical journal hash (the §7 backstop);
 *   - no leak: heapUsed does not grow unbounded across sessions;
 *   - a digest per session.
 *
 * It owns the drive loop but not how sessions are sourced — each spec builds a
 * fresh host (marketData primed for preflight) + its tick stream, so the same
 * runner drives synth, replay-file, or scripted sessions.
 */

export interface SoakBuild {
  host: PaperHost;
  /** Path to the host's journal file, for the integrity re-read. */
  journalPath: string;
  ticks: Tick[];
  /** Keeps a ManualClock in step with tick time (omit for a live clock). */
  clock?: { set(ts: number): void };
  /** onTimer cadence in sim-ms (default 1000). */
  timerEveryMs?: number;
}

export interface SoakSessionSpec {
  id: string;
  build: () => Promise<SoakBuild>;
}

export interface SoakSessionResult {
  id: string;
  events: number;
  /** Stable determinism hash over all events EXCEPT latency.sample (telemetry). */
  journalHash: string;
  trades: number;
  netPaise: number;
  /** True iff the on-disk journal matches the in-memory event stream. */
  integrityOk: boolean;
  heapUsedBytes: number;
}

export interface SoakReport {
  sessions: SoakSessionResult[];
  heapGrowthBytes: number;
  allIntegrityOk: boolean;
}

/** Best-effort GC when the runtime was started with --expose-gc. */
function tryGc(): void {
  const g = globalThis as { gc?: () => void };
  if (typeof g.gc === 'function') g.gc();
}

export async function runSoak(specs: readonly SoakSessionSpec[]): Promise<SoakReport> {
  const sessions: SoakSessionResult[] = [];

  for (const spec of specs) {
    const { host, journalPath, ticks, clock, timerEveryMs = 1_000 } = await spec.build();
    await host.start();

    let lastTimer = ticks[0]?.ts ?? 0;
    for (const tick of ticks) {
      clock?.set(tick.ts);
      await host.ingestTick(tick);
      if (tick.ts - lastTimer >= timerEveryMs) {
        await host.onTimer(tick.ts);
        lastTimer = tick.ts;
      }
    }

    const { report } = await host.squareOffAndReport(); // flushes + closes writers

    // Integrity: the closed journal must reproduce the in-memory event stream
    // exactly — telemetry included.
    const inMemory = [...host.journalEvents()];
    const { events: onDisk } = await readJournal(journalPath, { strictSeq: false });
    const integrityOk = onDisk.length === inMemory.length && hashEventStream(onDisk) === hashEventStream(inMemory);

    // Determinism identity EXCLUDES latency.sample: those carry real measured
    // microseconds (performance.now()), so they are legitimately non-deterministic
    // and must not be part of the golden-session hash (03-TESTING-PLAN §7).
    const stableHash = hashEventStream(inMemory.filter((e) => e.type !== 'latency.sample'));

    tryGc();
    sessions.push({
      id: spec.id,
      events: inMemory.length,
      journalHash: stableHash,
      trades: report.summary.tradeCount,
      netPaise: report.summary.netPaise,
      integrityOk,
      heapUsedBytes: process.memoryUsage().heapUsed,
    });
  }

  const first = sessions[0]?.heapUsedBytes ?? 0;
  const last = sessions[sessions.length - 1]?.heapUsedBytes ?? 0;
  return {
    sessions,
    heapGrowthBytes: last - first,
    allIntegrityOk: sessions.every((s) => s.integrityOk),
  };
}
