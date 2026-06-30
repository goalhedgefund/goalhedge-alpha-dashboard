const crypto = require('node:crypto');
const { computePositionSize } = require('../engines/risk.engine');

// Formats a timestamp as IST. Accepts an explicit ms timestamp so REPLAY mode
// can log trades against the simulated candle's historical time instead of
// the real wall clock (otherwise every replay trade would be stamped "today",
// making monthly comparison against the backtest impossible).
function nowIST(atMs = Date.now()) {
  const ist = new Date(atMs + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().replace('T', ' ').slice(0, 19);
}

function createTradeService({ getTradeLogger, capital }) {
  function resolveLogger(timeframe) {
    const logger = getTradeLogger(timeframe);
    if (!logger) {
      throw new Error(`Missing trade logger for timeframe ${timeframe}`);
    }
    return logger;
  }

  // `silent`: when true (used for REPLAY warm-up bars — pre-range history
  // loaded purely so indicators are properly converged by the time the
  // user's requested range starts), the trade still fully updates leg state
  // (activeTrade, realizedPnl) for continuity, but is never written to the
  // Excel log. The flag is remembered on the trade itself so closeTrade()
  // (which has no other way to know how a position was opened) also stays
  // silent for that trade's close row, even if the close happens to land
  // after crossing into the visible range.
  function openTrade(leg, signalSnapshot, atMs, silent = false) {
    const side = signalSnapshot.signal;
    if (side === 'WAIT') return null;
    const qtyInfo = computePositionSize({
      capital,
      entryPrice: signalSnapshot.entry,
      stopPrice: signalSnapshot.stop,
      winRate: leg.config?.winRate || 0.55,
      riskPerTrade: signalSnapshot.riskPerTrade || 0.01
    });
    const trade = {
      tradeId: crypto.randomUUID(),
      symbol: leg.symbol,
      timeframe: leg.frame,
      side,
      entryTime: nowIST(atMs),
      entryPrice: signalSnapshot.entry,
      stopPrice: signalSnapshot.stop,
      targetPrice: signalSnapshot.target,
      quantity: qtyInfo.quantity,
      kellyFraction: qtyInfo.kellyFraction,
      rr: signalSnapshot.rr,
      status: 'OPEN',
      realizedPnl: 0,
      silent
    };
    leg.activeTrade = trade;
    if (!silent) {
      resolveLogger(trade.timeframe).appendTradeRow({
        tradeId: trade.tradeId,
        symbol: trade.symbol,
        timeframe: trade.timeframe,
        side: trade.side,
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice,
        quantity: trade.quantity,
        signal: side,
        rr: trade.rr,
        kellyFraction: trade.kellyFraction,
        outcome: 'OPEN',
        notes: 'opened'
      });
    }
    return trade;
  }

  function closeTrade(leg, exitPrice, reason = 'signal flip', atMs) {
    const trade = leg.activeTrade;
    if (!trade) return null;
    const grossPnl = (exitPrice - trade.entryPrice) * trade.quantity * (trade.side === 'SHORT' ? -1 : 1);
    const costs = Math.abs(exitPrice * trade.quantity) * 0.0005;
    const netPnl = grossPnl - costs;
    const closed = {
      ...trade,
      exitTime: nowIST(atMs),
      exitPrice,
      grossPnl,
      costs,
      netPnl,
      status: 'CLOSED',
      reason
    };
    leg.realizedPnl += netPnl;
    leg.activeTrade = null;
    if (!trade.silent) {
      resolveLogger(closed.timeframe).appendTradeRow({
        tradeId: closed.tradeId,
        symbol: closed.symbol,
        timeframe: closed.timeframe,
        side: closed.side,
        entryTime: closed.entryTime,
        entryPrice: closed.entryPrice,
        exitTime: closed.exitTime,
        exitPrice: closed.exitPrice,
        quantity: closed.quantity,
        grossPnl: closed.grossPnl,
        costs: closed.costs,
        netPnl: closed.netPnl,
        outcome: 'CLOSED',
        signal: closed.side,
        rr: closed.rr,
        kellyFraction: closed.kellyFraction,
        notes: reason
      });
    }
    return closed;
  }

  function maybeRollTrade(leg, snapshot, atMs, silent = false) {
    if (snapshot.signal === 'WAIT') {
      if (leg.activeTrade) return closeTrade(leg, snapshot.entry, 'signal wait', atMs);
      return null;
    }

    if (!leg.activeTrade) return openTrade(leg, snapshot, atMs, silent);

    if (leg.activeTrade.side !== snapshot.signal) {
      const closed = closeTrade(leg, snapshot.entry, 'signal flip', atMs);
      openTrade(leg, snapshot, atMs, silent);
      return closed;
    }

    leg.activeTrade.targetPrice = snapshot.target;
    leg.activeTrade.stopPrice = snapshot.stop;
    return leg.activeTrade;
  }

  return {
    openTrade,
    closeTrade,
    maybeRollTrade
  };
}

module.exports = { createTradeService };
