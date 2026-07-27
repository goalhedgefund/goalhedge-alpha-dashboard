import { describe, expect, it } from 'vitest';
import { makeInstrumentId, type InstrumentId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import { FeedMarketData } from '../src/host/feed-market-data.js';

const SPOT_ID: InstrumentId = makeInstrumentId('NSE', 'SPOT');
const CE_ID: InstrumentId = makeInstrumentId('NSE', 'CE1');
const PE_ID: InstrumentId = makeInstrumentId('NSE', 'PE1');
const ATM = 2_450_000;

function tick(
  instrumentId: InstrumentId,
  ts: number,
  ltpPaise: number,
  overrides: Partial<Tick> = {},
): Tick {
  return {
    instrumentId,
    ts,
    recvTs: ts,
    ltpPaise,
    qty: 100,
    volume: 1_000,
    bidPaise: ltpPaise - 5,
    askPaise: ltpPaise + 5,
    bidQty: 150,
    askQty: 50,
    ...overrides,
  };
}

describe('FeedMarketData', () => {
  it('attaches live option features to ATM option views', () => {
    const md = new FeedMarketData({
      spotInstrumentId: SPOT_ID,
      options: [
        { instrumentId: CE_ID, strikePaise: ATM, right: 'CE', expiry: '2026-07-07' },
        { instrumentId: PE_ID, strikePaise: ATM, right: 'PE', expiry: '2026-07-07' },
      ],
      strikeStepPaise: 5_000,
      optionRingSize: 4,
    });

    md.ingest(tick(SPOT_ID, 1_000, ATM));
    md.ingest(tick(CE_ID, 1_000, 10_000, { bidPaise: 9_990, askPaise: 10_010, bidQty: 300, askQty: 100 }));
    md.ingest(tick(CE_ID, 2_000, 10_200, { bidPaise: 10_190, askPaise: 10_210, bidQty: 400, askQty: 100 }));

    const ce = md.strategyView(2_000).atmOption('CE');

    expect(ce?.features?.premiumVelocityPaisePerSec).toBe(200);
    expect(ce?.features?.bidAskImbalance).toBeCloseTo(0.6, 6);
    expect(ce?.features?.spreadPct).toBeGreaterThan(0);
  });

  it('gates prior-day carryover ticks below the session floor (no VWAP pollution)', () => {
    const FLOOR = 10_000; // session-date start
    const md = new FeedMarketData({
      spotInstrumentId: SPOT_ID,
      options: [{ instrumentId: CE_ID, strikePaise: ATM, right: 'CE', expiry: '2026-07-07' }],
      strikeStepPaise: 5_000,
      sessionFloorMs: FLOOR,
    });

    // Stale reconnect snapshot from before the floor: rejected, no state change.
    expect(md.ingest(tick(SPOT_ID, FLOOR - 5_000, ATM + 50_000, { qty: 500 }))).toBe('stale');
    expect(md.spotPaise()).toBeUndefined();
    // VWAP must stay undefined — the stale turnover/qty were not accumulated.
    expect(md.strategyView(FLOOR).underlyingFeatures?.vwapPaise).toBeUndefined();

    // Fresh in-session tick is ingested normally and seeds a clean VWAP.
    expect(md.ingest(tick(SPOT_ID, FLOOR + 1_000, ATM, { qty: 100 }))).toBe('spot');
    expect(md.spotPaise()).toBe(ATM);
    expect(md.strategyView(FLOOR + 1_000).underlyingFeatures?.vwapPaise).toBe(ATM);
  });
});
