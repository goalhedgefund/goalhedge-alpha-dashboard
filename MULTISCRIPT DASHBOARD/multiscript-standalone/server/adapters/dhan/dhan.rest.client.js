function createDhanRestClient({ restUrl, accessToken }) {
  const base = restUrl.replace(/\/$/, '');

  async function postJson(pathname, body) {
    const res = await fetch(`${base}/v2${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access-token': accessToken
      },
      body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  return {
    async getIntradayCandles({ securityId, exchangeSegment, instrument = 'EQUITY', interval = '15', fromDate, toDate, oi = false }) {
      return postJson('/charts/intraday', {
        securityId: String(securityId),
        exchangeSegment,
        instrument,
        interval: String(interval),
        oi: Boolean(oi),
        fromDate,
        toDate
      });
    },
    async getDailyCandles({ securityId, exchangeSegment, instrument = 'EQUITY', fromDate, toDate, oi = false, expiryCode = 0 }) {
      return postJson('/charts/historical', {
        securityId: String(securityId),
        exchangeSegment,
        instrument,
        expiryCode,
        oi: Boolean(oi),
        fromDate,
        toDate
      });
    }
  };
}

module.exports = { createDhanRestClient };
