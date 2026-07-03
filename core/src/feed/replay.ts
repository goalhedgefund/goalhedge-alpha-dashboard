import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { Tick } from '../domain/marketdata.js';
import type { IFeedAdapter, FeedHealth, SubscribeRequest } from './interface.js';

export interface ReplayFeedOptions {
  /** Path to a ticks.jsonl file written by Recorder. */
  path: string;
}

/**
 * Replays a recorded tick file.
 *
 * `playInstant()` is the primary test method: iterates synchronously through
 * the entire file (via async readline) and calls the registered handler for
 * each line. Guarantees determinism: same file → same sequence of Ticks.
 *
 * As an IFeedAdapter, `connect()` / `close()` are no-ops; replay is driven
 * by calling `playInstant()` or `playRealtime()`.
 */
export class ReplayFeed implements IFeedAdapter {
  readonly adapterId = 'replay';
  private handler: ((tick: Tick) => void) | undefined;
  private readonly opts: ReplayFeedOptions;
  private emitted = 0;

  constructor(opts: ReplayFeedOptions) {
    this.opts = opts;
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
    return Promise.resolve();
  }

  /** Total ticks emitted in the last `playInstant()` call. */
  ticksEmitted(): number {
    return this.emitted;
  }

  /**
   * Read the entire tick file and call the handler for each valid Tick.
   * A blank or malformed line is skipped (tolerates crash-truncated tail).
   */
  async playInstant(): Promise<number> {
    const handler = this.handler;
    if (handler === undefined) throw new Error('no tick handler registered');
    this.emitted = 0;

    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({
        input: this.inputStream(),
        crlfDelay: Infinity,
      });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const tick = JSON.parse(line) as Tick;
          handler(tick);
          this.emitted++;
        } catch {
          /* skip malformed lines */
        }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });

    return this.emitted;
  }

  /**
   * Realtime replay: respects original tick timestamps scaled by speedMultiplier.
   * speedMultiplier=1 = wall-clock speed; speedMultiplier=10 = 10× faster.
   * Resolves when all ticks have been emitted.
   */
  async playRealtime(speedMultiplier = 1): Promise<number> {
    const handler = this.handler;
    if (handler === undefined) throw new Error('no tick handler registered');
    this.emitted = 0;

    const ticks: Tick[] = [];
    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({
        input: this.inputStream(),
        crlfDelay: Infinity,
      });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          ticks.push(JSON.parse(line) as Tick);
        } catch {
          /* skip */
        }
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });

    if (ticks.length === 0) return 0;
    const firstTs = ticks[0]!.ts;
    const startWall = Date.now();

    await new Promise<void>((resolve) => {
      let i = 0;
      const next = (): void => {
        if (i >= ticks.length) {
          resolve();
          return;
        }
        const tick = ticks[i]!;
        const targetWall = startWall + (tick.ts - firstTs) / speedMultiplier;
        const delay = Math.max(0, targetWall - Date.now());
        setTimeout(() => {
          handler(tick);
          this.emitted++;
          i++;
          next();
        }, delay);
      };
      next();
    });

    return this.emitted;
  }

  private inputStream(): NodeJS.ReadableStream {
    const raw = createReadStream(this.opts.path);
    if (this.opts.path.endsWith('.gz')) return raw.pipe(createGunzip());
    return raw;
  }
}
