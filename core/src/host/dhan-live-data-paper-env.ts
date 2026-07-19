import { existsSync, readFileSync } from 'node:fs';

export const DHAN_DEFAULT_ENV_PATH = 'D:\\DHAN_LOGIN\\.env';
export const DHAN_DEFAULT_WS_URL = 'wss://api-feed.dhan.co';

export interface DhanLiveDataPaperEnv {
  envPath: string;
  wsUrl: string;
  clientId: string;
  accessToken: string;
  scripMasterPath: string;
  underlyingSymbol: string;
  strategyId: string;
  spotSecurityId: string;
  spotExchangeSegment: string;
  optionExchangeSegment: string;
  feedRequestCode: number;
  gatewayPort: number;
  journalRoot: string;
  recorderRoot: string;
  chainDepth: number;
  feedStaleMs: number;
  timerIntervalMs: number;
  autoArm: boolean;
  maxSpreadPct: number;
  minOi: number;
  minVolume: number;
  regimeTrendRet30Pct: number;
  regimeTrendVwapPct: number;
  regimeHighVolRet30Pct: number;
  regimeHighVolAtrPct: number;
  paperSlippageTicks: number;
  paperAckLatencyMs: number;
  paperFillLatencyMs: number;
  initialSpotPaise?: number;
}

export function parseDhanEnvText(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const line = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    parsed[key] = unquoteEnvValue(line.slice(eq + 1).trim());
  }
  return parsed;
}

export function loadDhanLiveDataPaperEnv(source: NodeJS.ProcessEnv = process.env): DhanLiveDataPaperEnv {
  const envPath = source.DHAN_ENV_PATH?.trim() || DHAN_DEFAULT_ENV_PATH;
  const fileVars = existsSync(envPath) ? parseDhanEnvText(readFileSync(envPath, 'utf8')) : {};
  const vars: Record<string, string> = { ...fileVars };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) vars[key] = value;
  }

  const initialSpotPaise = parseInitialSpotPaise(vars);
  return {
    envPath,
    wsUrl: getString(vars, 'DHAN_WS_URL', DHAN_DEFAULT_WS_URL),
    clientId: requireString(vars, 'DHAN_CLIENT_ID', envPath),
    accessToken: requireString(vars, 'DHAN_ACCESS_TOKEN', envPath),
    scripMasterPath: requireString(vars, 'DHAN_SCRIP_MASTER_PATH', envPath),
    underlyingSymbol: getString(vars, 'DHAN_UNDERLYING_SYMBOL', 'NIFTY').toUpperCase(),
    strategyId: getStrategyId(vars, 'DHAN_STRATEGY_ID', 's1-momentum-burst'),
    spotSecurityId: getString(vars, 'DHAN_SPOT_SECURITY_ID', ''),
    spotExchangeSegment: getString(vars, 'DHAN_SPOT_EXCHANGE_SEGMENT', ''),
    optionExchangeSegment: getString(vars, 'DHAN_OPTION_EXCHANGE_SEGMENT', 'NSE_FNO'),
    feedRequestCode: getInt(vars, 'DHAN_FEED_REQUEST_CODE', 21, 1),
    gatewayPort: getInt(vars, 'DHAN_GATEWAY_PORT', 8787, 1),
    journalRoot: getString(vars, 'DHAN_JOURNAL_ROOT', 'journals'),
    recorderRoot: getString(vars, 'DHAN_RECORDER_ROOT', 'data/dhan/ticks'),
    chainDepth: getInt(vars, 'DHAN_CHAIN_DEPTH', 5, 0),
    feedStaleMs: getInt(vars, 'DHAN_FEED_STALE_MS', 5_000, 1),
    timerIntervalMs: getInt(vars, 'DHAN_TIMER_INTERVAL_MS', 250, 1),
    autoArm: getBool(vars, 'DHAN_AUTO_ARM', false),
    maxSpreadPct: getNumber(vars, 'DHAN_MAX_SPREAD_PCT', 0.015, 0),
    minOi: getInt(vars, 'DHAN_MIN_OI', 100, 0),
    minVolume: getInt(vars, 'DHAN_MIN_VOLUME', 100, 0),
    regimeTrendRet30Pct: getNumber(vars, 'DHAN_REGIME_TREND_RET30_PCT', 0.0015, 0),
    regimeTrendVwapPct: getNumber(vars, 'DHAN_REGIME_TREND_VWAP_PCT', 0.0005, 0),
    regimeHighVolRet30Pct: getNumber(vars, 'DHAN_REGIME_HIGH_VOL_RET30_PCT', 0.006, 0),
    regimeHighVolAtrPct: getNumber(vars, 'DHAN_REGIME_HIGH_VOL_ATR_PCT', 0.006, 0),
    paperSlippageTicks: getInt(vars, 'DHAN_PAPER_SLIPPAGE_TICKS', 1, 0),
    paperAckLatencyMs: getInt(vars, 'DHAN_PAPER_ACK_LATENCY_MS', 80, 0),
    paperFillLatencyMs: getInt(vars, 'DHAN_PAPER_FILL_LATENCY_MS', 120, 0),
    ...(initialSpotPaise !== undefined ? { initialSpotPaise } : {}),
  };
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function requireString(vars: Record<string, string>, key: string, envPath: string): string {
  const value = vars[key]?.trim();
  if (value !== undefined && value !== '') return value;
  throw new Error(`${key} is required. Add it to ${envPath} or set it in the process environment.`);
}

function getString(vars: Record<string, string>, key: string, fallback: string): string {
  const value = vars[key]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

function getNumber(vars: Record<string, string>, key: string, fallback: number, min: number): number {
  const raw = vars[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be a number >= ${min}`);
  }
  return value;
}

function getInt(vars: Record<string, string>, key: string, fallback: number, min: number): number {
  const value = getNumber(vars, key, fallback, min);
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function getBool(vars: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = vars[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${key} must be one of true/false, yes/no, on/off, or 1/0`);
}

function getStrategyId(vars: Record<string, string>, key: string, fallback: string): string {
  const value = getString(vars, key, fallback);
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error(`${key} must contain only lowercase letters, numbers, and '-'`);
  }
  return value;
}

function parseInitialSpotPaise(vars: Record<string, string>): number | undefined {
  const paise = vars.DHAN_INITIAL_SPOT_PAISE?.trim();
  if (paise !== undefined && paise !== '') return getInt(vars, 'DHAN_INITIAL_SPOT_PAISE', 0, 1);
  const rupees = vars.DHAN_INITIAL_SPOT_RUPEES?.trim();
  if (rupees === undefined || rupees === '') return undefined;
  return Math.round(getNumber(vars, 'DHAN_INITIAL_SPOT_RUPEES', 0, 1) * 100);
}
