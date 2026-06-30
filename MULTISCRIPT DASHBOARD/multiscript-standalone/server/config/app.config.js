const { env } = require('./env');

module.exports = {
  appName: 'Multiscript Standalone',
  version: '1.0.0',
  maxSymbols: env.maxSymbols,
  defaultActivePerFrame: env.defaultActivePerFrame,
  autoStart: env.autoStart,
  liveRefreshMs: env.liveRefreshMs,
  candleRefreshMs: env.candleRefreshMs
};
