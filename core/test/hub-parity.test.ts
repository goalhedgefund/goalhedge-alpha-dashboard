import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tick } from '../src/domain/marketdata.js';
import { ReplayFeed } from '../src/feed/replay.js';
import { HubFeed } from '../src/feed/hub/feed.js';
import { HubServer } from '../src/hub/server.js';

/**
 * H4 parity — does routing a tape through the hub change it?
 *
 * The plan's H4 gate asks for a live session run of one desk on `dhan` against
 * the same desk on `hub`, with the journals diffed. That cannot run while the
 * Dhan account is rate-limited, so this asserts the stronger and deterministic
 * half of it: the exact tick sequence a desk receives must be identical whether
 * it reads a recorded tape directly or through HubServer -> HubFeed.
 *
 * Tick-level identity subsumes journal parity. Bars, signals and fills are pure
 * functions of the tick sequence, so an identical sequence in identical order
 * cannot produce a different journal. A live run still has to prove the Dhan
 * socket path; it does not need to re-prove this.
 */

const CORPUS = 'data/dhan/ticks-op-minus-atm-short/2026-07-01/ticks.jsonl.gz';

/** Kept well inside the hub's per-client buffer so a burst cannot drop ticks;
 *  drop-oldest under load is covered separately in hub-server.test.ts. */
const TICK_LIMIT = 2_000;

const PORT = 8891;

let recordingsDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  if (recordingsDir) rmSync(recordingsDir, { recursive: true, force: true });
});

/** Path A: the tape read directly, i.e. what a desk on `dhan` would have seen. */
async function readDirect(limit: number): Promise<Tick[]> {
  const ticks: Tick[] = [];
  const feed = new ReplayFeed({ path: CORPUS });
  feed.setTickHandler((t) => {
    if (ticks.length < limit) ticks.push(t);
  });
  await feed.playInstant();
  return ticks;
}

/** Path B: the same tape pushed through HubServer and pulled back via HubFeed. */
async function readThroughHub(limit: number): Promise<{ ticks: Tick[]; dropped: number }> {
  recordingsDir = mkdtempSync(join(tmpdir(), 'hub-parity-'));
  const source = new ReplayFeed({ path: CORPUS });

  const hub = new HubServer({
    port: PORT,
    host: '127.0.0.1',
    feed: source,
    recordingsDir
  });
  await hub.start();
  cleanups.push(() => hub.close());

  const ticks: Tick[] = [];
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const client = new HubFeed({ url: `ws://127.0.0.1:${PORT}`, clientId: 'PARITY' });
  client.setTickHandler((t) => {
    if (ticks.length < limit) ticks.push(t);
    if (ticks.length === limit) resolveDone();
  });
  await client.connect();
  cleanups.push(() => client.close());

  await source.playInstant();
  // The hop is asynchronous; give the tail time to arrive rather than racing it.
  await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);

  return { ticks, dropped: 0 };
}

describe('H4 hub parity', () => {
  it('has the recorded corpus this gate depends on', () => {
    expect(existsSync(CORPUS), `missing corpus: ${CORPUS}`).toBe(true);
  });

  it('delivers a byte-identical tick sequence through the hub', async () => {
    const direct = await readDirect(TICK_LIMIT);
    expect(direct.length).toBe(TICK_LIMIT);

    const { ticks: viaHub } = await readThroughHub(TICK_LIMIT);

    // Count first: a short read means the hop lost ticks, which is the failure
    // this gate exists to catch.
    expect(viaHub.length).toBe(direct.length);

    // Order and content, field for field.
    expect(viaHub).toEqual(direct);

    // Serialised form too, so a silently added or reshaped field is caught even
    // if it compares equal structurally.
    expect(viaHub.map((t) => JSON.stringify(t))).toEqual(direct.map((t) => JSON.stringify(t)));
  }, 60_000);
});
