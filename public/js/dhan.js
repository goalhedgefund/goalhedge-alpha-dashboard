// ── CLAUDE Scalping — Dhan API Client ─────────────────────────────────
'use strict';

const DhanAPI = (() => {
  let _clientId   = '';
  let _token      = '';
  let _baseUrl    = '';   // set to window.location.origin

  function init(clientId, token, baseUrl = window.location.origin) {
    _clientId = clientId;
    _token    = token;
    _baseUrl  = baseUrl;
  }

  function headers() {
    return {
      'Content-Type': 'application/json',
      'client-id':    _clientId,
      'access-token': _token
    };
  }

  async function post(endpoint, body) {
    const url = `${_baseUrl}/dhan${endpoint}`;
    const res = await fetch(url, {
      method:  'POST',
      headers: headers(),
      body:    JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.message || err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function get(endpoint, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = `${_baseUrl}/dhan${endpoint}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.message || err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── Market Data ────────────────────────────────────────────────────
  // Dhan's marketfeed responses wrap everything in a top-level "data" key:
  //   { "data": { "NSE_EQ": { "11536": { "last_price": 4520 } } }, "status": "success" }
  // Security IDs are returned as string keys. Missing this outer "data"
  // wrapper was the actual root cause of "Price not found" on Connect —
  // the price WAS in the response the whole time, just one level deeper
  // than this code was looking.
  async function getLTP(exchange, securityIds) {
    const body = {};
    body[exchange] = securityIds.map(Number);
    const res = await post('/v2/marketfeed/ltp', body);
    const data = res.data || res;   // unwrap "data" if present, fall back to raw response just in case
    const exchData = data[exchange] || {};
    const result   = {};
    for (const id of securityIds) {
      const entry = exchData[id] || exchData[String(id)] || {};
      result[id]  = parseFloat(entry.last_price || entry.ltp || entry.LTP || 0);
    }
    return result;
  }

  async function getOHLC(exchange, securityIds) {
    const body = {};
    body[exchange] = securityIds.map(Number);
    const res      = await post('/v2/marketfeed/ohlc', body);
    const data     = res.data || res;
    const exchData = data[exchange] || {};
    return exchData;
  }

  async function getQuote(exchange, securityIds) {
    const body = {};
    body[exchange] = securityIds.map(Number);
    const res      = await post('/v2/marketfeed/quote', body);
    const data     = res.data || res;
    const exchData = data[exchange] || {};
    return exchData;
  }

  // ── Historical Candles ─────────────────────────────────────────────
  async function getHistorical({ securityId, exchange = 'NSE_EQ', fromDate, toDate }) {
    const data = await post('/v2/charts/historical', {
      securityId:      String(securityId),
      exchangeSegment: exchange,
      instrument:      'EQUITY',
      expiryCode:      0,
      oi:              false,
      fromDate,
      toDate
    });
    return parseHistorical(data);
  }

  async function getIntraday({ securityId, exchange = 'NSE_EQ', fromDate, toDate }) {
    const data = await post('/v2/charts/intraday', {
      securityId:      String(securityId),
      exchangeSegment: exchange,
      instrument:      'EQUITY',
      interval:        '1',
      fromDate,
      toDate
    });
    return parseHistorical(data);
  }

  function parseHistorical(raw) {
    const open  = raw.open      || raw.c_open      || [];
    const high  = raw.high      || raw.c_high      || [];
    const low   = raw.low       || raw.c_low       || [];
    const close = raw.close     || raw.c_close     || [];
    const vol   = raw.volume    || raw.c_volume    || [];
    const ts    = raw.timestamp || raw.start_Time  || [];
    return open.map((o, i) => ({
      ts:    ts[i],
      o:     parseFloat(o),
      h:     parseFloat(high[i]),
      l:     parseFloat(low[i]),
      c:     parseFloat(close[i]),
      v:     parseInt(vol[i] || 0)
    })).filter(c => c.o > 0 && c.c > 0);
  }

  // ── Instrument search via local server ─────────────────────────────
  async function searchSecurities(query, exchange = '') {
    const baseUrl = window.CLAUDE_BASE || window.location.origin;
    const params  = new URLSearchParams({ q: query, limit: 50 });
    if (exchange) params.set('exchange', exchange);
    const res  = await fetch(`${baseUrl}/api/securities?${params}`);
    const data = await res.json();
    return data.items || [];
  }

  async function getAllSecurities(exchange = '') {
    const baseUrl = window.CLAUDE_BASE || window.location.origin;
    const params  = new URLSearchParams({ limit: 10000 });
    if (exchange) params.set('exchange', exchange);
    const res  = await fetch(`${baseUrl}/api/securities?${params}`);
    const data = await res.json();
    return data.items || [];
  }

  // ── Date helpers ───────────────────────────────────────────────────
  function dateStr(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }

  return { init, getLTP, getOHLC, getQuote, getHistorical, getIntraday,
           searchSecurities, getAllSecurities, dateStr };
})();
