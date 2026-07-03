import { readFileSync } from 'node:fs';
import type { Instrument, OptionRight } from '../domain/instrument.js';
import { makeInstrumentId } from '../domain/ids.js';

/**
 * One row from the Dhan scrip master CSV (api-scrip-master.csv).
 *
 * CSV column order (0-indexed):
 *   0  SEM_EXM_EXCH_ID      exchange: NSE | BSE | MCX
 *   1  SEM_SEGMENT          segment code: D=NSE_FNO, C=currency, E=equity, etc.
 *   2  SEM_SMST_SECURITY_ID Dhan security id
 *   3  SEM_INSTRUMENT_NAME  OPTIDX | FUTSTK | FUTIDX | OPTSTK | ...
 *   4  SEM_EXPIRY_CODE      numeric
 *   5  SEM_TRADING_SYMBOL   e.g. NIFTY-Jul2026-24500-CE
 *   6  SEM_LOT_UNITS        lot size (float)
 *   7  SEM_CUSTOM_SYMBOL    human display
 *   8  SEM_EXPIRY_DATE      YYYY-MM-DD HH:MM:SS
 *   9  SEM_STRIKE_PRICE     float
 *  10  SEM_OPTION_TYPE      CE | PE | XX (non-options)
 *  11  SEM_TICK_SIZE        float
 *  12  SEM_EXPIRY_FLAG      W = weekly, M = monthly
 *  13  SEM_EXCH_INSTRUMENT_TYPE
 *  14  SEM_SERIES
 *  15  SM_SYMBOL_NAME       underlying symbol e.g. NIFTY
 */
export interface ScripRow {
  exchange: string;
  segment: string;
  securityId: string;
  instrumentName: string;
  expiryCode: number;
  tradingSymbol: string;
  lotSize: number;
  customSymbol: string;
  /** ISO date YYYY-MM-DD (time portion stripped). */
  expiryDate: string;
  strikePaise: number;
  optionType: string;
  tickSizePaise: number;
  expiryFlag: 'W' | 'M' | string;
  underlyingSymbol: string;
}

function stripTimePortion(dateStr: string): string {
  return dateStr.split(' ')[0] ?? dateStr;
}

function parseRow(cols: string[]): ScripRow | null {
  if (cols.length < 13) return null;
  const strikePaise = Math.round(parseFloat(cols[9] ?? '0') * 100);
  const tickSizePaise = Math.round(parseFloat(cols[11] ?? '5') * 100);
  if (isNaN(strikePaise) || isNaN(tickSizePaise)) return null;

  const tradingSymbol = (cols[5] ?? '').trim();

  // SM_SYMBOL_NAME (col 15) is empty in many FNO rows. Extract the underlying
  // from the trading symbol prefix instead: "NIFTY-Jul2026-29300-CE" → "NIFTY".
  const smSymbol = (cols[15] ?? '').trim();
  const underlyingSymbol = smSymbol !== '' ? smSymbol : (tradingSymbol.split('-')[0] ?? '');

  return {
    exchange: (cols[0] ?? '').trim(),
    segment: (cols[1] ?? '').trim(),
    securityId: (cols[2] ?? '').trim(),
    instrumentName: (cols[3] ?? '').trim(),
    expiryCode: parseInt(cols[4] ?? '0', 10),
    tradingSymbol,
    lotSize: parseFloat(cols[6] ?? '0'),
    customSymbol: (cols[7] ?? '').trim(),
    expiryDate: stripTimePortion((cols[8] ?? '').trim()),
    strikePaise,
    optionType: (cols[10] ?? '').trim(),
    tickSizePaise,
    expiryFlag: ((cols[12] ?? '').trim()) as 'W' | 'M',
    underlyingSymbol,
  };
}

/**
 * Parse the Dhan scrip master CSV file. Returns all valid rows.
 * The CSV has no quoted fields with commas, so a plain split works.
 */
export function loadScripMaster(csvPath: string): ScripRow[] {
  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n');
  const rows: ScripRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const cols = line.split(',');
    const row = parseRow(cols);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** Filter to option rows for a given underlying (OPTIDX or OPTSTK). */
export function filterOptions(rows: ScripRow[], underlyingSymbol: string): ScripRow[] {
  return rows.filter(
    (r) =>
      r.underlyingSymbol === underlyingSymbol &&
      (r.instrumentName === 'OPTIDX' || r.instrumentName === 'OPTSTK') &&
      (r.optionType === 'CE' || r.optionType === 'PE'),
  );
}

/** Unique sorted expiry dates (YYYY-MM-DD) for a filtered option set. */
export function getExpiryDates(rows: ScripRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.expiryDate) seen.add(r.expiryDate);
  return Array.from(seen).sort();
}

/** Next weekly expiry (flag=W) on or after `asOfDate` (YYYY-MM-DD). */
export function nextWeeklyExpiry(rows: ScripRow[], asOfDate: string): string | undefined {
  return getExpiryDates(rows.filter((r) => r.expiryFlag === 'W')).find((d) => d >= asOfDate);
}

/** Next monthly expiry (flag=M) on or after `asOfDate` (YYYY-MM-DD). */
export function nextMonthlyExpiry(rows: ScripRow[], asOfDate: string): string | undefined {
  return getExpiryDates(rows.filter((r) => r.expiryFlag === 'M')).find((d) => d >= asOfDate);
}

export interface ChainEntry {
  ce?: ScripRow;
  pe?: ScripRow;
}

/**
 * Build an option chain map for a specific expiry.
 * Keys are strike prices in paise; values have CE and/or PE rows.
 */
export function buildOptionChain(
  rows: ScripRow[],
  expiryDate: string,
): Map<number, ChainEntry> {
  const chain = new Map<number, ChainEntry>();
  for (const r of rows) {
    if (r.expiryDate !== expiryDate) continue;
    if (r.optionType !== 'CE' && r.optionType !== 'PE') continue;
    const entry = chain.get(r.strikePaise) ?? {};
    if (r.optionType === 'CE') entry.ce = r;
    else entry.pe = r;
    chain.set(r.strikePaise, entry);
  }
  return chain;
}

/**
 * The strikes nearest to `spotPaise` in the chain: ATM and N strikes
 * above/below (by strike step).
 */
export function getChainStrikes(
  chain: Map<number, ChainEntry>,
  spotPaise: number,
  depth = 5,
): number[] {
  const strikes = Array.from(chain.keys()).sort((a, b) => a - b);
  if (strikes.length === 0) return [];

  // Nearest strike index.
  let atmIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const d = Math.abs((strikes[i] as number) - spotPaise);
    if (d < minDist) {
      minDist = d;
      atmIdx = i;
    }
  }
  const lo = Math.max(0, atmIdx - depth);
  const hi = Math.min(strikes.length - 1, atmIdx + depth);
  return strikes.slice(lo, hi + 1) as number[];
}

/** Convert a `ScripRow` to the platform's canonical `Instrument` type. */
export function toInstrument(row: ScripRow): Instrument {
  const id = makeInstrumentId('NSE', row.securityId);
  const right = row.optionType === 'CE' || row.optionType === 'PE'
    ? (row.optionType as OptionRight)
    : undefined;

  const kind =
    row.instrumentName === 'OPTIDX' || row.instrumentName === 'OPTSTK' ? 'OPTION'
      : row.instrumentName === 'FUTSTK' || row.instrumentName === 'FUTIDX' ? 'FUTURE'
        : 'INDEX';

  return {
    id,
    kind,
    symbol: row.tradingSymbol,
    underlying: row.underlyingSymbol,
    exchange: row.exchange,
    segment: 'NSE_FNO',
    lotSize: Math.round(row.lotSize),
    tickSizePaise: row.tickSizePaise,
    expiry: row.expiryDate,
    strikePaise: row.strikePaise,
    ...(right !== undefined ? { right } : {}),
    brokerToken: row.securityId,
  };
}

/** Convenience: given all scrip rows, resolve the current NIFTY weekly chain. */
export interface WeeklyChainResult {
  expiryDate: string;
  chain: Map<number, ChainEntry>;
  lotSize: number;
  tickSizePaise: number;
  rowCount: number;
}

export function resolveNiftyWeeklyChain(
  rows: ScripRow[],
  asOfDate: string,
): WeeklyChainResult | undefined {
  const niftyOptions = filterOptions(rows, 'NIFTY');
  const expiryDate = nextWeeklyExpiry(niftyOptions, asOfDate);
  if (expiryDate === undefined) return undefined;

  const chain = buildOptionChain(niftyOptions, expiryDate);
  const first = niftyOptions.find((r) => r.expiryDate === expiryDate);
  return {
    expiryDate,
    chain,
    lotSize: first ? Math.round(first.lotSize) : 65,
    tickSizePaise: first ? first.tickSizePaise : 500,
    rowCount: niftyOptions.filter((r) => r.expiryDate === expiryDate).length,
  };
}
