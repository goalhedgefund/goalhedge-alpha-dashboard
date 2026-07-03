import { createGzip, type Gzip } from 'node:zlib';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Tick } from '../domain/marketdata.js';

export type RecorderCompression = 'gzip' | 'none';

export interface RecorderOptions {
  dir: string;
  filename?: string;
  compression?: RecorderCompression;
  /** Buffered-line threshold that triggers an early flush. */
  maxBufferedLines?: number;
}

/**
 * Writes normalized Tick objects to a JSONL file, one per line, buffered.
 * Separate from the event journal — tick files grow large and are used
 * specifically for replay and backtest corpus growth.
 */
export class Recorder {
  readonly path: string;
  private readonly fileStream: WriteStream;
  private readonly gzip: Gzip | undefined;
  private buf: string[] = [];
  private readonly maxBuf: number;
  private count = 0;

  constructor(opts: RecorderOptions) {
    mkdirSync(opts.dir, { recursive: true });
    const compression = opts.compression ?? 'gzip';
    this.path = join(
      opts.dir,
      opts.filename ?? (compression === 'gzip' ? 'ticks.jsonl.gz' : 'ticks.jsonl'),
    );
    this.maxBuf = opts.maxBufferedLines ?? 512;
    this.fileStream = createWriteStream(this.path, { flags: 'a' });
    this.gzip = compression === 'gzip' ? createGzip() : undefined;
    if (this.gzip !== undefined) this.gzip.pipe(this.fileStream);
  }

  record(tick: Tick): void {
    this.buf.push(JSON.stringify(tick));
    this.count++;
    if (this.buf.length >= this.maxBuf) this.flushSync();
  }

  private flushSync(): void {
    if (this.buf.length === 0) return;
    const chunk = this.buf.join('\n') + '\n';
    if (this.gzip !== undefined) this.gzip.write(chunk);
    else this.fileStream.write(chunk);
    this.buf = [];
  }

  tickCount(): number {
    return this.count;
  }

  close(): Promise<void> {
    this.flushSync();
    return new Promise((resolve, reject) => {
      if (this.gzip === undefined) {
        this.fileStream.end((err: Error | null) => (err ? reject(err) : resolve()));
        return;
      }

      this.fileStream.once('finish', resolve);
      this.fileStream.once('error', reject);
      this.gzip.end((err: Error | null) => {
        if (err) reject(err);
      });
    });
  }
}
