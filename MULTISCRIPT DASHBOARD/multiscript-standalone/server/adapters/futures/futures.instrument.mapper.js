function normalizeFuturesInstrument(entry = {}) {
  return {
    ...entry,
    exchangeSegment: entry.exchangeSegment || 'NSE_FNO',
    instrument: entry.instrument || 'FUTSTK',
    expiryCode: Number(entry.expiryCode || 0)
  };
}

module.exports = { normalizeFuturesInstrument };
