/**
 * ALL_OP desk launcher — the Dhan live-data paper runner preconfigured for
 * the ATM market-making desk: strategy allop-atm-mm on gateway port 8703
 * (S1 = 8701, S2 = 8702). Explicit DHAN_* environment variables still win.
 *
 * Run: npm run build -w @scalper/core && npm run paper:live-data:allop -w @scalper/core
 */
process.env.DHAN_STRATEGY_ID ??= 'allop-atm-mm';
process.env.DHAN_GATEWAY_PORT ??= '8703';

await import('./dhan-live-data-paper.js');
