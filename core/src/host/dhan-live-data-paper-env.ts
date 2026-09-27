import { existsSync, readFileSync } from 'node:fs';

export const DHAN_DEFAULT_ENV_PATH = 'D:\\Claude\\workstation\\secrets\\dhan\\.env';
export const DHAN_DEFAULT_WS_URL = 'wss://api-feed.dhan.co';
export const DHAN_DEFAULT_HUB_WS_URL = 'ws://127.0.0.1:8795';

export type FeedSource = 'hub' | 'dhan' | 'replay';
export type SharedMarketHubMode = 'off' | 'shadow' | 'consume';

export const VALID_HUB_CONSUMER_IDS = [
  's1',
  's2',
  'all-op',
  'op-minus',
  'ex-s1',
  'arb',
  'dh',
  'vol-short',
  'cash-scalp',
] as const;

export type SharedMarketHubConsumerId = (typeof VALID_HUB_CONSUMER_IDS)[number];

export interface DhanLiveDataPaperEnv {
  envPath: string;
  wsUrl: string;
  clientId: string;
  accessToken: string;
  scripMasterPath: string;
  underlyingSymbol: string;
  strategyId: string;
  consumerId: SharedMarketHubConsumerId;
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
  feedSource: FeedSource;
  hubWsUrl: string;
  useSharedMarketHub: boolean;
  hubMode: SharedMarketHubMode;
  hubConsumers: SharedMarketHubConsumerId[];
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

export function parseUseSharedMarketHub(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const val = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(val)) return true;
  if (['0', 'false', 'no', 'off'].includes(val)) return false;
  throw new Error(`USE_SHARED_MARKET_HUB must be a boolean (true/false, 1/0, yes/no, on/off), got "${raw}"`);
}

export function parseSharedMarketHubMode(raw: string | undefined, enabled: boolean): SharedMarketHubMode {
  if (!enabled) return 'off';
  if (raw === undefined || raw.trim() === '') {
    throw new Error('SHARED_MARKET_HUB_MODE is required when USE_SHARED_MARKET_HUB is true. Must be "off", "shadow", or "consume".');
  }
  const val = raw.trim().toLowerCase();
  if (val === 'off' || val === 'shadow' || val === 'consume') return val;
  throw new Error(`Invalid SHARED_MARKET_HUB_MODE "${raw}". Must be one of: off, shadow, consume.`);
}

export function parseHubConsumers(raw: string | undefined): SharedMarketHubConsumerId[] {
  if (raw === undefined || raw.trim() === '') return [];
  const parts = raw.split(',').map((p) => p.trim().toLowerCase()).filter((p) => p !== '');
  const seen = new Set<SharedMarketHubConsumerId>();
  for (const part of parts) {
    if (!(VALID_HUB_CONSUMER_IDS as readonly string[]).includes(part)) {
      throw new Error(`Unknown consumer ID "${part}". Valid consumer IDs are: ${VALID_HUB_CONSUMER_IDS.join(', ')}`);
    }
    seen.add(part as SharedMarketHubConsumerId);
  }
  return Array.from(seen);
}

export function strategyIdToConsumerId(strategyId: string): SharedMarketHubConsumerId {
  switch (strategyId) {
    case 's1-momentum-burst':
      return 's1';
    case 's2-vwap-fade':
      return 's2';
    case 'allop-atm-mm':
      return 'all-op';
    case 'op-minus-atm-short':
      return 'op-minus';
    default:
      if ((VALID_HUB_CONSUMER_IDS as readonly string[]).includes(strategyId)) {
        return strategyId as SharedMarketHubConsumerId;
      }
      throw new Error(
        `Cannot map strategyId "${strategyId}" to a valid consumer ID. Valid IDs are: ${VALID_HUB_CONSUMER_IDS.join(', ')}`,
      );
  }
}

function parseSingleConsumerId(raw: string): SharedMarketHubConsumerId {
  const normalized = raw.trim().toLowerCase();
  if (!(VALID_HUB_CONSUMER_IDS as readonly string[]).includes(normalized)) {
    throw new Error(`Unknown consumer ID "${raw}". Valid consumer IDs are: ${VALID_HUB_CONSUMER_IDS.join(', ')}`);
  }
  return normalized as SharedMarketHubConsumerId;
}

export function loadDhanLiveDataPaperEnv(source: NodeJS.ProcessEnv = process.env): DhanLiveDataPaperEnv {
  const envPath = source.DHAN_ENV_PATH?.trim() || DHAN_DEFAULT_ENV_PATH;
  const fileVars = existsSync(envPath) ? parseDhanEnvText(readFileSync(envPath, 'utf8')) : {};
  const vars: Record<string, string> = { ...fileVars };
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) vars[key] = value;
  }

  const initialSpotPaise = parseInitialSpotPaise(vars);
  const strategyId = getStrategyId(vars, 'DHAN_STRATEGY_ID', 's1-momentum-burst');

  const rawConsumerId = vars.SHARED_MARKET_HUB_CONSUMER_ID ?? vars.CONSUMER_ID;
  const consumerId: SharedMarketHubConsumerId = rawConsumerId
    ? parseSingleConsumerId(rawConsumerId)
    : strategyIdToConsumerId(strategyId);

  const useSharedMarketHub = parseUseSharedMarketHub(vars.USE_SHARED_MARKET_HUB);
  const hubMode = parseSharedMarketHubMode(vars.SHARED_MARKET_HUB_MODE, useSharedMarketHub);
  const hubConsumers = parseHubConsumers(vars.SHARED_MARKET_HUB_CONSUMERS);

  const rawFeedSource = (vars.FEED_SOURCE ?? vars.DHAN_FEED_SOURCE)?.trim().toLowerCase();
  let feedSource: FeedSource;

  if (rawFeedSource !== undefined && rawFeedSource !== '') {
    if (rawFeedSource !== 'hub' && rawFeedSource !== 'dhan' && rawFeedSource !== 'replay') {
      throw new Error(`Invalid FEED_SOURCE "${rawFeedSource}". Must be one of: hub, dhan, replay.`);
    }
    if (rawFeedSource === 'replay') {
      feedSource = 'replay';
    } else if (rawFeedSource === 'hub') {
      if (!useSharedMarketHub || hubMode === 'off') {
        throw new Error('FEED_SOURCE="hub" cannot be used when USE_SHARED_MARKET_HUB is false/off');
      }
      if (hubMode === 'shadow') {
        throw new Error(
          'FEED_SOURCE="hub" cannot be consumed when SHARED_MARKET_HUB_MODE="shadow". Shadow mode keeps strategies on legacy feeds.',
        );
      }
      // consume mode
      if (!hubConsumers.includes(consumerId)) {
        throw new Error(
          `FEED_SOURCE="hub" requested, but consumer "${consumerId}" is not in SHARED_MARKET_HUB_CONSUMERS.`,
        );
      }
      feedSource = 'hub';
    } else {
      feedSource = 'dhan';
    }
  } else {
    // When FEED_SOURCE is absent:
    // Default to 'dhan' unless USE_SHARED_MARKET_HUB=true, mode=consume, and consumer is allow-listed.
    if (useSharedMarketHub && hubMode === 'consume' && hubConsumers.includes(consumerId)) {
      feedSource = 'hub';
    } else {
      feedSource = 'dhan';
    }
  }

  const hubWsUrl = getString(
    vars,
    'SHARED_MARKET_HUB_URL',
    getString(vars, 'DHAN_HUB_WS_URL', getString(vars, 'HUB_WS_URL', DHAN_DEFAULT_HUB_WS_URL)),
  );

  return {
    envPath,
    wsUrl: getString(vars, 'DHAN_WS_URL', DHAN_DEFAULT_WS_URL),
    clientId: requireString(vars, 'DHAN_CLIENT_ID', envPath),
    accessToken: requireString(vars, 'DHAN_ACCESS_TOKEN', envPath),
    scripMasterPath: requireString(vars, 'DHAN_SCRIP_MASTER_PATH', envPath),
    underlyingSymbol: getString(vars, 'DHAN_UNDERLYING_SYMBOL', 'NIFTY').toUpperCase(),
    strategyId,
    consumerId,
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
    feedSource,
    hubWsUrl,
    useSharedMarketHub,
    hubMode,
    hubConsumers,
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
