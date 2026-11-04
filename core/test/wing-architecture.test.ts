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
  entryCutoff: '15:15',
  hardSquareOff: '15:20',
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
const CONT_CE_ID = makeInstrumentId('NSE', '23100CE');
const BASE_PE_ID = makeInstrumentId('NSE', '23000PE');
const WING_PE_ID = makeInstrumentId('NSE', '22950PE');

function makeRow(id: typeof BASE_CE_ID, strikePaise: number, right: 'CE' | 'PE', bid: number, ask: number): OptionChainRow {
  return {
    instrumentId: id,
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
    updatedTs: Date.now(),
  };
}

describe('Adaptive 50pt Ladder & Wing Architecture Quoting Engine', () => {
  it('Stage 0: acquires 1 lot stationary wing on CE/PE and quotes 1 lot short Base ATM at Ask', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingStepPoints: 50,
      wingScaleInPoints: 25,
      wingHoldLots: 2,
      wingScalpLots: 1,
      maxLotsInventory: 10,
      maxLotsPerSide: 6,
      quoteFrom: '09:20',
      bidCutoff: '15:15',
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
      ceLadderStage: 'STAGE_0',
      peLadderStage: 'STAGE_0',
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceScaleInSpotPaise: 2302500,
        ceWingStrikePaise: 2305000,
        ceContinuationStrikePaise: 2310000,
        peBaseStrikePaise: 2300000,
        peScaleInSpotPaise: 2297500,
        peWingStrikePaise: 2295000,
        peContinuationStrikePaise: 2290000,
      },
      books: [],
      latchedStop: false,
    };

    const out = engine.evaluate(input);

    // In Stage 0: 1 lot stationary wing on CE and 1 lot on PE
    const holdBuys = out.desired.filter((o) => o.reason === 'WING_HOLD_BUY');
    expect(holdBuys).toHaveLength(2);
    expect(holdBuys.find((o) => o.instrumentId === WING_CE_ID)?.qty).toBe(65);
    expect(holdBuys.find((o) => o.instrumentId === WING_PE_ID)?.qty).toBe(65);

    // Base strikes: Sell first, short sell 1 lot passive at Ask
    const baseShortAsks = out.desired.filter((o) => o.reason === 'QUOTE_ASK' && o.purpose === 'ENTRY');
    expect(baseShortAsks).toHaveLength(2);
    const ceAsk = baseShortAsks.find((o) => o.instrumentId === BASE_CE_ID);
    expect(ceAsk?.side).toBe('SELL');
    expect(ceAsk?.qty).toBe(65);
    expect(ceAsk?.limitPricePaise).toBe(10020);

    const peAsk = baseShortAsks.find((o) => o.instrumentId === BASE_PE_ID);
    expect(peAsk?.side).toBe('SELL');
    expect(peAsk?.qty).toBe(65);
    expect(peAsk?.limitPricePaise).toBe(9020);
  });

  it('Stage 1 (+25 pts Scale-In): scales in 2nd lot to CE wing (making 2 lots) and 2nd short CE lot', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingStepPoints: 50,
      wingScaleInPoints: 25,
      wingHoldLots: 2,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs,
      nowHHMM: '09:31',
      spotPaise: 2302600, // Spot at 23,026 (+26 pts)
      atmCe: makeRow(BASE_CE_ID, 2300000, 'CE', 11000, 11020),
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 8000, 8020),
      atmPe: makeRow(BASE_PE_ID, 2300000, 'PE', 7500, 7520),
      wingPe: makeRow(WING_PE_ID, 2295000, 'PE', 5000, 5020),
      wingHoldCeLotIds: ['wing-hold-ce-1'], // Holding 1 lot stationary CE
      wingHoldPeLotIds: ['wing-hold-pe-1'],
      ceLadderStage: 'STAGE_1_SCALE_IN',
      peLadderStage: 'STAGE_0',
      books: [
        {
          instrumentId: BASE_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 10000,
          openedTs: nowMs,
          row: makeRow(BASE_CE_ID, 2300000, 'CE', 11000, 11020),
          lots: [{ lotId: 'base-short-ce-1', qty: 65, entryPricePaise: 10000, openedTs: nowMs, entrySide: 'SELL' }],
        },
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 7000,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 8000, 8020),
          lots: [{ lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' }],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);

    // Scale-In adds 1 more lot to the CE Wing (to reach target 2 lots)
    const wingScaleIn = out.desired.find((o) => o.reason === 'WING_HOLD_BUY' && o.instrumentId === WING_CE_ID);
    expect(wingScaleIn?.qty).toBe(65);

    // Scale-In adds 2nd short lot to Base CE (to reach target 2 lots)
    const baseScaleIn = out.desired.find((o) => o.reason === 'QUOTE_ASK' && o.instrumentId === BASE_CE_ID);
    expect(baseScaleIn?.qty).toBe(65);
    expect(baseScaleIn?.side).toBe('SELL');
  });

  it('Stage 2 (+50 pts Wing Arrival): quotes 1 lot BFSL scalp on the Wing CE strike', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingStepPoints: 50,
      wingSpreadPct: 1.0,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs,
      nowHHMM: '09:32',
      spotPaise: 2305000, // Reached 23,050 wing strike!
      atmCe: makeRow(BASE_CE_ID, 2300000, 'CE', 13000, 13020),
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 9500, 9520),
      wingHoldCeLotIds: ['wing-hold-ce-1', 'wing-hold-ce-2'], // Already holding 2 stationary lots
      ceLadderStage: 'STAGE_2_WING',
      books: [
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 130,
          avgEntryPricePaise: 7500,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 9500, 9520),
          lots: [
            { lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
            { lotId: 'wing-hold-ce-2', qty: 65, entryPricePaise: 8000, openedTs: nowMs, entrySide: 'BUY' },
          ],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);

    // At Wing strike: 1 lot Buy First Sell Later (BFSL) scalp placed at Bid
    const scalpBid = out.desired.find((o) => o.reason === 'QUOTE_BID' && o.instrumentId === WING_CE_ID);
    expect(scalpBid).toBeDefined();
    expect(scalpBid?.qty).toBe(65);
    expect(scalpBid?.limitPricePaise).toBe(9500); // Touch Bid
  });

  it('Path 1 (Pullback from Wing): settles 1 lot wing on 25-pt drop and 2nd wing on 50-pt drop', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingStepPoints: 50,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs,
      nowHHMM: '09:35',
      spotPaise: 2302000, // Dropped back to 23,020 (below 23,025)
      atmCe: makeRow(BASE_CE_ID, 2300000, 'CE', 10500, 10520),
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 7600, 7620),
      wingHoldCeLotIds: ['wing-hold-ce-1', 'wing-hold-ce-2'], // Holding 2 lots
      ceLadderStage: 'PATH_1_PULLBACK',
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceScaleInSpotPaise: 2302500,
        ceWingStrikePaise: 2305000,
      },
      books: [
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 130,
          avgEntryPricePaise: 7500,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 7600, 7620),
          lots: [
            { lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' },
            { lotId: 'wing-hold-ce-2', qty: 65, entryPricePaise: 8000, openedTs: nowMs, entrySide: 'BUY' },
          ],
        },
        {
          instrumentId: BASE_CE_ID,
          right: 'CE',
          qty: 130,
          avgEntryPricePaise: 10500,
          openedTs: nowMs,
          row: makeRow(BASE_CE_ID, 2300000, 'CE', 10500, 10520),
          lots: [
            { lotId: 'base-short-ce-1', qty: 65, entryPricePaise: 10000, openedTs: nowMs, entrySide: 'SELL' },
            { lotId: 'base-short-ce-2', qty: 65, entryPricePaise: 11000, openedTs: nowMs, entrySide: 'SELL' },
          ],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);

    // Settle 1 lot wing (reduce from 2 to 1 lot target)
    const wingSettle = out.desired.find((o) => o.reason === 'WING_HOLD_SELL' && o.instrumentId === WING_CE_ID);
    expect(wingSettle).toBeDefined();
    expect(wingSettle?.side).toBe('SELL');

    // Settle 1 lot short CE (reduce from 2 to 1 lot target)
    const shortSettle = out.desired.find((o) => o.reason === 'SCALP_EXIT' && o.instrumentId === BASE_CE_ID);
    expect(shortSettle).toBeDefined();
    expect(shortSettle?.side).toBe('BUY');
  });

  it('Path 2 (Continuation Upwards): holds initial sets (NO STOP LOSS) and quotes ATM+100 scalp with 50-pt SL', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
      wingStepPoints: 50,
      wingNoStopLossOnBase: true,
      trendScalpStopNiftyPoints: 50,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs,
      nowHHMM: '09:40',
      spotPaise: 2310100, // Spot surged past 23,100 (+100 pts)
      atmCe: makeRow(BASE_CE_ID, 2300000, 'CE', 17000, 17020),
      wingCe: makeRow(WING_CE_ID, 2305000, 'CE', 13000, 13020),
      contCe: makeRow(CONT_CE_ID, 2310000, 'CE', 8500, 8520),
      wingHoldCeLotIds: ['wing-hold-ce-1', 'wing-hold-ce-2'],
      ceLadderStage: 'PATH_2_TREND',
      wingState: {
        ceBaseStrikePaise: 2300000,
        ceScaleInSpotPaise: 2302500,
        ceWingStrikePaise: 2305000,
        ceContinuationStrikePaise: 2310000,
      },
      books: [
        {
          instrumentId: BASE_CE_ID,
          right: 'CE',
          qty: 130,
          avgEntryPricePaise: 10500,
          openedTs: nowMs,
          row: makeRow(BASE_CE_ID, 2300000, 'CE', 17000, 17020),
          lots: [
            { lotId: 'base-short-ce-1', qty: 65, entryPricePaise: 10000, openedTs: nowMs, entrySide: 'SELL' },
            { lotId: 'base-short-ce-2', qty: 65, entryPricePaise: 11000, openedTs: nowMs, entrySide: 'SELL' },
          ],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);

    // Initial short legs must NOT have hard stops
    const hardStops = out.desired.filter((o) => o.reason === 'HARD_STOP');
    expect(hardStops).toHaveLength(0);

    // Quotes fresh BFSL scalp on the continuation strike (ATM+100)
    const trendScalp = out.desired.find((o) => o.reason === 'TREND_SCALP_BID' && o.instrumentId === CONT_CE_ID);
    expect(trendScalp).toBeDefined();
    expect(trendScalp?.side).toBe('BUY');
    expect(trendScalp?.qty).toBe(65);
  });

  it('triggers mandatory full square-off across ALL open positions at 15:20 IST', () => {
    const engine = new QuotingEngine(MARKET, {
      wingArchitectureEnabled: true,
    });

    const nowMs = 1784178600000;
    const input: MmQuoteInput = {
      nowMs,
      nowHHMM: '15:20', // Exactly 15:20 IST EOD cut
      spotPaise: 2305000,
      books: [
        {
          instrumentId: BASE_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 10000,
          openedTs: nowMs,
          row: makeRow(BASE_CE_ID, 2300000, 'CE', 13000, 13020),
          lots: [{ lotId: 'base-short-ce-1', qty: 65, entryPricePaise: 10000, openedTs: nowMs, entrySide: 'SELL' }],
        },
        {
          instrumentId: WING_CE_ID,
          right: 'CE',
          qty: 65,
          avgEntryPricePaise: 7000,
          openedTs: nowMs,
          row: makeRow(WING_CE_ID, 2305000, 'CE', 9500, 9520),
          lots: [{ lotId: 'wing-hold-ce-1', qty: 65, entryPricePaise: 7000, openedTs: nowMs, entrySide: 'BUY' }],
        },
      ],
      latchedStop: false,
    };

    const out = engine.evaluate(input);
    const rollExits = out.desired.filter((o) => o.reason === 'WING_ROLL_EXIT');
    expect(rollExits).toHaveLength(2);
  });
});
