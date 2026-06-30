function normalizeOptionsInstrument(entry = {}) {
  return {
    ...entry,
    exchangeSegment: entry.exchangeSegment || 'NSE_FNO',
    instrument: entry.instrument || 'OPTSTK',
    expiryCode: Number(entry.expiryCode || 0),
    optionType: entry.optionType || 'CE'
  };
}

module.exports = { normalizeOptionsInstrument };
