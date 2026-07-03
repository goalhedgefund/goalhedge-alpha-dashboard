import type { OptionRight } from '../domain/instrument.js';
import type { OptionChainRow } from '../domain/marketdata.js';

/**
 * Strategy-side eligibility filters (the "why not trading now" chain).
 * Pure functions with machine-readable reason codes. First failure wins.
 *
 * The trend gate + high-vol-day block are the port of the CODEX regime
 * filter concept (server/engines/regime.filter.js): never buy CE against a
 * downtrend regime, never buy PE against an uptrend, skip flagged
 * high-volatility days entirely.
 */
export type NoTradeReason =
  | 'ENTRY_WINDOW'
  | 'BLACKOUT_DAY'
  | 'HIGH_VOL_DAY'
  | 'TREND_GATE'
  | 'NO_OPTION_QUOTE'
  | 'SPREAD_GATE'
  | 'LIQUIDITY_FLOOR'
  | 'STRIKE_BAND';

export interface EligibilityConfig {
  /** Inclusive HH:MM windows during which entries are allowed. */
  entryWindows: ReadonlyArray<{ from: string; to: string }>;
  blackoutDates: ReadonlySet<string>;
  maxSpreadPct: number;
  minOi: number;
  minVolume: number;
  strikeBand: number;
  strikeStepPaise: number;
}

export interface GlobalEligibilityInput {
  nowHHMM: string;
  todayDate: string;
  highVolDay: boolean;
}

export type RegimeTrend = -1 | 0 | 1;

export interface OptionEligibilityInput {
  right: OptionRight;
  trend: RegimeTrend;
  row?: OptionChainRow;
  atmStrikePaise?: number;
}

export type EligibilityResult =
  | { pass: true }
  | { pass: false; reason: NoTradeReason; detail?: string };

const PASS: EligibilityResult = { pass: true };

function fail(reason: NoTradeReason, detail?: string): EligibilityResult {
  return { pass: false, reason, ...(detail !== undefined ? { detail } : {}) };
}

/** Filters that need no proposal: run before the strategy is even consulted. */
export function checkGlobal(cfg: EligibilityConfig, g: GlobalEligibilityInput): EligibilityResult {
  const inWindow = cfg.entryWindows.some((w) => g.nowHHMM >= w.from && g.nowHHMM <= w.to);
  if (!inWindow) return fail('ENTRY_WINDOW', g.nowHHMM);
  if (cfg.blackoutDates.has(g.todayDate)) return fail('BLACKOUT_DAY', g.todayDate);
  if (g.highVolDay) return fail('HIGH_VOL_DAY');
  return PASS;
}

/** Filters that need the proposed option: run after the strategy decides. */
export function checkOption(cfg: EligibilityConfig, o: OptionEligibilityInput): EligibilityResult {
  if (o.trend === -1 && o.right === 'CE') return fail('TREND_GATE', 'downtrend blocks CE');
  if (o.trend === 1 && o.right === 'PE') return fail('TREND_GATE', 'uptrend blocks PE');

  const row = o.row;
  if (row === undefined || row.bidPaise <= 0 || row.askPaise <= 0) return fail('NO_OPTION_QUOTE');

  const mid = (row.bidPaise + row.askPaise) / 2;
  const spreadPct = mid > 0 ? (row.askPaise - row.bidPaise) / mid : Infinity;
  if (spreadPct > cfg.maxSpreadPct) return fail('SPREAD_GATE', `spread ${(spreadPct * 100).toFixed(2)}% > ${(cfg.maxSpreadPct * 100).toFixed(2)}%`);

  if (row.oi < cfg.minOi || row.volume < cfg.minVolume) {
    return fail('LIQUIDITY_FLOOR', `oi=${row.oi} vol=${row.volume}`);
  }

  if (o.atmStrikePaise !== undefined) {
    const steps = Math.abs(row.strikePaise - o.atmStrikePaise) / cfg.strikeStepPaise;
    if (steps > cfg.strikeBand) return fail('STRIKE_BAND', `${steps} steps from ATM`);
  }
  return PASS;
}
