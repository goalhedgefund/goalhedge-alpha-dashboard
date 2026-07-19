import { describe, expect, it } from 'vitest';
import { makeInstrumentId } from '../src/domain/ids.js';
import type { Instrument } from '../src/domain/instrument.js';
import type { Tick } from '../src/domain/marketdata.js';
import { AtmTracker } from '../src/marketdata/atm-tracker.js';
import { OptionChainState } from '../src/marketdata/chain-state.js';
import { black76Price } from '../src/marketdata/black76.js';

function opt(token: string, strike: number, right: 'CE' | 'PE'): Instrument {
  return {
    id: makeInstrumentId('NSE', token),
    kind: 'OPTION',
    symbol: `NIFTY-${strike / 100}-${right}`,
    underlying: 'NIFTY',
    exchange: 'NSE',
    segment: 'NSE_FNO',
    lotSize: 65,
    tickSizePaise: 5,
    expiry: '2026-07-07',
    strikePaise: strike,
    right,
    brokerToken: token,
  };
}

function tick(instrumentId: ReturnType<typeof makeInstrumentId>, ltpPaise: number, ts = 1): Tick {
  return {
    instrumentId,
    ts,
    recvTs: ts,
    ltpPaise,
    qty: 65,
    volume: 650,
    oi: 1000,
    bidPaise: ltpPaise - 5,
    askPaise: ltpPaise + 5,
    bidQty: 130,
    askQty: 195,
  };
}

describe('ATM tracker', () => {
  it('uses hysteresis to avoid strike flapping', () => {
    const tracker = new AtmTracker({ strikeStepPaise: 5000, hysteresisRatio: 0.6 });
    expect(tracker.update(29_300_00).atmStrikePaise).toBe(29_300_00);
    const smallMove = tracker.update(29_327_00);
    expect(smallMove.changed).toBe(false);
    expect(smallMove.atmStrikePaise).toBe(29_300_00);
    const roll = tracker.update(29_331_00);
    expect(roll.changed).toBe(true);
    expect(roll.atmStrikePaise).toBe(29_350_00);
  });
});

describe('OptionChainState', () => {
  const instruments = [
    opt('1', 29_250_00, 'CE'),
    opt('2', 29_250_00, 'PE'),
    opt('3', 29_300_00, 'CE'),
    opt('4', 29_300_00, 'PE'),
    opt('5', 29_350_00, 'CE'),
    opt('6', 29_350_00, 'PE'),
  ];

  it('updates chain rows from ticks and returns ATM window rows', () => {
    const chain = new OptionChainState({ instruments, strikeStepPaise: 5000, depth: 1 });
    chain.updateSpot(29_300_00);
    const row = chain.updateTick(tick(instruments[2]!.id, 12500, 10));
    expect(row?.ltpPaise).toBe(12500);
    expect(row?.bidQty).toBe(130);
    expect(chain.visibleRows()).toHaveLength(6);
  });

  it('attaches IV and greeks to updated rows', () => {
    const chain = new OptionChainState({ instruments, strikeStepPaise: 5000, depth: 1 });
    const call = instruments[2]!;
    const price = black76Price({
      right: 'CE',
      forward: 29300,
      strike: 29300,
      timeToExpiryYears: 7 / 365,
      volatility: 0.22,
    });
    chain.updateTick(tick(call.id, Math.round(price * 100), 10));
    chain.applyAnalytics({ forwardPaise: 29_300_00, timeToExpiryYears: 7 / 365 });
    const row = chain.row(call.id);
    expect(row?.iv).toBeCloseTo(0.22, 3);
    expect(row?.delta).toBeGreaterThan(0);
    expect(row?.gamma).toBeGreaterThan(0);
    expect(row?.vega).toBeGreaterThan(0);
  });

  it('retains a quoted held strike after it leaves the visible ATM window', () => {
    const chain = new OptionChainState({ instruments, strikeStepPaise: 5000, depth: 0 });
    const held = instruments[0]!;
    chain.updateSpot(29_250_00);
    chain.updateTick(tick(held.id, 12_500, 10));
    expect(chain.visibleRows().map((row) => row.instrumentId)).toContain(held.id);

    chain.updateSpot(29_350_00);
    expect(chain.visibleRows().map((row) => row.instrumentId)).not.toContain(held.id);
    expect(chain.allRows().find((row) => row.instrumentId === held.id)).toEqual(
      expect.objectContaining({ ltpPaise: 12_500, bidPaise: 12_495, askPaise: 12_505 }),
    );
  });
});
