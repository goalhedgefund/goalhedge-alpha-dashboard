const path = require('node:path');
const { env } = require('./env');

function getLoggingConfig(mode = 'LIVE') {
  const baseDir = String(mode || 'LIVE').toUpperCase() === 'REPLAY' ? env.replayLogDir : env.logDir;
  return {
    mode: String(mode || 'LIVE').toUpperCase(),
    logDir: baseDir,
    tradeFiles: {
      '1': path.join(baseDir, 'live-trades-1min.xlsx'),
      '5': path.join(baseDir, 'live-trades-5min.xlsx'),
      '15': path.join(baseDir, 'live-trades-15min.xlsx'),
      '60': path.join(baseDir, 'live-trades-60min.xlsx'),
      D: path.join(baseDir, 'live-trades-daily.xlsx')
    }
  };
}

module.exports = { getLoggingConfig };
