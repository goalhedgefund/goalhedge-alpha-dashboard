const path = require('node:path');
const dotenv = require('dotenv');

const rootDir = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const env = {
  rootDir,
  clientDir: path.join(rootDir, 'client'),
  serverDir: path.join(rootDir, 'server'),
  dataDir: path.join(rootDir, 'data'),
  logDir: path.join(rootDir, 'data', 'trade-logs'),
  replayLogDir: path.join(rootDir, 'data', 'trade-logs', 'replay'),
  replaySourceDir: process.env.MULTISCRIPT_REPLAY_SOURCE_DIR || 'D:\\CODEX\\data\\futures-eligible-cash-candles',
  replayCacheDir: path.join(rootDir, 'data', 'replay-cache'),
  port: num(process.env.PORT, 3001),
  host: process.env.HOST || '127.0.0.1',
  dhanClientId: process.env.DHAN_CLIENT_ID || '',
  dhanAccessToken: process.env.DHAN_ACCESS_TOKEN || '',
  dhanWsUrl: process.env.DHAN_WS_URL || 'wss://api-feed.dhan.co',
  dhanRestUrl: process.env.DHAN_REST_URL || 'https://api.dhan.co',
  dhanAuthType: process.env.DHAN_AUTH_TYPE || '2',
  dhanWsVersion: process.env.DHAN_WS_VERSION || '2',
  dhanRequestCode: num(process.env.DHAN_REQUEST_CODE, 15),
  autoStart: bool(process.env.MULTISCRIPT_AUTO_START, false),
  defaultMode: String(process.env.MULTISCRIPT_DEFAULT_MODE || 'LIVE').toUpperCase(),
  maxSymbols: num(process.env.MULTISCRIPT_MAX_SYMBOLS, 50),
  defaultActivePerFrame: num(process.env.MULTISCRIPT_DEFAULT_ACTIVE_PER_FRAME, 5),
  capital: num(process.env.MULTISCRIPT_CAPITAL, 100000),
  riskPerTrade: num(process.env.MULTISCRIPT_RISK_PER_TRADE, 0.01),
  kellyCap: num(process.env.MULTISCRIPT_KELLY_CAP, 0.25),
  liveRefreshMs: num(process.env.MULTISCRIPT_LIVE_REFRESH_MS, 900),
  candleRefreshMs: num(process.env.MULTISCRIPT_CANDLE_REFRESH_MS, 5000),
  replayLookbackDays: num(process.env.MULTISCRIPT_REPLAY_LOOKBACK_DAYS, 7),
  replaySpeedMultiplier: num(process.env.MULTISCRIPT_REPLAY_SPEED_MULTIPLIER, 120)
};

module.exports = { env, rootDir, num, bool };
