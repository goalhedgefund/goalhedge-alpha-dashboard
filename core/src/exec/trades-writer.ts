import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Trade } from '../domain/positions.js';

export interface TradesWriterOptions {
  dir: string;
  filename?: string;
}

export class TradesWriter {
  readonly path: string;
  private readonly stream: WriteStream;

  constructor(opts: TradesWriterOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.path = join(opts.dir, opts.filename ?? 'trades.jsonl');
    this.stream = createWriteStream(this.path, { flags: 'a' });
  }

  append(value: { kind: 'orderEvent'; event: unknown } | { kind: 'trade'; trade: Trade }): void {
    this.stream.write(JSON.stringify(value) + '\n');
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
