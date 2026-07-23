/** Backtest-only discovery for the synthetic OP(-) ladder recordings. */
import { loadScripMaster } from '../marketdata/instrument-master.js';
import { makeInstrumentId, type InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import type { OptionSpec } from '../host/feed-market-data.js';

const SYNTHETIC_SPOT_ID = makeInstrumentId('NSE', 'BACKTEST_SYNTHETIC_SPOT');
const LADDER_ID = /^(NSE:\d+):scalp:ATM(?:(\+|-)(\d+))?$/;

export interface DiscoveredRecording {
  spotInstrumentId: InstrumentId;
  optionSpecs: OptionSpec[];
  /** Feed events, including a clearly synthetic spot only when source has none. */
  feedTicks: Tick[];
  syntheticSpot: boolean;
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
  let syntheticSpotPaise: number | undefined;

  for (const tick of ticks) {
    const match = LADDER_ID.exec(String(tick.instrumentId));
    if (match === null) continue;
    const baseId = match[1] as InstrumentId;
    const row = rowsById.get(baseId);
    if (row === undefined || (row.optionType !== 'CE' && row.optionType !== 'PE')) continue;
    const sign = match[3] === '-' ? -1 : 1;
    const offset = match[4] === undefined ? 0 : sign * Number(match[4]);
    if (offset !== 0 || match[2] !== 'scalp') continue;
    // NIFTY strike intervals are ₹50 (5,000 paise); this is distinct from
    // the ₹0.05 option-price tick recorded in the scrip master.
    const strikePaise = row.strikePaise + offset * 5_000;
    specs.set(tick.instrumentId, { instrumentId: tick.instrumentId, strikePaise, right: row.optionType, expiry: row.expiryDate });
    syntheticSpotPaise ??= row.strikePaise;
  }
  if (specs.size === 0) throw new Error('No recorded option instruments could be resolved from the scrip master');

  // Excluded ATM±N ladder rows are still option data, not a native spot feed.
  const nativeSpot = ticks.find((tick) => LADDER_ID.exec(String(tick.instrumentId)) === null);
  if (nativeSpot !== undefined) return { spotInstrumentId: nativeSpot.instrumentId, optionSpecs: [...specs.values()], feedTicks: [...ticks], syntheticSpot: false };

  const spotPaise = syntheticSpotPaise ?? [...specs.values()][0]!.strikePaise;
  const feedTicks: Tick[] = [];
  for (let start = 0; start < ticks.length;) {
    const ts = ticks[start]!.ts;
    let end = start;
    let ce: Tick | undefined;
    let pe: Tick | undefined;
    while (end < ticks.length && ticks[end]!.ts === ts) {
      const tick = ticks[end]!;
      const spec = specs.get(tick.instrumentId);
      if (spec?.right === 'CE') ce = tick;
      else if (spec?.right === 'PE') pe = tick;
      end++;
    }
    if (ce !== undefined && pe !== undefined) {
      const ceMid = ce.bidPaise > 0 && ce.askPaise > 0 ? (ce.bidPaise + ce.askPaise) / 2 : ce.ltpPaise;
      const peMid = pe.bidPaise > 0 && pe.askPaise > 0 ? (pe.bidPaise + pe.askPaise) / 2 : pe.ltpPaise;
      feedTicks.push({
        instrumentId: SYNTHETIC_SPOT_ID,
        ts,
        recvTs: ce.recvTs,
        ltpPaise: Math.round(spotPaise + ceMid - peMid),
        qty: 0,
        volume: 0,
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
