const { EventEmitter } = require('node:events');

function normalizeFrameKey(frame) {
  const key = String(frame || '1').toUpperCase();
  if (key === '1M') return '1';
  return key;
}

class ReplayFeedClient extends EventEmitter {
  constructor({ repository, lookbackDays = 7, speedMultiplier = 120, replayRange = null }) {
    super();
    this.repository = repository;
    this.lookbackDays = lookbackDays;
    this.speedMultiplier = Math.max(1, Number(speedMultiplier || 1));
    this.replayRange = replayRange;
    this.subscriptions = [];
    this.connected = false;
    this.shouldRun = false;
    this.timers = new Set();
    this.playing = false;
    this.sourceFrame = '1';
    this._playbackIndex = 0;
    this._currentTs = null; // timestamp of the most recently emitted tick (simulated "now")
  }

  // Simulated current time: the timestamp of the most recently emitted tick.
  // Used by candleService to serve only candles that have actually "happened"
  // by this point in the replay, so trade decisions never see future data.
  getCurrentTimestamp() {
    return this._currentTs;
  }

  connect() {
    this.shouldRun = true;
    this.connected = true;
    this.emit('open');
    this.emit('state', 'REPLAYING');
    if (this.subscriptions.length) {
      this.restartPlayback();
    }
  }

  subscribe(instruments = []) {
    this.subscriptions = instruments.slice();
    if (this.connected) {
      this.restartPlayback();
    }
  }

  setReplayRange(range = null) {
    this.replayRange = range;
    if (this.connected) {
      this.restartPlayback();
    }
  }

  getSelectedSymbols() {
    return this.subscriptions.map((item) => item.symbol || item.tradingSymbol || item.securityId).filter(Boolean);
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  schedule(fn, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delay);
    this.timers.add(timer);
  }

  restartPlayback() {
    this.clearTimers();
    this.playing = false;
    this._playbackIndex = 0;
    this._currentTs = null;
    this.play();
  }

  // Bug 5: timing is relative to the current resume point so pause+resume
  // continues from exactly where playback stopped
  play() {
    if (!this.shouldRun || this.playing) return;
    const symbols = this.getSelectedSymbols();
    if (!symbols.length) {
      this.emit('state', 'REPLAY_WAITING');
      return;
    }
    const ticks = this.repository.buildReplayTicks(symbols, this.sourceFrame, this.replayRange);
    if (!ticks.length) {
      this.emit('error', new Error('No replay data available for the selected symbols'));
      this.emit('state', 'REPLAY_EMPTY');
      return;
    }
    if (this._playbackIndex >= ticks.length) {
      this.emit('state', 'REPLAY_ENDED');
      this.emit('close', 'ended');
      return;
    }

    this.playing = true;
    this.emit('state', 'REPLAYING');

    // Base timing from the current index so resume picks up from the right spot
    const startTs = ticks[this._playbackIndex].timestamp || Date.now();
    const baseWallClock = Date.now();

    // At high speed multipliers, most consecutive ticks compute to a near-zero
    // wall-clock delay (e.g. 60s of 1-minute source time at 20,000x = 3ms).
    // Scheduling one setTimeout per tick in that regime makes per-call timer
    // overhead the bottleneck rather than actual work (observed: a 1-month,
    // 15-symbol replay never finishing in 5+ minutes). Instead, process any
    // tick whose delay is below MIN_SCHEDULE_DELAY_MS synchronously in a tight
    // loop, and only fall back to a real setTimeout for ticks that are
    // genuinely still in the future. MAX_BATCH caps the loop so the event loop
    // still gets to run periodically (HTTP status polls, pause requests, etc).
    const MIN_SCHEDULE_DELAY_MS = 2;
    const MAX_BATCH = 2000;

    const step = () => {
      if (!this.shouldRun) {
        this.playing = false;
        this.emit('state', 'STOPPED');
        return;
      }
      for (let batch = 0; batch < MAX_BATCH; batch += 1) {
        const tick = ticks[this._playbackIndex++];
        if (!tick) {
          this.playing = false;
          this.emit('state', 'REPLAY_ENDED');
          this.emit('close', 'ended');
          return;
        }
        this._currentTs = tick.timestamp;
        this.emit('packet', {
          securityId: tick.securityId,
          exchangeSegment: tick.exchangeSegment,
          symbol: tick.symbol,
          ltp: tick.ltp,
          timestamp: tick.timestamp
        });

        const next = ticks[this._playbackIndex];
        if (!next) {
          this.schedule(step, 0);
          return;
        }

        const elapsedSource = Math.max(0, next.timestamp - startTs);
        const elapsedWall = elapsedSource / this.speedMultiplier;
        const nextDelay = Math.max(0, elapsedWall - (Date.now() - baseWallClock));
        if (nextDelay >= MIN_SCHEDULE_DELAY_MS) {
          this.schedule(step, nextDelay);
          return;
        }
        // else: next tick is due essentially immediately -> keep batching
      }
      // Hit the batch cap while still caught up -> yield to the event loop
      // and resume immediately afterward.
      this.schedule(step, 0);
    };

    this.schedule(step, 0);
  }

  // Bug 5: pause without losing playback position
  pausePlayback() {
    this.shouldRun = false;
    this.playing = false;
    this.clearTimers();
    this.emit('close'); // signals REPLAY_STOPPED upstream; _playbackIndex is preserved
  }

  // Bug 5: resume from the saved position
  resumePlayback() {
    this.shouldRun = true;
    this.connected = true;
    this.emit('open');
    this.emit('state', 'REPLAYING');
    this.play();
  }

  close() {
    this.shouldRun = false;
    this.connected = false;
    this.playing = false;
    this.clearTimers();
    this._playbackIndex = 0; // full reset on close
    this._currentTs = null;
    this.emit('close');
  }
}

module.exports = { ReplayFeedClient };
