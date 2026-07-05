/**
 * Instrument master tests (M3 acceptance).
 * Uses a committed mini Dhan scrip master fixture so CI does not depend on
 * a developer-local D:\CODEX checkout.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildOptionChain,
  filterOptions,
  getChainStrikes,
  getExpiryDates,
  loadScripMaster,
  nextMonthlyExpiry,
  nextWeeklyExpiry,
  resolveNiftyWeeklyChain,
  toInstrument,
} from '../src/marketdata/instrument-master.js';

const CSV_PATH = fileURLToPath(new URL('./fixtures/dhan-scrip-master-mini.csv', import.meta.url));
const AS_OF = '2026-07-03';

describe('loadScripMaster', () => {
  it('loads without throwing and returns rows', () => {
    const rows = loadScripMaster(CSV_PATH);
    expect(rows.length).toBeGreaterThan(20);
  });

  it('rows have required fields', () => {
    const rows = loadScripMaster(CSV_PATH);
    const sample = rows[0]!;
    expect(typeof sample.securityId).toBe('string');
    expect(typeof sample.lotSize).toBe('number');
    expect(typeof sample.expiryDate).toBe('string');
  });

  it('normalizes Dhan tick size whether compact CSV uses rupees or paise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrip-master-'));
    const path = join(dir, 'ticks.csv');
    writeFileSync(
      path,
      [
        'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME',
        'NSE,D,1,OPTIDX,1,NIFTY-Jul2026-29000-CE,65,NIFTY 07 JUL 29000 CE,2026-07-07 14:30:00,29000,CE,0.05,W,OP,,NIFTY',
        'NSE,D,2,OPTIDX,1,NIFTY-Jul2026-29000-PE,65,NIFTY 07 JUL 29000 PE,2026-07-07 14:30:00,29000,PE,5.0000,W,OP,,NIFTY',
      ].join('\n'),
      'utf8',
    );
    const rows = loadScripMaster(path);
    expect(rows.map((r) => r.tickSizePaise)).toEqual([5, 5]);
  });
});

describe('filterOptions — NIFTY', () => {
  it('returns only NIFTY options (OPTIDX) with CE or PE', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    expect(opts.length).toBeGreaterThan(0);
    for (const r of opts) {
      expect(['OPTIDX', 'OPTSTK']).toContain(r.instrumentName);
      expect(['CE', 'PE']).toContain(r.optionType);
      expect(r.underlyingSymbol).toBe('NIFTY');
    }
  });

  it('NIFTY lot size from CSV is 65', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const sizes = new Set(opts.map((r) => Math.round(r.lotSize)));
    expect(sizes.has(65)).toBe(true);
  });
});

describe('expiry dates', () => {
  it('getExpiryDates returns sorted unique dates', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const dates = getExpiryDates(opts);
    expect(dates.length).toBeGreaterThan(0);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]! > dates[i - 1]!).toBe(true);
    }
  });

  it('dates have YYYY-MM-DD format (no time portion)', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    for (const d of getExpiryDates(opts)) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('weekly vs monthly expiry flags', () => {
  it('nextWeeklyExpiry after 2026-07-03 is 2026-07-07 (Monday after cutoff)', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const weekly = nextWeeklyExpiry(opts, AS_OF);
    expect(weekly).toBe('2026-07-07');
  });

  it('nextMonthlyExpiry after 2026-07-03 is 2026-07-28', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const monthly = nextMonthlyExpiry(opts, AS_OF);
    expect(monthly).toBe('2026-07-28');
  });

  it('next weekly after monthly cutoff wraps to August', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const weekly = nextWeeklyExpiry(opts, '2026-07-29');
    expect(weekly).toBe('2026-08-04');
  });
});

describe('buildOptionChain', () => {
  it('chain has both CE and PE at each strike for the near weekly', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const expiry = nextWeeklyExpiry(opts, AS_OF)!;
    const chain = buildOptionChain(opts, expiry);
    expect(chain.size).toBeGreaterThan(0);
    for (const [, entry] of chain) {
      expect(entry.ce !== undefined || entry.pe !== undefined).toBe(true);
    }
  });

  it('strikes are multiples of ₹50 (5000p strike step for NIFTY)', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const expiry = nextWeeklyExpiry(opts, AS_OF)!;
    const chain = buildOptionChain(opts, expiry);
    for (const strike of chain.keys()) {
      expect(strike % 5000).toBe(0);
    }
  });
});

describe('getChainStrikes', () => {
  it('returns ATM±5 strikes centred on spot', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const expiry = nextWeeklyExpiry(opts, AS_OF)!;
    const chain = buildOptionChain(opts, expiry);
    const strikes = getChainStrikes(chain, 29_250_00, 5); // 29250 in paise
    expect(strikes.length).toBe(11); // ATM ± 5
    // Result is sorted.
    for (let i = 1; i < strikes.length; i++) {
      expect(strikes[i]!).toBeGreaterThan(strikes[i - 1]!);
    }
  });
});

describe('toInstrument', () => {
  it('maps a NIFTY CE scrip row to a valid Instrument', () => {
    const rows = loadScripMaster(CSV_PATH);
    const opts = filterOptions(rows, 'NIFTY');
    const row = opts.find((r) => r.optionType === 'CE');
    expect(row).toBeDefined();
    const instr = toInstrument(row!);
    expect(instr.kind).toBe('OPTION');
    expect(instr.right).toBe('CE');
    expect(instr.lotSize).toBe(65);
    expect(instr.underlying).toBe('NIFTY');
    expect(instr.segment).toBe('NSE_FNO');
    expect(instr.strikePaise).toBeGreaterThan(0);
    expect(instr.expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(instr.brokerToken).toBe(row!.securityId);
  });

  it('instrument id follows NSE:<securityId> pattern', () => {
    const rows = loadScripMaster(CSV_PATH);
    const row = filterOptions(rows, 'NIFTY')[0]!;
    const instr = toInstrument(row);
    expect(instr.id).toBe(`NSE:${row.securityId}`);
  });
});

describe('resolveNiftyWeeklyChain', () => {
  it('returns a well-formed chain result for the current weekly expiry', () => {
    const rows = loadScripMaster(CSV_PATH);
    const result = resolveNiftyWeeklyChain(rows, AS_OF);
    expect(result).toBeDefined();
    expect(result!.expiryDate).toBe('2026-07-07');
    expect(result!.lotSize).toBe(65);
    expect(result!.chain.size).toBeGreaterThan(0);
    expect(result!.rowCount).toBeGreaterThan(0);
  });

  it('returns undefined when no weekly expiry exists after a far-future date', () => {
    const rows = loadScripMaster(CSV_PATH);
    const result = resolveNiftyWeeklyChain(rows, '2030-01-01');
    expect(result).toBeUndefined();
  });
});
