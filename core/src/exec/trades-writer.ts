import { mkdirSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Trade } from '../domain/positions.js';

export interface TradesWriterOptions {
  dir: string;
  filename?: string;
}

export class TradesWriter {
  readonly path: string;
  private readonly handlePromise: Promise<FileHandle>;
  private writeChain: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(opts: TradesWriterOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.path = join(opts.dir, opts.filename ?? 'trades.jsonl');
    this.handlePromise = open(this.path, 'a');
    this.handlePromise.catch((err) => { this.failure = err; });
  }

  append(value: { kind: 'orderEvent'; event: unknown } | { kind: 'trade'; trade: Trade }): void {
    if (this.failure !== undefined) throw new Error(`trade writer failed: ${String(this.failure)}`);
    const line = JSON.stringify(value) + '\n';
    this.writeChain = this.writeChain.then(async () => {
      const handle = await this.handlePromise;
      await handle.appendFile(line, 'utf8');
    });
    this.writeChain.catch((err) => { this.failure = err; });
  }

  async close(): Promise<void> {
    await this.writeChain;
    const handle = await this.handlePromise;
    await handle.sync();
    await handle.close();
  }
}
