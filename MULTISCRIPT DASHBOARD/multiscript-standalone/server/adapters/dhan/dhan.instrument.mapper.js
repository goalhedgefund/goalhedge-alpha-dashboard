const DEFAULT_INSTRUMENT = 'EQUITY';

function resolveDhanInstrument(entry = {}) {
  if (entry.instrument) return entry.instrument;
  if (entry.segmentType === 'FNO' || entry.isDerivative) return 'FUTSTK';
  return DEFAULT_INSTRUMENT;
}

function resolveDhanExchangeSegment(entry = {}) {
  return entry.exchange || entry.exchangeSegment || 'NSE_EQ';
}

function resolveDhanSecurityId(entry = {}) {
  return String(entry.secId || entry.securityId || entry.symbolId || '');
}

function normalizeDhanInstrument(entry = {}) {
  return {
    symbol: entry.symbol,
    name: entry.name || entry.symbol,
    exchangeSegment: resolveDhanExchangeSegment(entry),
    securityId: resolveDhanSecurityId(entry),
    instrument: resolveDhanInstrument(entry),
    expiryCode: Number(entry.expiryCode || 0),
    optionType: entry.optionType || '',
    strikePrice: entry.strikePrice || ''
  };
}

module.exports = {
  normalizeDhanInstrument,
  resolveDhanExchangeSegment,
  resolveDhanSecurityId,
  resolveDhanInstrument
};
