const { EventEmitter } = require('node:events');

function createStateStore(initial = {}) {
  const emitter = new EventEmitter();
  const state = {
    mode: 'LIVE',
    replayRange: { from: null, to: null },
    runnerState: 'IDLE',
    connectionState: 'DISCONNECTED',
    startedAt: null,
    lastUpdatedAt: Date.now(),
    symbols: [],
    legs: [],
    ...initial
  };

  function patch(next = {}) {
    Object.assign(state, next, { lastUpdatedAt: Date.now() });
    emitter.emit('change', getState());
  }

  function getState() {
    return JSON.parse(JSON.stringify(state));
  }

  return {
    patch,
    getState,
    emitter
  };
}

module.exports = { createStateStore };
