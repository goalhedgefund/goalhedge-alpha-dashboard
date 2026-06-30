const fs = require('fs');
const path = require('path');

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

async function main() {
  const base = process.env.PROBE_BASE || 'http://localhost:3001';
  const env = readEnv(path.join(__dirname, '..', '.env'));
  const clientId = env.DHAN_CLIENT_ID;
  const token = env.DHAN_ACCESS_TOKEN;
  if (!clientId || !token) {
    throw new Error('Missing DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN in ../.env');
  }

  const symbols = [
    { symbol: 'SBIN', secId: '3045' },
    { symbol: 'BANDHANBNK', secId: '2263' },
    { symbol: 'DELHIVERY', secId: '9599' },
    { symbol: 'RELIANCE', secId: '2885' },
    { symbol: 'HDFCBANK', secId: '1333' },
    { symbol: 'ICICIBANK', secId: '4963' },
    { symbol: 'AXISBANK', secId: '5900' },
    { symbol: 'TCS', secId: '11536' },
    { symbol: 'INFY', secId: '1594' },
    { symbol: 'TITAN', secId: '3506' }
  ];

  const payload = {
    clientId,
    token,
    exchange: 'NSE_EQ',
    fromDate: '2026-05-27',
    toDate: '2026-06-26',
    timeframe: '15',
    autoOptimize: false,
    includeTradingCost: true,
    positionSizing: { acctSize: 100000, maxRiskPct: 1, kellyFrac: 0.5 }
  };

  const t0 = Date.now();
  const results = await Promise.allSettled(symbols.map(async (s) => {
    const started = Date.now();
    const res = await fetch(`${base}/api/backtest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, securityId: s.secId, symbol: s.symbol })
    });
    const json = await res.json();
    return {
      symbol: s.symbol,
      status: res.status,
      ok: res.ok,
      startedAt: started - t0,
      finishedAt: Date.now() - t0,
      candles: json.candles || 0,
      trades: json.trades || 0,
      warning: json.warning || null,
      error: json.error || null
    };
  }));
  const elapsed = Date.now() - t0;

  console.log(`Base: ${base}`);
  console.log(`Elapsed: ${elapsed} ms`);
  results.forEach((r, i) => {
    const s = symbols[i];
    if (r.status === 'fulfilled') {
      const v = r.value;
      console.log(`${v.symbol}\tstatus=${v.status}\tstart=${v.startedAt}ms\tend=${v.finishedAt}ms\tcandles=${v.candles}\ttrades=${v.trades}\t${v.warning ? `warning=${v.warning}` : ''}`);
    } else {
      console.log(`${s.symbol}\tFAILED\t${r.reason?.message || r.reason}`);
    }
  });
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
