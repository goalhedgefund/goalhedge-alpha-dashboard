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
  it('acquires 2 lots on Wing strikes in 1st instance and quotes Base short sell at Ask', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingHoldLots: 1,
      wingScalpLots: 1,
      maxLotsInventory: 8,
      maxLotsPerSide: 4,
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

    // Wing strikes: acquire 2 lots in 1st instance (1 hold lot + 1 scalp lot)
    const holdBuys = out.desired.filter((o) => o.reason === 'WING_HOLD_BUY');
    expect(holdBuys).toHaveLength(2);
    expect(holdBuys.find((o) => o.instrumentId === WING_CE_ID)?.qty).toBe(130); // 2 * 65
    expect(holdBuys.find((o) => o.instrumentId === WING_PE_ID)?.qty).toBe(130); // 2 * 65

    // Base strikes: Sell first, Buy later! Short sell 1 lot passive at Ask
    const baseShortAsks = out.desired.filter((o) => o.reason === 'QUOTE_ASK' && o.purpose === 'ENTRY');
    expect(baseShortAsks).toHaveLength(2);
    const ceAsk = baseShortAsks.find((o) => o.instrumentId === BASE_CE_ID);
    expect(ceAsk?.side).toBe('SELL');
    expect(ceAsk?.qty).toBe(65);
    expect(ceAsk?.limitPricePaise).toBe(10020); // Touch Ask
    expect(ceAsk?.stopPlan?.hardStopPremiumPaise).toBeGreaterThan(10020); // Hard stop is above entry for short

    const peAsk = baseShortAsks.find((o) => o.instrumentId === BASE_PE_ID);
    expect(peAsk?.side).toBe('SELL');
    expect(peAsk?.qty).toBe(65);
    expect(peAsk?.limitPricePaise).toBe(9020); // Touch Ask
    expect(peAsk?.stopPlan?.hardStopPremiumPaise).toBeGreaterThan(9020);
  });

  it('covers short Base position at +1.0% profit target (Buy to cover)', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingSpreadPct: 1.0,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs,
      nowHHMM: '09:31',
      spotPaise: 2300000,
      atmCe: makeRow(BASE_CE_ID, 2300000, 'CE', 9900, 9920),
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceWingStrikePaise: 2305000,
        ceTargetSpotPaise: 2305000,
      },
      books: [
        {
          instrumentId: BASE_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 10000,
          openedTs: nowMs,
          row: makeRow(BASE_CE_ID, 2300000, 'CE', 9900, 9920),
          lots: [
            { lotId: 'base-short-ce-1', qty: 65, entryPricePaise: 10000, openedTs: nowMs, entrySide: 'SELL' },
          ],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);
    const coverExits = out.desired.filter((o) => o.purpose === 'EXIT' && o.closeLotIds?.includes('base-short-ce-1'));
    expect(coverExits).toHaveLength(1);
    expect(coverExits[0]?.side).toBe('BUY'); // Buy to cover
    // Entry = 10,000 paise (100 rs). 1.0% profit means buy to cover at 9,900 paise (99 rs)
    expect(coverExits[0]?.limitPricePaise).toBe(9900);
  });

  it('scalps Wing strike with 1 lot (Buy First, Sell Later at +1.0%) while Hold lot stays intact', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingHoldLots: 1,
      wingScalpLots: 1,
      wingSpreadPct: 1.0,
      maxLotsInventory: 8,
      maxLotsPerSide: 4,
    });

    const nowMs = 1784178600000;
    // Scenario A: Hold lot is open, scalp lot has exited -> Engine quotes 1-lot BUY to scalp
    const inputRequote: MmQuoteInput = {
      nowMs,
      nowHHMM: '09:35',
      spotPaise: 2301000,
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 7000, 7020),
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
          row: makeRow(WING_CE_ID, 2305000, 'CE', 7000, 7020),
          lots: [
            { lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
          ],
        },
      ],
      latchedStop: false,
    };

    const outA = engine.evaluate(inputRequote);
    const scalpBuy = outA.desired.find((o) => o.instrumentId === WING_CE_ID && o.reason === 'QUOTE_BID');
    expect(scalpBuy).toBeDefined();
    expect(scalpBuy?.qty).toBe(65); // 1 lot scalp bid
    expect(scalpBuy?.side).toBe('BUY');

    // Scenario B: Both Hold lot and Scalp lot are in the book -> Hold lot is NEVER sold, Scalp lot is quoted at +1.0%
    const inputWithBothLots: MmQuoteInput = {
      ...inputRequote,
      books: [
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 130,
          avgEntryPricePaise: 7000,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 7000, 7020),
          lots: [
            { lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
            { lotId: 'wing-scalp-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
          ],
        },
      ],
    };

    const outB = engine.evaluate(inputWithBothLots);
    // Hold lot must have NO exit
    expect(outB.desired.some((o) => o.closeLotIds?.includes('wing-hold-ce-1'))).toBe(false);
    // Scalp lot must be quoted for sale at +1.0% (7000 * 1.01 = 7070)
    const scalpExit = outB.desired.find((o) => o.closeLotIds?.includes('wing-scalp-ce-1'));
    expect(scalpExit).toBeDefined();
    expect(scalpExit?.side).toBe('SELL');
    expect(scalpExit?.limitPricePaise).toBe(7070);
  });

  it('removes Time Guard: holds lots beyond maxHoldSec without dumping into collapsed bids', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      maxHoldSec: 180, // 3 minutes standard timeout
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs: nowMs + 600_000, // 600s (10 minutes!) elapsed
      nowHHMM: '09:40',
      spotPaise: 2302000, // Spot at 23,020 (within 50-pt band)
      atmCe: makeRow(BASE_CE_ID, 2300000, 'CE', 9500, 9520),
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 7500, 7520),
      wingHoldCeLotId: 'wing-hold-ce-1',
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceWingStrikePaise: 2305000,
        ceTargetSpotPaise: 2305000,
      },
      books: [
        {
          instrumentId: BASE_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 10000,
          openedTs: nowMs,
          row: makeRow(BASE_CE_ID, 2300000, 'CE', 9500, 9520),
          lots: [
            { lotId: 'base-short-ce-1', qty: 65, entryPricePaise: 10000, openedTs: nowMs, entrySide: 'SELL' },
          ],
        },
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 130,
          avgEntryPricePaise: 7000,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 7500, 7520),
          lots: [
            { lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
            { lotId: 'wing-scalp-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
          ],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);
    const timeoutExits = out.desired.filter((o) => o.reason === 'SCALP_TIMEOUT');
    expect(timeoutExits).toHaveLength(0); // Zero timeout dumping!
  });

  it('triggers full square-off across ALL open positions (Base and Wings) when Spot shifts +-50 points', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingHoldLots: 1,
      wingScalpLots: 1,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs: nowMs + 100_000,
      nowHHMM: '09:32',
      spotPaise: 2305200, // Spot reached 23,052 (>= 23,050 target!)
      atmCe: makeRow(BASE_CE_ID, 2300000, 'CE', 13000, 13020),
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 9500, 9520),
      atmPe: makeRow(BASE_PE_ID, 2300000, 'PE', 6000, 6020),
      wingPe: makeRow(WING_PE_ID, 2295000, 'PE', 4000, 4020),
      wingHoldCeLotId: 'wing-hold-ce-1',
      wingHoldPeLotId: 'wing-hold-pe-1',
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceWingStrikePaise: 2305000,
        ceTargetSpotPaise: 2305000,
        peBaseStrikePaise: 2300000,
        peWingStrikePaise: 2295000,
        peTargetSpotPaise: 2295000,
      },
      books: [
        {
          instrumentId: BASE_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 10000,
          openedTs: nowMs,
          row: makeRow(BASE_CE_ID, 2300000, 'CE', 13000, 13020),
          lots: [
            { lotId: 'base-short-ce-1', qty: 65, entryPricePaise: 10000, openedTs: nowMs, entrySide: 'SELL' },
          ],
        },
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 130,
          avgEntryPricePaise: 7000,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 9500, 9520),
          lots: [
            { lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
            { lotId: 'wing-scalp-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
          ],
        },
        {
          instrumentId: BASE_PE_ID,
          right: 'PE',
          qty: 65,
          avgEntryPricePaise: 9000,
          openedTs: nowMs,
          row: makeRow(BASE_PE_ID, 2300000, 'PE', 6000, 6020),
          lots: [
            { lotId: 'base-short-pe-1', qty: 65, entryPricePaise: 9000, openedTs: nowMs, entrySide: 'SELL' },
          ],
        },
        {
          instrumentId: WING_PE_ID,
          right: 'PE',
          qty: 65,
          avgEntryPricePaise: 6000,
          openedTs: nowMs,
          row: makeRow(WING_PE_ID, 2295000, 'PE', 4000, 4020),
          lots: [
            { lotId: 'wing-hold-pe-1', qty: 65, entryPricePaise: 6000, openedTs: nowMs, entrySide: 'BUY' },
          ],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);
    const rollExits = out.desired.filter((o) => o.reason === 'WING_ROLL_EXIT');

    // EVERY open lot across the desk must be squared off!
    expect(rollExits).toHaveLength(5);

    // Short positions get urgent BUY exits to cover
    const baseCeExit = rollExits.find((o) => o.closeLotIds?.includes('base-short-ce-1'));
    expect(baseCeExit?.side).toBe('BUY');
    const basePeExit = rollExits.find((o) => o.closeLotIds?.includes('base-short-pe-1'));
    expect(basePeExit?.side).toBe('BUY');

    // Long positions get urgent SELL exits
    const wingCeHoldExit = rollExits.find((o) => o.closeLotIds?.includes('wing-hold-ce-1'));
    expect(wingCeHoldExit?.side).toBe('SELL');
    const wingCeScalpExit = rollExits.find((o) => o.closeLotIds?.includes('wing-scalp-ce-1'));
    expect(wingCeScalpExit?.side).toBe('SELL');
    const wingPeHoldExit = rollExits.find((o) => o.closeLotIds?.includes('wing-hold-pe-1'));
    expect(wingPeHoldExit?.side).toBe('SELL');

    // No new entries during roll exit pass
    expect(out.desired.filter((o) => o.purpose === 'ENTRY')).toHaveLength(0);
  });
});
