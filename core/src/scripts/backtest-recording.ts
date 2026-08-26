/** Backtest-only discovery for the synthetic OP(-) ladder recordings. */
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { loadScripMaster } from '../marketdata/instrument-master.js';
import { makeInstrumentId, type InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import type { OptionSpec } from '../host/feed-market-data.js';

const SYNTHETIC_SPOT_ID = makeInstrumentId('NSE', 'BACKTEST_SYNTHETIC_SPOT');
const LADDER_ID = /^(NSE:\d+):scalp:ATM(?:(\+|-)(\d+))?$/;
export const DEFAULT_SCRIP_MASTER_PATH = 'D:\\DHAN_LOGIN\\api-scrip-master.csv';

export function resolveScripMasterPath(): string {
  return process.env.DHAN_SCRIP_MASTER_PATH?.trim() || DEFAULT_SCRIP_MASTER_PATH;
}

export interface DiscoveredRecording {
  spotInstrumentId: InstrumentId;
  optionSpecs: OptionSpec[];
  /** Feed events, including a clearly synthetic spot only when source has none. */
  feedTicks: Tick[];
  syntheticSpot: boolean;
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
