function createExchangeAdapter(kind, options = {}) {
  return {
    kind,
    options,
    resolveInstrument() {
      throw new Error(`resolveInstrument not implemented for ${kind}`);
    },
    createFeedClient() {
      throw new Error(`createFeedClient not implemented for ${kind}`);
    }
  };
}

module.exports = { createExchangeAdapter };
