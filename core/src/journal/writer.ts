import { mkdirSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { JournalEvent, JournalEventType, JournalPayloads } from '../domain/events.js';
import { systemClock, type Clock } from '../domain/time.js';

export type FsyncPolicy = 'never' | 'interval' | 'always';

export interface JournalWriterOptions {
  /** Session directory; created if missing. One journal file per session. */
  dir: string;
  filename?: string;
  clock?: Clock;
  fsync?: FsyncPolicy;
  flushIntervalMs?: number;
  /** Buffered-line threshold that triggers an early flush. */
  maxBufferedLines?: number;
  /** Resuming after crash recovery: continue an existing file at this seq. */
  resume?: { startSeq: number };
}

/**
 * Append-only JSONL journal writer.
 *
 * `append()` is synchronous and hot-path safe: it stamps seq+ts, serializes,
 * and pushes to an in-memory buffer. Disk I/O happens on a flush timer, on a
 * buffer threshold, or on explicit flush()/close() — never on the caller.
 *
 * If a disk write ever fails, the writer latches the error and every
 * subsequent append throws: the platform must never keep trading with a
 * broken audit trail.
 */
export class JournalWriter {
  readonly path: string;

  private seq: number;
  private buf: string[] = [];
  private readonly clock: Clock;
  private readonly fsyncPolicy: FsyncPolicy;
  private readonly maxBufferedLines: number;
  private readonly openPromise: Promise<FileHandle>;
  private writeChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private failure: unknown = undefined;

  constructor(opts: JournalWriterOptions) {
    this.clock = opts.clock ?? systemClock;
    this.fsyncPolicy = opts.fsync ?? 'interval';
    this.maxBufferedLines = opts.maxBufferedLines ?? 512;
    this.seq = opts.resume ? opts.resume.startSeq - 1 : 0;

    mkdirSync(opts.dir, { recursive: true });
    this.path = join(opts.dir, opts.filename ?? 'events.jsonl');
    // 'ax' refuses to touch an existing journal unless explicitly resuming.
    this.openPromise = open(this.path, opts.resume ? 'a' : 'ax');
    this.openPromise.catch((err) => {
      this.failure = err;
    });

    const interval = opts.flushIntervalMs ?? 200;
    this.timer = setInterval(() => {
      void this.flush();
    }, interval);
    this.timer.unref();
  }

  /** Resolves once the journal file is open and writable; rejects if it cannot be. */
  async ready(): Promise<void> {
    await this.openPromise;
  }

  append<K extends JournalEventType>(type: K, payload: JournalPayloads[K]): JournalEvent {
    if (this.closed) throw new Error('journal writer is closed');
    if (this.failure !== undefined) {
      throw new Error(`journal writer failed; refusing to continue: ${String(this.failure)}`);
    }
    const ev = { seq: ++this.seq, ts: this.clock.now(), type, payload } as JournalEvent;
    this.buf.push(JSON.stringify(ev));
    if (this.buf.length >= this.maxBufferedLines) void this.flush();
    return ev;
  }

  lastSeq(): number {
    return this.seq;
  }

  flush(): Promise<void> {
    if (this.buf.length === 0) return this.writeChain;
    const chunk = this.buf.join('\n') + '\n';
    this.buf = [];
    this.writeChain = this.writeChain.then(async () => {
      const fh = await this.openPromise;
      await fh.write(chunk, null, 'utf8');
      if (this.fsyncPolicy === 'always') await fh.sync();
    });
    this.writeChain.catch((err) => {
      this.failure = err;
    });
    return this.writeChain;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
    const fh = await this.openPromise;
    if (this.fsyncPolicy !== 'never') await fh.sync();
    await fh.close();
  }
}
