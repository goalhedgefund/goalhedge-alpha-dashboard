const fs = require('node:fs');
const path = require('node:path');
const { env } = require('../server/config/env');
const timeframeConfig = require('../server/config/timeframe.config');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

const optimizedDir = path.join(env.dataDir, 'optimized');
const files = timeframeConfig.map((item) => ({
  timeframe: item.key,
  file: path.join(optimizedDir, `${item.timeframe}.json`),
  exists: fs.existsSync(path.join(optimizedDir, `${item.timeframe}.json`))
}));

console.log('Standalone package probe');
console.log(`Root: ${env.rootDir}`);
console.log(`Dhan clientId present: ${Boolean(env.dhanClientId)}`);
console.log(`Dhan token present: ${Boolean(env.dhanAccessToken)}`);
console.log(`WebSocket URL: ${env.dhanWsUrl}`);
console.log(`Data dir: ${env.dataDir}`);
console.log('Timeframe files:');
for (const item of files) {
  const data = readJson(item.file, []);
  console.log(`- ${item.timeframe}: ${item.exists ? 'ok' : 'missing'} (${Array.isArray(data) ? data.length : Object.keys(data || {}).length} entries)`);
}
console.log(`Trade log files configured: ${Object.keys(require('../server/config/logging.config').tradeFiles).length}`);
