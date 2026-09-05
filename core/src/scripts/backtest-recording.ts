/** Backtest-only discovery for the synthetic OP(-) ladder recordings. */
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScripMaster } from '../marketdata/instrument-master.js';
import { makeInstrumentId, type InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import type { OptionSpec } from '../host/feed-market-data.js';

const SYNTHETIC_SPOT_ID = makeInstrumentId('NSE', 'BACKTEST_SYNTHETIC_SPOT');
const LADDER_ID = /^(NSE:\d+):scalp:ATM(?:(\+|-)(\d+))?$/;
export const DEFAULT_SCRIP_MASTER_PATH = 'D:\\DHAN_LOGIN\\api-scrip-master.csv';

const SCALPER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Dated snapshots: api-scrip-master-YYYY-MM-DD.csv (gitignored, see data/). */
export const SCRIP_MASTER_ARCHIVE_DIR = join(SCALPER_ROOT, 'data', 'dhan', 'scrip-master');
const ARCHIVE_NAME = /^api-scrip-master-(\d{4}-\d{2}-\d{2})\.csv$/;

/** Archived snapshot dates, oldest first. */
export function listArchivedScripMasters(): { date: string; path: string }[] {
  if (!existsSync(SCRIP_MASTER_ARCHIVE_DIR)) return [];
  const out: { date: string; path: string }[] = [];
  for (const name of readdirSync(SCRIP_MASTER_ARCHIVE_DIR)) {
    const m = ARCHIVE_NAME.exec(name);
    if (m?.[1] !== undefined) out.push({ date: m[1], path: join(SCRIP_MASTER_ARCHIVE_DIR, name) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Scrip master to use when resolving a recording.
 *
 * The live master is a point-in-time snapshot: expired contracts are purged
 * from it, so today's file cannot resolve a recording from a past expiry
 * cycle. Replaying an old day needs the master as it stood *then*. Given
 * `asOfDate`, pick the newest archived snapshot taken on or before that date
 * (options are listed well ahead of expiry, so an earlier snapshot still
 * carries the contracts traded later). Falls back to the oldest snapshot when
 * the recording predates every archive, then to the live file.
 *
 * DHAN_SCRIP_MASTER_PATH overrides everything — it is how a caller pins one
 * specific master regardless of date.
 */
export function resolveScripMasterPath(asOfDate?: string): string {
  const override = process.env.DHAN_SCRIP_MASTER_PATH?.trim();
  if (override) return override;

  if (asOfDate !== undefined) {
    const archives = listArchivedScripMasters();
    if (archives.length > 0) {
      let pick = archives.find((a) => a.date <= asOfDate) === undefined
        ? archives[0]
        : undefined;
      for (const a of archives) if (a.date <= asOfDate) pick = a;
      if (pick !== undefined) return pick.path;
    }
  }
  return DEFAULT_SCRIP_MASTER_PATH;
}

export interface DiscoveredRecording {
  spotInstrumentId: InstrumentId;
  optionSpecs: OptionSpec[];
  /** Feed events, including a clearly synthetic spot only when source has none. */
  feedTicks: Tick[];
  syntheticSpot: boolean;
}

const TICK_PART = /^ticks(?:-(\d+))?\.jsonl\.gz$/;

/**
 * Every tick part for one recorded day, in write order.
 *
 * The recorder writes each process run to its own part (ticks.jsonl.gz,
 * ticks-2.jsonl.gz, …) so a run killed mid-deflate cannot hide the runs after
 * it. A day recorded before that change is a single file and still loads.
 */
export function listTickParts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: TICK_PART.exec(name) }))
    .filter((e): e is { name: string; m: RegExpExecArray } => e.m !== null)
    .sort((a, b) => Number(a.m[1] ?? '1') - Number(b.m[1] ?? '1'))
    .map((e) => join(dir, e.name));
}

/** Load and concatenate every tick part in a day's recording directory. */
export async function loadTicksForDate(dir: string): Promise<Tick[]> {
  const parts = listTickParts(dir);
  if (parts.length === 1) return loadTicksFromGz(parts[0]!);
  const out: Tick[] = [];
  for (const part of parts) {
    // Append element-wise: a day holds ~1e6 ticks and push(...spread) of that
    // many arguments overflows the call stack.
    for (const tick of await loadTicksFromGz(part)) out.push(tick);
  }
  return out;
}

/** Load ticks from a (possibly truncated/multi-member) gzip recording. */
export async function loadTicksFromGz(path: string): Promise<Tick[]> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    const gz = createReadStream(path).pipe(createGunzip());
    gz.on('data', (chunk: Buffer) => chunks.push(chunk));
    gz.on('end', resolve);
    gz.on('error', () => resolve());
  });
  const ticks: Tick[] = [];
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { ticks.push(JSON.parse(trimmed) as Tick); } catch { /* partial JSON at EOF */ }
  }
  return ticks;
}

/**
 * Resolves the recorded ATM call/put labels to live instrument facts. Backtest
 * runners intentionally use ATM rows only; OTM/ITM ladder rows are excluded.
 * The corpus has no underlying tick, so an ATM put-call-parity proxy is
 * injected at every timestamp: spot ~= ATM strike + CE mid - PE mid.
 */
export function discoverRecording(ticks: readonly Tick[], scripMasterPath: string): DiscoveredRecording {
  const rowsById = new Map(loadScripMaster(scripMasterPath).map((row) => [makeInstrumentId('NSE', row.securityId), row]));
  const specs = new Map<InstrumentId, OptionSpec>();

  for (const tick of ticks) {
    const match = LADDER_ID.exec(String(tick.instrumentId));
    if (match === null) continue;
    const baseId = match[1] as InstrumentId;
    const row = rowsById.get(baseId);
    if (row === undefined || (row.optionType !== 'CE' && row.optionType !== 'PE')) continue;
    // Regex groups: [1]=base security id, [2]=offset sign, [3]=offset digits.
    const sign = match[2] === '-' ? -1 : 1;
    const offset = match[3] === undefined ? 0 : sign * Number(match[3]);
    if (offset !== 0) continue; // ATM rows only; ladder (ATM±N) rows excluded

    // NIFTY strike intervals are ₹50 (5,000 paise); this is distinct from
    // the ₹0.05 option-price tick recorded in the scrip master.
    const strikePaise = row.strikePaise + offset * 5_000;
    specs.set(tick.instrumentId, { instrumentId: tick.instrumentId, strikePaise, right: row.optionType, expiry: row.expiryDate });
  }
  if (specs.size === 0) throw new Error('No recorded option instruments could be resolved from the scrip master');

  // Excluded ATM±N ladder rows are still option data, not a native spot feed.
  const nativeSpot = ticks.find((tick) => LADDER_ID.exec(String(tick.instrumentId)) === null);
  if (nativeSpot !== undefined) return { spotInstrumentId: nativeSpot.instrumentId, optionSpecs: [...specs.values()], feedTicks: [...ticks], syntheticSpot: false };

  const feedTicks: Tick[] = [];
  let syntheticVolume = 0;
  for (let start = 0; start < ticks.length;) {
    const ts = ticks[start]!.ts;
    let end = start;
    const pairsByStrike = new Map<number, { ce?: Tick; pe?: Tick }>();
    while (end < ticks.length && ticks[end]!.ts === ts) {
      const tick = ticks[end]!;
      const spec = specs.get(tick.instrumentId);
      if (spec !== undefined) {
        const pair = pairsByStrike.get(spec.strikePaise) ?? {};
        if (spec.right === 'CE') pair.ce = tick;
        else pair.pe = tick;
        pairsByStrike.set(spec.strikePaise, pair);
      }
      end++;
    }
    for (const [strikePaise, { ce, pe }] of pairsByStrike) {
      if (ce === undefined || pe === undefined) continue;
      const ceMid = ce.bidPaise > 0 && ce.askPaise > 0 ? (ce.bidPaise + ce.askPaise) / 2 : ce.ltpPaise;
      const peMid = pe.bidPaise > 0 && pe.askPaise > 0 ? (pe.bidPaise + pe.askPaise) / 2 : pe.ltpPaise;
      feedTicks.push({
        instrumentId: SYNTHETIC_SPOT_ID,
        ts,
        recvTs: ce.recvTs,
        // Re-strikes are safe because this uses the pair's current strike.
        ltpPaise: Math.round(strikePaise + ceMid - peMid),
        // A non-zero synthetic unit lets the normal session-VWAP and bar
        // feature pipeline warm up. qty=0 kept every OP(-) historical replay
        // permanently in FEATURES_WARMUP.
        qty: 1,
        volume: ++syntheticVolume,
        bidPaise: 0,
        askPaise: 0,
        bidQty: 0,
        askQty: 0,
      });
    }
    for (let index = start; index < end; index++) {
      const tick = ticks[index]!;
      if (specs.has(tick.instrumentId)) feedTicks.push(tick);
    }
    start = end;
  }
  return { spotInstrumentId: SYNTHETIC_SPOT_ID, optionSpecs: [...specs.values()], feedTicks, syntheticSpot: true };
}

/** Resolve recordings that preserve native Dhan ids and include a spot/future. */
export function discoverPlainRecording(ticks: readonly Tick[], scripMasterPath: string): DiscoveredRecording {
  const rowsById = new Map(loadScripMaster(scripMasterPath).map((row) => [makeInstrumentId('NSE', row.securityId), row]));
  const specs = new Map<InstrumentId, OptionSpec>();
  let spotInstrumentId: InstrumentId | undefined;
  for (const tick of ticks) {
    const row = rowsById.get(tick.instrumentId);
    if (row?.optionType === 'CE' || row?.optionType === 'PE') {
      specs.set(tick.instrumentId, { instrumentId: tick.instrumentId, strikePaise: row.strikePaise, right: row.optionType, expiry: row.expiryDate });
    } else if (spotInstrumentId === undefined) {
      spotInstrumentId = tick.instrumentId;
    }
  }
  if (spotInstrumentId === undefined || specs.size === 0) throw new Error('Could not resolve native spot/options from recording');
  return { spotInstrumentId, optionSpecs: [...specs.values()], feedTicks: [...ticks], syntheticSpot: false };
}
