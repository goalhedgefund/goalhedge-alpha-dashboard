import { createGzip, constants as zlibConstants, type Gzip } from 'node:zlib';
import { createWriteStream, mkdirSync, openSync, type WriteStream } from 'node:fs';
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
 * Atomically claim an unused part path and return its open fd.
 *
 * Appending a fresh gzip member onto an existing file is what historically
 * destroyed this corpus: if the previous process was killed before close(),
 * its final member is truncated mid-deflate-block, and every member appended
 * after it is unreachable — a decoder stops at the corruption. Writing each
 * run to its own part file keeps one bad run from taking the day with it.
 */
function openExclusivePart(dir: string, base: string): { path: string; fd: number } {
  const dot = base.indexOf('.');
  const stem = dot === -1 ? base : base.slice(0, dot);
  const ext = dot === -1 ? '' : base.slice(dot);
  for (let n = 1; ; n++) {
    const path = n === 1 ? join(dir, base) : join(dir, `${stem}-${n}${ext}`);
    try {
      // 'wx' = create-exclusive: fails if the path exists. Claiming the name
      // atomically here (rather than checking existsSync then creating) is
      // what makes concurrent starts safe — createWriteStream opens lazily,
      // so a existsSync probe races against a sibling that has not opened yet.
      return { path, fd: openSync(path, 'wx') };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/**
 * Writes normalized Tick objects to a JSONL file, one per line, buffered.
 * Separate from the event journal — tick files grow large and are used
 * specifically for replay and backtest corpus growth.
 *
 * Durability: every buffered flush is followed by a gzip Z_SYNC_FLUSH, so an
 * abrupt kill (no close()) loses at most the unflushed buffer instead of the
 * whole deflate window. Costs a little compression ratio; the corpus is only
 * worth keeping if it survives a restart.
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
    const base = opts.filename ?? (compression === 'gzip' ? 'ticks.jsonl.gz' : 'ticks.jsonl');
    const part = openExclusivePart(opts.dir, base);
    this.path = part.path;
    this.maxBuf = opts.maxBufferedLines ?? 512;
    // Adopt the fd claimed above rather than reopening by path.
    this.fileStream = createWriteStream(this.path, { fd: part.fd, autoClose: true });
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
    if (this.gzip !== undefined) {
      this.gzip.write(chunk);
      // Emit a sync marker so everything written so far is decodable even if
      // the process never reaches close().
      this.gzip.flush(zlibConstants.Z_SYNC_FLUSH);
    } else {
      this.fileStream.write(chunk);
    }
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
