'use strict';
/**
 * economics.js — ONE place that defines trade-level economics for the whole
 * system. simulate.js, optimizer.js, index.js and excel-export.js all import
 * from here so gross/net/turnover/cost can never disagree between the backtest,
 * the optimizer ranking, the trade log and the Excel export.
 *
 * Business rules (from the project brief):
 *   - Intraday exchange charge: 0.03521% of turnover.
 *   - Daily (delivery) exchange charge: 0.2222% of turnover.
 *   - Turnover is round-trip: entry notional + exit notional (both legs).
 *
 * If only the rate or turnover convention ever changes, edit it here once.
 */

const EXCHANGE_RATES = Object.freeze({
  intraday: 0.0003521, // 0.03521%
  daily: 0.002222,     // 0.2222%
});

/** Build a normalised cost config from whatever index.js passes in. */
function makeCostConfig(opts = {}) {
  const mode = opts.mode === 'daily' ? 'daily' : 'intraday'; // scalping ⇒ intraday default
  return Object.freeze({
    enabled: !!opts.enabled,
    mode,
    rate: EXCHANGE_RATES[mode],
  });
}

function exchangeRate(mode) {
  return EXCHANGE_RATES[mode === 'daily' ? 'daily' : 'intraday'];
}

/** Round-trip turnover for a position. */
function turnoverOf(entryPrice, exitPrice, qty) {
  return Math.abs(entryPrice * qty) + Math.abs(exitPrice * qty);
}

/**
 * Derive a share quantity for a trade when the simulator hasn't already sized
 * it. Prefers an explicit qty; else risk-based sizing (riskAmt / stop distance);
 * else falls back to 1 share so everything still works in pure R-multiple mode.
 */
function deriveQty(trade) {
  if (Number.isFinite(trade.qty) && trade.qty > 0) return trade.qty;
  const entry = trade.entryPrice ?? trade.entry ?? null;
  const stop = trade.stopPrice ?? trade.slPrice ?? trade.sl ?? null;
  const stopDist = Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) : NaN;
  if (Number.isFinite(trade.riskAmt) && stopDist > 0) return trade.riskAmt / stopDist;
  return 1;
}

/**
 * Compute the full economics for a single trade. Returns a plain object you can
 * spread onto the trade. Never mutates its input.
 *
 * trade needs: entryPrice, exitPrice, side ('long'|'short'); optionally qty,
 *              riskAmt, stopPrice.
 */
function tradeEconomics(trade, costCfg) {
  const cfg = costCfg && costCfg.rate != null ? costCfg : makeCostConfig(costCfg);
  const qty = deriveQty(trade);
  const entry = trade.entryPrice ?? trade.entry ?? 0;
  const exit = trade.exitPrice ?? trade.exit ?? 0;
  const dir = (trade.side === 'short' || trade.dir === 'SHORT') ? -1 : 1;

  const grossCashPnl = (exit - entry) * qty * dir;
  const turnover = turnoverOf(entry, exit, qty);
  const exchangeCost = cfg.enabled ? turnover * cfg.rate : 0;
  const netCashPnl = grossCashPnl - exchangeCost;

  // R-multiples are scale-free and what the optimizer ranks on. If we know the
  // risk amount we express P&L in units of risk; otherwise leave them null and
  // the optimizer will fall back to cash or raw pnl.
  const riskAmt = Number.isFinite(trade.riskAmt) ? trade.riskAmt
    : (Number.isFinite(trade.rRisk) ? trade.rRisk : null);
  const grossR = riskAmt && riskAmt > 0 ? grossCashPnl / riskAmt : null;
  const netR = riskAmt && riskAmt > 0 ? netCashPnl / riskAmt : null;

  return { qty, turnover, grossCashPnl, exchangeCost, netCashPnl, riskAmt, grossR, netR };
}

/** Enrich an array of trades (returns a new array; originals untouched). */
function enrichTrades(trades, costCfg) {
  const cfg = makeCostConfig(costCfg);
  return trades.map((t) => ({ ...t, ...tradeEconomics(t, cfg) }));
}

/** Gross / net totals for a (preferably already enriched) trade list. */
function summarizeEconomics(trades) {
  let gross = 0, net = 0, cost = 0, turnover = 0;
  for (const t of trades) {
    const e = (t.grossCashPnl != null) ? t : tradeEconomics(t, { enabled: true });
    gross += e.grossCashPnl || 0;
    net += (e.netCashPnl != null ? e.netCashPnl : e.grossCashPnl) || 0;
    cost += e.exchangeCost || 0;
    turnover += e.turnover || 0;
  }
  return { grossCashPnl: gross, netCashPnl: net, exchangeCost: cost, turnover };
}

module.exports = {
  EXCHANGE_RATES,
  makeCostConfig,
  exchangeRate,
  turnoverOf,
  deriveQty,
  tradeEconomics,
  enrichTrades,
  summarizeEconomics,
};
