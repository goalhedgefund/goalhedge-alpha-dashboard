import { describe, expect, it } from 'vitest';
import { makeInstrumentId, type InstrumentId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import { assertReplayCoverage } from '../src/scripts/replay-s1.js';
import type { DiscoveredRecording } from '../src/scripts/backtest-recording.js';

const SPOT = makeInstrumentId('NSE', 'NIFTY_SPOT');
const CE = makeInstrumentId('NSE', 'CE');
const UNKNOWN = makeInstrumentId('NSE', 'UNKNOWN');

function tick(instrumentId: InstrumentId): Tick {
  return {
    instrumentId,
    ts: 1,
    recvTs: 1,
    ltpPaise: 1,
    qty: 1,
    volume: 1,
    bidPaise: 1,
    askPaise: 1,
    bidQty: 1,
    askQty: 1,
  };
}

const recording: DiscoveredRecording = {
  spotInstrumentId: SPOT,
  optionSpecs: [{ instrumentId: CE, strikePaise: 2_400_000, right: 'CE', expiry: '2026-07-28' }],
  feedTicks: [],
  syntheticSpot: false,
};

describe('S1 replay corpus coverage', () => {
  it('accepts a corpus whose known ticks meet the coverage threshold', () => {
    expect(() => assertReplayCoverage(
      [...Array.from({ length: 10 }, () => tick(SPOT)), ...Array.from({ length: 10 }, () => tick(CE)), tick(UNKNOWN)],
      recording,
      '2026-07-23',
    )).not.toThrow();
  });

  it('fails loudly when a stale scrip master leaves most of the corpus unknown', () => {
    expect(() => assertReplayCoverage([tick(SPOT), ...Array.from({ length: 20 }, () => tick(UNKNOWN))], recording, '2026-07-23'))
      .toThrow('95% ticks unknown');
  });
});
