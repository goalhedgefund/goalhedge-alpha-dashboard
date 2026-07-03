/**
 * Injected clock so the engine never reads wall time directly — replays run
 * on a virtual clock and produce identical timestamps.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

const IST_OFFSET_MS = 330 * 60_000; // UTC+5:30, no DST

/** Epoch-ms → 'HH:MM' wall time in IST (exchange time). */
export function formatHHMMIst(epochMs: number): string {
  const d = new Date(epochMs + IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export class ManualClock implements Clock {
  constructor(private t: number) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(t: number): void {
    this.t = t;
  }
}
