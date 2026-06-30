const { EventEmitter } = require('node:events');
const { decodeDhanBuffer } = require('./dhan.packet.decoder');

class DhanWsClient extends EventEmitter {
  constructor({ wsUrl, clientId, accessToken, authType = '2', version = '2', requestCode = 15 }) {
    super();
    this.wsUrl = wsUrl;
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.authType = authType;
    this.version = version;
    this.requestCode = requestCode;
    this.socket = null;
    this.connected = false;
    this.subscriptions = [];
    this.reconnectDelayMs = 3000;
    this.keepAlive = null;
    this.shouldReconnect = true;
  }

  getUrl() {
    const url = new URL(this.wsUrl);
    url.searchParams.set('version', this.version);
    url.searchParams.set('token', this.accessToken);
    url.searchParams.set('clientId', this.clientId);
    url.searchParams.set('authType', this.authType);
    return url.toString();
  }

  connect() {
    if (!this.clientId || !this.accessToken) {
      this.emit('error', new Error('Missing Dhan clientId or accessToken'));
      return;
    }
    if (this.socket && this.connected) return;

    this.shouldReconnect = true;
    const socket = new WebSocket(this.getUrl());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connected = true;
      this.emit('open');
      this.flushSubscriptions();
      this.startKeepAlive();
    });

    socket.addEventListener('message', async (event) => {
      let payload = event.data;
      if (payload instanceof Blob) payload = await payload.arrayBuffer();
      const packets = decodeDhanBuffer(payload);
      for (const packet of packets) {
        this.emit('packet', packet);
      }
    });

    socket.addEventListener('close', () => {
      this.connected = false;
      this.stopKeepAlive();
      this.emit('close');
      if (this.shouldReconnect) this.scheduleReconnect();
    });

    socket.addEventListener('error', (error) => {
      this.emit('error', error);
    });
  }

  scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.shouldReconnect) this.connect();
    }, this.reconnectDelayMs);
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAlive = setInterval(() => {
      if (this.socket && this.connected && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ RequestCode: 1, Message: 'PING' }));
        } catch (err) {
          this.emit('error', err);
        }
      }
    }, 25000);
  }

  stopKeepAlive() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  subscribe(instruments) {
    this.subscriptions = instruments.slice();
    this.flushSubscriptions();
  }

  flushSubscriptions() {
    if (!this.socket || !this.connected || !this.subscriptions.length) return;
    const chunks = [];
    for (let i = 0; i < this.subscriptions.length; i += 100) {
      chunks.push(this.subscriptions.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      const request = {
        RequestCode: this.requestCode,
        InstrumentCount: chunk.length,
        InstrumentList: chunk.map((item) => ({
          ExchangeSegment: item.exchangeSegment,
          SecurityId: String(item.securityId)
        }))
      };
      this.socket.send(JSON.stringify(request));
    }
  }

  close() {
    this.shouldReconnect = false;
    this.stopKeepAlive();
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ RequestCode: 12 }));
      } catch (err) {
        this.emit('error', err);
      }
    }
    if (this.socket) this.socket.close();
    this.socket = null;
    this.connected = false;
  }
}

module.exports = { DhanWsClient };
