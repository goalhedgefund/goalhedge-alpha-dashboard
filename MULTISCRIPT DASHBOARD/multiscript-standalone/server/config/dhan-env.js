const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const DEFAULT_DHAN_ENV_DIR = 'D:\\DHAN_LOGIN';

function loadDhanEnv(options = {}) {
  const envFile = options.envFile
    || process.env.DHAN_ENV_FILE
    || path.join(process.env.DHAN_ENV_DIR || DEFAULT_DHAN_ENV_DIR, '.env');

  if (!fs.existsSync(envFile)) {
    return { loaded: false, envFile, keys: [] };
  }

  const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf8'));
  const keys = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith('DHAN_')) continue;
    process.env[key] = value;
    keys.push(key);
  }
  return { loaded: true, envFile, keys };
}

module.exports = { loadDhanEnv, DEFAULT_DHAN_ENV_DIR };
