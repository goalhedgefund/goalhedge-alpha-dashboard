const { DhanWsClient } = require('../adapters/dhan/dhan.ws.client');
const { ReplayFeedClient } = require('../adapters/replay/replay.feed.client');

function createFeedService({ exchangeConfig, replayRepository, getMode, getReplayRange, onPacket, onState }) {
  let currentMode = String(getMode?.() || 'LIVE').toUpperCase();
  let currentClient = null;
  let currentInstruments = [];
  let currentReplayRange = typeof getReplayRange === 'function' ? getReplayRange() : null;

  function bindClient(client) {
    client.on('open', () => onState(currentMode === 'REPLAY' ? 'REPLAYING' : 'CONNECTED'));
    client.on('close', (reason) => {
      if (currentMode === 'REPLAY' && reason === 'ended') return;
      onState(currentMode === 'REPLAY' ? 'REPLAY_STOPPED' : 'DISCONNECTED');
    });
    client.on('error', (error) => onState(`ERROR: ${error.message}`));
    client.on('packet', onPacket);
    client.on('state', (state) => onState(state));
  }

  function createClient(mode) {
    const normalized = String(mode || 'LIVE').toUpperCase();
    if (normalized === 'REPLAY') {
      const client = new ReplayFeedClient({
        repository: replayRepository,
        lookbackDays: replayRepository.lookbackDays,
        speedMultiplier: replayRepository.speedMultiplier || 120,
        replayRange: currentReplayRange
      });
      bindClient(client);
      return client;
    }
    const client = new DhanWsClient(exchangeConfig.dhan);
    bindClient(client);
    return client;
  }

  function ensureClient() {
    if (!currentClient) currentClient = createClient(currentMode);
    return currentClient;
  }

  // Bug 3: update currentMode BEFORE closing the old client so the 'close'
  // event fires with the new mode context and emits the correct state string
  function setMode(mode) {
    const normalized = String(mode || 'LIVE').toUpperCase();
    if (normalized === currentMode && currentClient) return;
    const prevClient = currentClient;
    currentMode = normalized;
    currentClient = null;
    if (prevClient) prevClient.close();
    currentClient = createClient(currentMode);
    if (currentInstruments.length) {
      currentClient.subscribe(currentInstruments);
    }
  }

  function setReplayRange(range = null) {
    currentReplayRange = range;
    if (currentClient && currentMode === 'REPLAY' && typeof currentClient.setReplayRange === 'function') {
      currentClient.setReplayRange(currentReplayRange);
    }
  }

  function start(instruments = []) {
    currentInstruments = instruments.slice();
    const client = ensureClient();
    client.subscribe(currentInstruments);
    client.connect();
  }

  // Bug 5: pause preserves the client and its playback position
  function pause() {
    if (currentClient && typeof currentClient.pausePlayback === 'function') {
      currentClient.pausePlayback();
    } else if (currentClient) {
      currentClient.close();
      currentClient = null;
    }
  }

  // Bug 5: resume from the preserved position without rebuilding the client
  function resume() {
    if (currentClient && typeof currentClient.resumePlayback === 'function') {
      currentClient.resumePlayback();
    } else {
      start(currentInstruments);
    }
  }

  function stop() {
    if (currentClient) currentClient.close();
    currentClient = null;
  }

  function isConnected() {
    return Boolean(currentClient && currentClient.connected);
  }

  function getModeValue() {
    return currentMode;
  }

  // Simulated "current time" during REPLAY (timestamp of the most recently
  // emitted tick). Returns null in LIVE mode or before playback has started —
  // callers should treat null as "use real wall-clock time" / "no data yet".
  function getReplayNow() {
    if (currentMode !== 'REPLAY' || !currentClient || typeof currentClient.getCurrentTimestamp !== 'function') return null;
    return currentClient.getCurrentTimestamp();
  }

  return {
    start,
    stop,
    pause,
    resume,
    isConnected,
    subscribe: (instruments) => {
      currentInstruments = instruments.slice();
      ensureClient().subscribe(currentInstruments);
    },
    setMode,
    setReplayRange,
    getMode: getModeValue,
    getReplayNow
  };
}

module.exports = { createFeedService };
