/**
 * OP(-) naked short-option desk launcher: strategy op-minus-atm-short on
 * gateway port 8704. Explicit DHAN_* environment variables still win.
 */
process.env.DHAN_STRATEGY_ID ??= 'op-minus-atm-short';
process.env.DHAN_GATEWAY_PORT ??= '8704';

await import('./dhan-live-data-paper.js');
