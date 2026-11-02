import { describe, expect, it } from 'vitest';
import type { MarketProfile } from '../src/config/schemas.js';
import { makeInstrumentId } from '../src/domain/ids.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import { QuotingEngine, type MmQuoteInput } from '../src/mm/quoting-engine.js';

const MARKET: MarketProfile = {
  profileId: 'allop-nse-options',
  version: 1,
  asOf: '2026-07-16',
  exchange: 'NSE',
  segment: 'FNO_OPTIDX',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  session: { open: '09:15', close: '15:30' },
  entryCutoff: '15:05',
  hardSquareOff: '15:15',
  tickSizePaise: 5,
  contract: {
    underlying: 'NIFTY',
    lotSize: 65,
    freezeQty: 1950,
    weeklyExpiryDay: 'TUE',
    strikeStepPaise: 5000,
  },
  charges: {
    gstRate: 0.18,
    components: [
      { name: 'stt', basis: 'sell_premium', rate: 0.001, gstApplicable: false, verifyAtGoLive: true },
      { name: 'exchange_txn', basis: 'both_premium', rate: 0.0003503, gstApplicable: true, verifyAtGoLive: true },
      { name: 'sebi_fee', basis: 'both_premium', rate: 0.000001, gstApplicable: true, verifyAtGoLive: true },
      { name: 'stamp_duty', basis: 'buy_premium', rate: 0.00003, gstApplicable: false, verifyAtGoLive: true },
      { name: 'ipft', basis: 'both_premium', rate: 0.000005, gstApplicable: true, verifyAtGoLive: true },
    ],
  },
};

const BASE_CE_ID = makeInstrumentId('NSE', '23000CE');
const WING_CE_ID = makeInstrumentId('NSE', '23050CE');
const BASE_PE_ID = makeInstrumentId('NSE', '23000PE');
const WING_PE_ID = makeInstrumentId('NSE', '22950PE');

function makeRow(id: typeof BASE_CE_ID, strikePaise: number, right: 'CE' | 'PE', bid: number, ask: number): OptionChainRow {
  return {
    instrumentId: id,
    tradingSymbol: `NIFTY26OCT${strikePaise / 100}${right}`,
    strikePaise,
    right,
    expiry: '2026-10-27',
    bidPaise: bid,
    askPaise: ask,
    bidQty: 500,
    askQty: 500,
    ltpPaise: Math.round((bid + ask) / 2),
    volume: 50000,
    oi: 100000,
    ts: Date.now(),
  };
}

describe('Wing Architecture Quoting & Roll Engine', () => {
  it('acquires Wing Hold lots on both CE and PE when unhedged', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingHoldLots: 1,
      wingScalpLots: 1,
      maxLotsInventory: 6,
      maxScalpLots: 4,
      maxLotsPerSide: 3,
      quoteFrom: '09:20',
      bidCutoff: '15:05',
    });

    const nowMs = 1784178600000; // 09:30:00 IST
    const input: MmQuoteInput = {
      nowMs,
      nowHHMM: '09:30',
      spotPaise: 2300000, // Spot at 23,000.00
      atmCe: makeRow(BASE_CE_ID, 2300000, 'CE', 10000, 10020),
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 7000, 7020),
      atmPe: makeRow(BASE_PE_ID, 2300000, 'PE', 9000, 9020),
      wingPe: makeRow(WING_PE_ID, 2295000, 'PE', 6000, 6020),
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceWingStrikePaise: 2305000,
        ceTargetSpotPaise: 2305000,
        peBaseStrikePaise: 2300000,
        peWingStrikePaise: 2295000,
        peTargetSpotPaise: 2295000,
      },
      books: [],
      latchedStop: false,
    };

    const out = engine.evaluate(input);
    const holdBuys = out.desired.filter((o) => o.reason === 'WING_HOLD_BUY');
    expect(holdBuys).toHaveLength(2);
    expect(holdBuys.some((o) => o.instrumentId === WING_CE_ID)).toBe(true);
    expect(holdBuys.some((o) => o.instrumentId === WING_PE_ID)).toBe(true);

    // Also quotes scalp bids on both base and wings
    const scalpBids = out.desired.filter((o) => o.reason === 'QUOTE_BID');
    expect(scalpBids.length).toBeGreaterThanOrEqual(2);
  });

  it('holds Wing Hold lots without dumping on scalp take-profit or scalp timeout', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingHoldLots: 1,
      wingScalpLots: 1,
      maxHoldSec: 300,
      takeProfitCostMultiple: 3,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs: nowMs + 400_000, // 400s elapsed (> maxHoldSec 300s)
      nowHHMM: '09:36',
      spotPaise: 2302000, // Spot moved from 23,000 to 23,020 (not yet 23,050 target)
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 8500, 8520),
      wingHoldCeLotId: 'wing-hold-ce-1',
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceWingStrikePaise: 2305000,
        ceTargetSpotPaise: 2305000,
      },
      books: [
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 7000,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 8500, 8520),
          lots: [
            { lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs },
          ],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);
    // Should NOT have SCALP_TIMEOUT or QUOTE_ASK for wing-hold-ce-1
    const holdExits = out.desired.filter((o) => o.closeLotIds?.includes('wing-hold-ce-1'));
    expect(holdExits).toHaveLength(0);
  });

  it('triggers WING_ROLL_EXIT when Spot crosses target spot', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingHoldLots: 1,
      wingScalpLots: 1,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs: nowMs + 100_000,
      nowHHMM: '09:32',
      spotPaise: 2305500, // Spot reached 23,055 (>= 23,050 target!)
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 11000, 11020),
      wingHoldCeLotId: 'wing-hold-ce-1',
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceWingStrikePaise: 2305000,
        ceTargetSpotPaise: 2305000,
      },
      books: [
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 7000,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 11000, 11020),
          lots: [
            { lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs },
          ],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);
    const rollExits = out.desired.filter((o) => o.reason === 'WING_ROLL_EXIT');
    expect(rollExits).toHaveLength(1);
    expect(rollExits[0]?.instrumentId).toBe(WING_CE_ID);
    expect(rollExits[0]?.closeLotIds).toEqual(['wing-hold-ce-1']);
  });
});
