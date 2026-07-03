import { describe, expect, it } from 'vitest';
import { checkGlobal, checkOption, type EligibilityConfig } from '../src/strategy/eligibility.js';
import { ATM_STRIKE, CE_ID, mkRow } from './helpers/strategy-fixtures.js';

const cfg: EligibilityConfig = {
  entryWindows: [{ from: '09:20', to: '15:00' }],
  blackoutDates: new Set(['2026-07-15']),
  maxSpreadPct: 0.015,
  minOi: 1_000,
  minVolume: 1_000,
  strikeBand: 5,
  strikeStepPaise: 5_000,
};

describe('checkGlobal', () => {
  const base = { nowHHMM: '10:00', todayDate: '2026-07-03', highVolDay: false };

  it('passes inside the entry window on a normal day', () => {
    expect(checkGlobal(cfg, base).pass).toBe(true);
  });

  it('ENTRY_WINDOW before 09:20 (opening chaos skipped)', () => {
    const r = checkGlobal(cfg, { ...base, nowHHMM: '09:16' });
    expect(r).toMatchObject({ pass: false, reason: 'ENTRY_WINDOW' });
  });

  it('ENTRY_WINDOW after 15:00 (entry cutoff)', () => {
    const r = checkGlobal(cfg, { ...base, nowHHMM: '15:01' });
    expect(r).toMatchObject({ pass: false, reason: 'ENTRY_WINDOW' });
  });

  it('BLACKOUT_DAY on a configured event date', () => {
    const r = checkGlobal(cfg, { ...base, todayDate: '2026-07-15' });
    expect(r).toMatchObject({ pass: false, reason: 'BLACKOUT_DAY' });
  });

  it('HIGH_VOL_DAY when the regime flags the day (CODEX robustness filter)', () => {
    const r = checkGlobal(cfg, { ...base, highVolDay: true });
    expect(r).toMatchObject({ pass: false, reason: 'HIGH_VOL_DAY' });
  });
});

describe('checkOption', () => {
  const row = mkRow(CE_ID, 'CE');

  it('passes a liquid ATM option aligned with the trend', () => {
    expect(checkOption(cfg, { right: 'CE', trend: 1, row, atmStrikePaise: ATM_STRIKE }).pass).toBe(true);
    expect(checkOption(cfg, { right: 'CE', trend: 0, row, atmStrikePaise: ATM_STRIKE }).pass).toBe(true);
  });

  it('TREND_GATE blocks CE in a downtrend and PE in an uptrend', () => {
    expect(checkOption(cfg, { right: 'CE', trend: -1, row })).toMatchObject({ pass: false, reason: 'TREND_GATE' });
    expect(checkOption(cfg, { right: 'PE', trend: 1, row: mkRow(CE_ID, 'PE') })).toMatchObject({ pass: false, reason: 'TREND_GATE' });
  });

  it('NO_OPTION_QUOTE without a two-sided quote', () => {
    expect(checkOption(cfg, { right: 'CE', trend: 0 })).toMatchObject({ pass: false, reason: 'NO_OPTION_QUOTE' });
    const oneSided = mkRow(CE_ID, 'CE', { bidPaise: 0 });
    expect(checkOption(cfg, { right: 'CE', trend: 0, row: oneSided })).toMatchObject({ pass: false, reason: 'NO_OPTION_QUOTE' });
  });

  it('SPREAD_GATE on a blown spread (the #1 scalping cost)', () => {
    const wide = mkRow(CE_ID, 'CE', { bidPaise: 14_000, askPaise: 16_000 });
    expect(checkOption(cfg, { right: 'CE', trend: 0, row: wide })).toMatchObject({ pass: false, reason: 'SPREAD_GATE' });
  });

  it('LIQUIDITY_FLOOR on thin OI/volume', () => {
    const thin = mkRow(CE_ID, 'CE', { oi: 10, volume: 10 });
    expect(checkOption(cfg, { right: 'CE', trend: 0, row: thin })).toMatchObject({ pass: false, reason: 'LIQUIDITY_FLOOR' });
  });

  it('STRIKE_BAND beyond ATM±band', () => {
    const far = mkRow(CE_ID, 'CE', { strikePaise: ATM_STRIKE + 6 * 5_000 });
    expect(checkOption(cfg, { right: 'CE', trend: 0, row: far, atmStrikePaise: ATM_STRIKE })).toMatchObject({
      pass: false,
      reason: 'STRIKE_BAND',
    });
  });
});
