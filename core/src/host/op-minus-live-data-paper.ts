/**
 * OP(-) naked short-option desk launcher: strategy op-minus-atm-short on
 * gateway port 8790. Explicit DHAN_* environment variables still win.
 */
process.env.DHAN_STRATEGY_ID ??= 'op-minus-atm-short';
process.env.DHAN_GATEWAY_PORT ??= '8790';

await import('./dhan-live-data-paper.js');
