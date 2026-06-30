class CacheStore {
  constructor() {
    this.candles = new Map();
    this.quotes = new Map();
  }

  setCandles(key, value) {
    this.candles.set(key, value);
  }

  getCandles(key) {
    return this.candles.get(key);
  }

  setQuote(key, value) {
    this.quotes.set(key, value);
  }

  getQuote(key) {
    return this.quotes.get(key);
  }
}

module.exports = { CacheStore };
