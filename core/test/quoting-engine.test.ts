import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, StrategyConfigSchema, type MarketProfile } from '../src/config/schemas.js';
import { makeInstrumentId, type InstrumentId } from '../src/domain/ids.js';
import type { OptionRight } from '../src/domain/instrument.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import {
  QuotingEngine,
  resolveMmParams,
  type MmBookInput,
  type MmQuoteInput,
} from '../src/mm/quoting-engine.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(
  MarketProfileSchema,
  fileURLToPath(new URL('market/india-nse-options.json', configDir)),
).value;
const strategy = loadConfig(
  StrategyConfigSchema,
  fileURLToPath(new URL('strategy/allop-atm-mm.json', configDir)),
).value;

const LOT = market.contract.lotSize;
const TICK = market.tickSizePaise;
const CE_ID: InstrumentId = makeInstrumentId('NSE', 'ATM_CE');
const PE_ID: InstrumentId = makeInstrumentId('NSE', 'ATM_PE');
const NOW = Date.UTC(2026, 6, 16, 5, 0, 0); // 10:30 IST

const PARAMS = {
  spreadCostMultiple: 3,
  maxLotsInventory: 5,
  maxScalpLots: 4,
  runnerLots: 1,
  lotsPerOrder: 1,
  ladderLevels: 2,
  ladderGapPct: 0.4,
  repriceTicks: 2,
  quoteTtlSec: 20,
  maxHoldSec: 180,
  hardStopPct: 10,
  adverseStopPct: 5,
  defensiveProtectTicks: 10,
  defensiveCooldownSec: 180,
  runnerActivationPct: 2,
  runnerTrailPct: 3,
  runnerMaxHoldSec: 900,
  deltaSkewLots: 3,
  knifePct: 0.35,
  knifeCooldownMin: 10,
  quoteFrom: '09:20',
  bidCutoff: '15:10',
};

function row(id: InstrumentId, right: OptionRight, bid: number, ask: number, ltp = ask): OptionChainRow {
  return {
    instrumentId: id,
    strikePaise: 2_450_000,
    right,
    expiry: '2026-07-21',
    ltpPaise: ltp,
    bidPaise: bid,
    askPaise: ask,
    bidQty: LOT,
    askQty: LOT,
    volume: 100_000,
    oi: 500_000,
    updatedTs: NOW,
  };
}

function book(right: OptionRight, lots: number, avgCost: number, openedTs = NOW - 60_000, r?: OptionChainRow): MmBookInput {
  const id = right === 'CE' ? CE_ID : PE_ID;
  return {
    instrumentId: id,
    right,
    qty: lots * LOT,
    avgEntryPricePaise: avgCost,
    openedTs,
    lots: Array.from({ length: lots }, (_, index) => ({
      lotId: `${String(id)}:${index}`,
      qty: LOT,
      entryPricePaise: avgCost,
      openedTs,
    })),
    row: r ?? row(id, right, avgCost - TICK, avgCost + TICK, avgCost),
  };
}

function baseInput(overrides: Partial<MmQuoteInput> = {}): MmQuoteInput {
  return {
    nowMs: NOW,
    nowHHMM: '10:30',
    spotPaise: 2_450_000,
    atmCe: row(CE_ID, 'CE', 14_990, 15_010),
    atmPe: row(PE_ID, 'PE', 14_990, 15_010),
    books: [],
    latchedStop: false,
    ...overrides,
  };
}

function engine(paramOverrides: Record<string, number | string | boolean> = {}): QuotingEngine {
  return new QuotingEngine(market, { ...PARAMS, ...paramOverrides });
}

describe('spread rule (R4: quoted spread = 3x statutory cost)', () => {
  it('minSpreadPct is exactly spreadCostMultiple x round-trip charges', () => {
    const e = engine();
    const rt = e.roundTripCostPct(15_000);
    expect(rt).toBeGreaterThan(0.1); // statutory options round trip is ~0.19%
    expect(rt).toBeLessThan(0.4);
    expect(e.minSpreadPct(15_000)).toBeCloseTo(3 * rt, 10);
  });

  it('a normal scalp exit never sits below its lot cost x (1 + minSpread)', () => {
    const e = engine();
    const b = book('CE', 2, 15_000);
    const out = e.evaluate(baseInput({ books: [b] }));
    const ask = out.desired.find((d) => d.side === 'SELL');
    expect(ask).toBeDefined();
    expect(ask!.type).toBe('LIMIT');
    const floor = 15_000 * (1 + e.minSpreadPct(15_000) / 100);
    expect(ask!.limitPricePaise!).toBeGreaterThanOrEqual(floor);
    expect(ask!.limitPricePaise! % TICK).toBe(0);
  });

  it('ask lifts to mid when the market trades above the cost floor', () => {
    const e = engine();
    const hot = row(CE_ID, 'CE', 19_990, 20_010);
    const b = book('CE', 1, 15_000, NOW - 60_000, hot);
    const out = e.evaluate(baseInput({ books: [b] }));
    const ask = out.desired.find((d) => d.reason === 'QUOTE_ASK');
    expect(ask!.limitPricePaise!).toBeGreaterThanOrEqual(20_000);
  });
});

describe('bids', () => {
  it('quotes an interleaved CE/PE ladder below mid, tick-snapped, with stop plans', () => {
    const out = engine().evaluate(baseInput());
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids).toHaveLength(4); // 2 levels x 2 rights
    for (const bid of bids) {
      expect(bid.type).toBe('LIMIT');
      expect(bid.limitPricePaise!).toBeLessThan(15_000);
      expect(bid.limitPricePaise! % TICK).toBe(0);
      expect(bid.purpose).toBe('ENTRY');
      expect(bid.stopPlan).toBeDefined();
      expect(bid.stopPlan!.hardStopPremiumPaise).toBeLessThan(bid.limitPricePaise!);
      expect(bid.stopPlan!.hardStopPremiumPaise).toBeGreaterThan(0);
      expect(bid.qty).toBe(LOT);
    }
    expect(out.phase).toBe('QUOTING');
  });

  it('never bids into a one-sided book', () => {
    const out = engine().evaluate(baseInput({ atmCe: row(CE_ID, 'CE', 0, 15_010) }));
    expect(out.desired.filter((d) => d.side === 'BUY' && d.instrumentId === CE_ID)).toHaveLength(0);
    expect(out.desired.filter((d) => d.side === 'BUY' && d.instrumentId === PE_ID).length).toBeGreaterThan(0);
  });

  it('re-centres onto new ATM instruments while old-strike inventory keeps its ask', () => {
    const newCe = makeInstrumentId('NSE', 'NEW_ATM_CE');
    const oldBook = book('CE', 1, 15_000);
    const out = engine().evaluate(
      baseInput({ atmCe: row(newCe, 'CE', 12_990, 13_010), books: [oldBook] }),
    );
    const bidIds = out.desired.filter((d) => d.side === 'BUY').map((d) => d.instrumentId);
    expect(bidIds).toContain(newCe);
    expect(bidIds).not.toContain(CE_ID); // we never chase the old strike with bids
    const asks = out.desired.filter((d) => d.side === 'SELL');
    expect(asks.map((a) => a.instrumentId)).toContain(CE_ID); // inventory exits where it is
  });

  it('delta skew: the heavier right stops bidding', () => {
    const books = [book('CE', 3, 15_000)];
    const out = engine().evaluate(baseInput({ books }));
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids.every((b) => b.instrumentId === PE_ID)).toBe(true);
    expect(bids.length).toBeGreaterThan(0);
  });
});

describe('bid pauses (asks always survive)', () => {
  const pausedCases: Array<[string, Partial<MmQuoteInput>, string]> = [
    ['before quoteFrom', { nowHHMM: '09:15' }, 'PAUSED_WINDOW'],
    ['after bidCutoff', { nowHHMM: '15:10' }, 'ASK_ONLY'],
    ['latched session stop', { latchedStop: true }, 'PAUSED_LOCKOUT'],
  ];
  for (const [name, overrides, phase] of pausedCases) {
    it(name, () => {
      const b = book('CE', 1, 15_000);
      const out = engine().evaluate(baseInput({ ...overrides, books: [b] }));
      expect(out.phase).toBe(phase);
      expect(out.desired.filter((d) => d.side === 'BUY')).toHaveLength(0);
      expect(out.desired.filter((d) => d.side === 'SELL')).toHaveLength(1);
    });
  }

  it('falling knife pauses bids for the cooldown, then resumes', () => {
    const e = engine();
    // Feed a 0.5% drop inside 5 minutes.
    e.evaluate(baseInput({ nowMs: NOW, spotPaise: 2_450_000 }));
    const crashed = e.evaluate(baseInput({ nowMs: NOW + 60_000, spotPaise: 2_437_000 }));
    expect(crashed.phase).toBe('PAUSED_KNIFE');
    expect(crashed.desired.filter((d) => d.side === 'BUY')).toHaveLength(0);
    // Still paused inside the cooldown — and the pause EXTENDS while spot is
    // still >= knifePct below the 5-minute-ago point (re-trigger at +5m).
    const still = e.evaluate(baseInput({ nowMs: NOW + 5 * 60_000, spotPaise: 2_437_000 }));
    expect(still.phase).toBe('PAUSED_KNIFE');
    // Once spot has been steady for a full window, the cooldown runs out.
    const later = e.evaluate(baseInput({ nowMs: NOW + 12 * 60_000, spotPaise: 2_437_000 }));
    expect(later.phase).toBe('PAUSED_KNIFE'); // extended cooldown from the +5m re-trigger
    const resumed = e.evaluate(baseInput({ nowMs: NOW + 16 * 60_000, spotPaise: 2_437_000 }));
    expect(resumed.phase).toBe('QUOTING');
  });
});

describe('exits beyond the quote', () => {
  it('hard stop: each breached lot gets its own protected, truthfully tagged exit', () => {
    const r = row(CE_ID, 'CE', 11_900, 12_000);
    const b = book('CE', 2, 15_000, NOW - 60_000, r);
    const out = engine().evaluate(baseInput({ books: [b] }));
    const exits = out.desired.filter((d) => d.reason === 'HARD_STOP');
    expect(exits).toHaveLength(2);
    expect(exits.map((exit) => exit.closeLotIds?.[0]).sort()).toEqual([
      `${String(CE_ID)}:0`,
      `${String(CE_ID)}:1`,
    ]);
    for (const exit of exits) {
      expect(exit.type).toBe('LIMIT');
      expect(exit.limitPricePaise).toBe(11_900 - 10 * TICK);
      expect(exit.qty).toBe(LOT);
      expect(exit.closeLotIds).toHaveLength(1);
    }
  });

  it('hard stop triggers on executable bid even when a wide ask flatters mid', () => {
    const r = row(CE_ID, 'CE', 11_900, 18_000);
    const b = book('CE', 1, 15_000, NOW - 60_000, r);
    const out = engine().evaluate(baseInput({ books: [b] }));
    const exit = out.desired.find((d) => d.reason === 'HARD_STOP');
    expect(exit!.reason).toBe('HARD_STOP');
    expect(exit!.limitPricePaise).toBe(11_900 - 10 * TICK);
  });

  it('per-lot ageing: a scalp older than maxHoldSec exits at best bid', () => {
    const b = book('CE', 1, 15_000, NOW - 601_000);
    const out = engine().evaluate(baseInput({ books: [b] }));
    const exit = out.desired.find((d) => d.reason === 'SCALP_TIMEOUT');
    expect(exit!.reason).toBe('SCALP_TIMEOUT');
    expect(exit!.limitPricePaise).toBe(b.row!.bidPaise - 10 * TICK);
  });

  it('a book with no quote row emits no ask (and never a market-blind sell)', () => {
    const b: MmBookInput = { instrumentId: CE_ID, right: 'CE', qty: LOT, avgEntryPricePaise: 15_000, openedTs: NOW };
    const out = engine().evaluate(baseInput({ books: [b] }));
    expect(out.desired.filter((d) => d.side === 'SELL')).toHaveLength(0);
  });

  it('an aged lot with no quote row uses a market-protected timeout exit', () => {
    const b: MmBookInput = {
      instrumentId: CE_ID,
      right: 'CE',
      qty: LOT,
      avgEntryPricePaise: 15_000,
      openedTs: NOW - 181_000,
      lots: [{ lotId: 'rowless-aged', qty: LOT, entryPricePaise: 15_000, openedTs: NOW - 181_000 }],
    };
    const exit = engine().evaluate(baseInput({ books: [b] })).desired.find((d) => d.reason === 'SCALP_TIMEOUT');
    expect(exit).toEqual(expect.objectContaining({
      type: 'MARKET_PROTECT',
      qty: LOT,
      closeLotIds: ['rowless-aged'],
    }));
    expect(exit?.limitPricePaise).toBeUndefined();
  });

  it('a risk latch liquidates rowless inventory one exact lot at a time', () => {
    const b: MmBookInput = {
      instrumentId: CE_ID,
      right: 'CE',
      qty: 2 * LOT,
      avgEntryPricePaise: 15_000,
      openedTs: NOW,
      lots: [
        { lotId: 'risk-1', qty: LOT, entryPricePaise: 15_000, openedTs: NOW },
        { lotId: 'risk-2', qty: LOT, entryPricePaise: 15_000, openedTs: NOW },
      ],
    };
    const exits = engine().evaluate(baseInput({ books: [b], latchedStop: true })).desired;
    expect(exits).toHaveLength(2);
    expect(exits.map((exit) => exit.closeLotIds?.[0]).sort()).toEqual(['risk-1', 'risk-2']);
    expect(exits.every((exit) => exit.reason === 'RISK_EXIT' && exit.type === 'MARKET_PROTECT')).toBe(true);
  });

  it('hard-stops only the breached lot and preserves the healthier lot', () => {
    const r = row(CE_ID, 'CE', 9_500, 9_525);
    const b: MmBookInput = {
      instrumentId: CE_ID,
      right: 'CE',
      qty: 2 * LOT,
      avgEntryPricePaise: 10_500,
      openedTs: NOW - 60_000,
      lots: [
        { lotId: 'high-cost', qty: LOT, entryPricePaise: 11_000, openedTs: NOW - 60_000 },
        { lotId: 'low-cost', qty: LOT, entryPricePaise: 10_000, openedTs: NOW - 30_000 },
      ],
      row: r,
    };
    const exit = engine().evaluate(baseInput({ books: [b] })).desired.find((d) => d.reason === 'HARD_STOP');
    expect(exit?.reason).toBe('HARD_STOP');
    expect(exit?.qty).toBe(LOT);
    expect(exit?.closeLotIds).toEqual(['high-cost']);
  });

  it('times out only the aged lot; a younger fill keeps its own clock', () => {
    const b: MmBookInput = {
      ...book('CE', 2, 15_000),
      lots: [
        { lotId: 'aged', qty: LOT, entryPricePaise: 15_000, openedTs: NOW - 181_000 },
        { lotId: 'young', qty: LOT, entryPricePaise: 15_000, openedTs: NOW - 30_000 },
      ],
    };
    const exit = engine().evaluate(baseInput({ books: [b] })).desired.find((d) => d.reason === 'SCALP_TIMEOUT');
    expect(exit?.reason).toBe('SCALP_TIMEOUT');
    expect(exit?.qty).toBe(LOT);
    expect(exit?.closeLotIds).toEqual(['aged']);
  });

  it('a 5% adverse scalp freezes only that right and prevents averaging down', () => {
    const r = row(CE_ID, 'CE', 9_490, 9_510);
    const b: MmBookInput = {
      ...book('CE', 1, 10_000, NOW - 30_000, r),
      lots: [{ lotId: 'loser', qty: LOT, entryPricePaise: 10_000, openedTs: NOW - 30_000 }],
    };
    const out = engine().evaluate(baseInput({ books: [b], atmCe: r }));
    expect(out.desired.filter((d) => d.side === 'BUY' && d.instrumentId === CE_ID)).toHaveLength(0);
    expect(out.desired.filter((d) => d.side === 'BUY' && d.instrumentId === PE_ID).length).toBeGreaterThan(0);
    expect(out.defences).toEqual([
      expect.objectContaining({ right: 'CE', reason: 'ADVERSE_BOOK' }),
    ]);
  });

  it('reserves one global runner candidate and scalps a different fill lot', () => {
    const b: MmBookInput = {
      ...book('CE', 2, 15_000),
      lots: [
        { lotId: 'expensive', qty: LOT, entryPricePaise: 15_100, openedTs: NOW - 60_000 },
        { lotId: 'runner-candidate', qty: LOT, entryPricePaise: 14_900, openedTs: NOW - 30_000 },
      ],
    };
    const out = engine().evaluate(baseInput({ books: [b] }));
    const exit = out.desired.find((d) => d.reason === 'SCALP_EXIT');
    expect(out.runnerCandidateLotId).toBe('runner-candidate');
    expect(exit?.reason).toBe('SCALP_EXIT');
    expect(exit?.closeLotIds).toEqual(['expensive']);
  });

  it('runner trailing protection closes only the runner allocation', () => {
    const r = row(CE_ID, 'CE', 15_100, 15_125);
    const b: MmBookInput = {
      ...book('CE', 2, 15_000, NOW - 60_000, r),
      lots: [
        { lotId: 'runner', qty: LOT, entryPricePaise: 15_000, openedTs: NOW - 60_000 },
        { lotId: 'scalp', qty: LOT, entryPricePaise: 15_000, openedTs: NOW - 30_000 },
      ],
    };
    const out = engine().evaluate(baseInput({
      books: [b],
      runner: {
        lotId: 'runner',
        instrumentId: CE_ID,
        qty: LOT,
        entryPricePaise: 15_000,
        openedTs: NOW - 60_000,
        activatedTs: NOW - 30_000,
        highWaterBidPaise: 16_000,
        stopPaise: 15_200,
      },
    }));
    const exit = out.desired.find((d) => d.reason === 'RUNNER_TRAIL');
    expect(exit?.reason).toBe('RUNNER_TRAIL');
    expect(exit?.qty).toBe(LOT);
    expect(exit?.closeLotIds).toEqual(['runner']);
  });

  it('keeps runner, hard-stop, and timeout exits in separate exact-lot orders', () => {
    const r = row(CE_ID, 'CE', 11_900, 11_925);
    const b: MmBookInput = {
      instrumentId: CE_ID,
      right: 'CE',
      qty: 3 * LOT,
      avgEntryPricePaise: 11_667,
      openedTs: NOW - 200_000,
      row: r,
      lots: [
        { lotId: 'runner', qty: LOT, entryPricePaise: 10_000, openedTs: NOW - 60_000 },
        { lotId: 'hard-stop', qty: LOT, entryPricePaise: 15_000, openedTs: NOW - 60_000 },
        { lotId: 'timed-out', qty: LOT, entryPricePaise: 10_000, openedTs: NOW - 181_000 },
      ],
    };
    const exits = engine().evaluate(baseInput({
      books: [b],
      runner: {
        lotId: 'runner',
        instrumentId: CE_ID,
        qty: LOT,
        entryPricePaise: 10_000,
        openedTs: NOW - 60_000,
        activatedTs: NOW - 30_000,
        highWaterBidPaise: 13_000,
        stopPaise: 12_000,
      },
    })).desired.filter((d) => d.side === 'SELL');

    expect(exits).toHaveLength(3);
    expect(exits.map((exit) => [exit.reason, exit.closeLotIds])).toEqual(expect.arrayContaining([
      ['RUNNER_TRAIL', ['runner']],
      ['HARD_STOP', ['hard-stop']],
      ['SCALP_TIMEOUT', ['timed-out']],
    ]));
    expect(exits.find((exit) => exit.reason === 'HARD_STOP')?.closeLotIds).not.toContain('runner');
  });
});

describe('structural invariants (property)', () => {
  const lotsArb = fc.record({
    ceLots: fc.integer({ min: 0, max: 6 }),
    peLots: fc.integer({ min: 0, max: 6 }),
    avgCost: fc.integer({ min: 500, max: 50_000 }).map((v) => Math.round(v / TICK) * TICK),
    mid: fc.integer({ min: 500, max: 50_000 }).map((v) => Math.round(v / TICK) * TICK),
  });

  it('never short, and held + desired bid lots never exceed the cap', () => {
    fc.assert(
      fc.property(lotsArb, ({ ceLots, peLots, avgCost, mid }) => {
        const books: MmBookInput[] = [];
        if (ceLots > 0) books.push(book('CE', ceLots, avgCost));
        if (peLots > 0) books.push(book('PE', peLots, avgCost));
        const out = engine().evaluate(
          baseInput({
            books,
            atmCe: row(CE_ID, 'CE', mid - TICK, mid + TICK),
            atmPe: row(PE_ID, 'PE', mid - TICK, mid + TICK),
          }),
        );
        // Long-only: every sell maps to a held book and never exceeds it.
        for (const d of out.desired.filter((x) => x.side === 'SELL')) {
          const held = books.find((b) => b.instrumentId === d.instrumentId);
          expect(held).toBeDefined();
          expect(d.qty).toBeLessThanOrEqual(held!.qty);
        }
        // Cap: bids never take the book past maxLotsInventory. A carried book
        // already over the cap simply gets zero new bids (never a forced sell).
        const heldLots = ceLots + peLots;
        const bidLots = out.desired.filter((x) => x.side === 'BUY').reduce((s, x) => s + x.qty / LOT, 0);
        expect(bidLots).toBeLessThanOrEqual(Math.max(0, PARAMS.maxLotsInventory - heldLots));
        // Every limit price is tick-snapped and positive; protected market exits omit it.
        for (const d of out.desired) {
          if (d.limitPricePaise !== undefined) {
            expect(d.limitPricePaise % TICK).toBe(0);
            expect(d.limitPricePaise).toBeGreaterThan(0);
          } else {
            expect(d.type).toBe('MARKET_PROTECT');
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('param resolution', () => {
  it('falls back to design defaults on junk', () => {
    const p = resolveMmParams({ quoteFrom: 'nonsense', maxLotsInventory: Number.NaN });
    expect(p.quoteFrom).toBe('09:20');
    expect(p.maxLotsInventory).toBe(5);
    expect(p.spreadCostMultiple).toBe(3);
  });

  it('resolves the v0.3 trend/streak params with defaults', () => {
    const p = resolveMmParams({});
    expect(p.trendPct).toBe(0.2);
    expect(p.trendResumePct).toBe(0.1);
    expect(p.lossStreakEscalation).toBe(2);
    expect(p.escalatedCooldownSec).toBe(900);
  });
});

describe('v0.3 trend regime filter (never bid against the tape)', () => {
  const SPOT = 2_450_000;

  /** Feed a spot path (offsets in ms from NOW) and return the last evaluation. */
  function drift(e: QuotingEngine, path: Array<[number, number]>, overrides: Partial<MmQuoteInput> = {}) {
    let out;
    for (const [offsetMs, spotPaise] of path) {
      out = e.evaluate(baseInput({ nowMs: NOW + offsetMs, spotPaise, ...overrides }));
    }
    return out!;
  }

  it('up-drift >= trendPct suppresses PE bids only; CE keeps quoting', () => {
    const e = engine();
    const out = drift(e, [[0, SPOT], [60_000, Math.round(SPOT * 1.0025)]]); // +0.25% > 0.20%
    expect(out.trendRegime).toBe('UP');
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids.some((d) => d.instrumentId === CE_ID)).toBe(true);
    expect(bids.some((d) => d.instrumentId === PE_ID)).toBe(false);
    expect(out.defences).toContainEqual({ right: 'PE', reason: 'TREND' });
  });

  it('down-drift suppresses CE bids only', () => {
    const e = engine();
    const out = drift(e, [[0, SPOT], [60_000, Math.round(SPOT * 0.9975)]]);
    expect(out.trendRegime).toBe('DOWN');
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids.some((d) => d.instrumentId === PE_ID)).toBe(true);
    expect(bids.some((d) => d.instrumentId === CE_ID)).toBe(false);
  });

  it('directional-only mode waits in neutral, then opens only with the trend', () => {
    const e = engine({ directionalOnly: true });
    let out = drift(e, [[0, SPOT]]);
    expect(out.trendRegime).toBe('NEUTRAL');
    expect(out.desired.some((d) => d.side === 'BUY')).toBe(false);

    out = drift(e, [[60_000, SPOT], [120_000, Math.round(SPOT * 1.0025)]]);
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(out.trendRegime).toBe('UP');
    expect(bids).toHaveLength(2);
    expect(bids.every((bid) => bid.instrumentId === CE_ID)).toBe(true);
  });

  it('hysteresis: regime holds until |drift| falls below trendResumePct', () => {
    const e = engine();
    // Enter UP, then drift decays to +0.15% (above resume 0.10%) — still UP.
    let out = drift(e, [[0, SPOT], [60_000, Math.round(SPOT * 1.0025)], [120_000, Math.round(SPOT * 1.0015)]]);
    expect(out.trendRegime).toBe('UP');
    // Decay to +0.05% — back to NEUTRAL, both rights bid again.
    out = e.evaluate(baseInput({ nowMs: NOW + 180_000, spotPaise: Math.round(SPOT * 1.0005) }));
    expect(out.trendRegime).toBe('NEUTRAL');
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids.some((d) => d.instrumentId === CE_ID)).toBe(true);
    expect(bids.some((d) => d.instrumentId === PE_ID)).toBe(true);
  });

  it('exits are never suppressed by the trend regime', () => {
    const e = engine();
    // UP regime with a PE book breaching the 10% hard stop: exit must still fire.
    const cost = 15_000;
    const stopBid = Math.floor((cost * 0.89) / TICK) * TICK;
    const b = book('PE', 1, cost, NOW - 30_000, row(PE_ID, 'PE', stopBid, stopBid + TICK, stopBid));
    const out = drift(e, [[0, SPOT], [60_000, Math.round(SPOT * 1.0025)]], { books: [b] });
    expect(out.trendRegime).toBe('UP');
    expect(out.desired.some((d) => d.side === 'SELL' && d.reason === 'HARD_STOP')).toBe(true);
  });

  it('a knife-sized move still wins with a full bid pause', () => {
    const e = engine();
    const out = drift(e, [[0, SPOT], [60_000, Math.round(SPOT * 1.004)]]); // +0.40% >= knifePct
    expect(out.phase).toBe('PAUSED_KNIFE');
    expect(out.desired.some((d) => d.side === 'BUY')).toBe(false);
  });

  it('trendPct=0 disables the filter', () => {
    const e = engine({ trendPct: 0 });
    const out = drift(e, [[0, SPOT], [60_000, Math.round(SPOT * 1.0025)]]);
    expect(out.trendRegime).toBe('NEUTRAL');
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids.some((d) => d.instrumentId === PE_ID)).toBe(true);
  });
});

describe('maxLotsPerSide cap (clustering defence)', () => {
  it('suppresses CE bids once CE scalp lots reach maxLotsPerSide; PE still quotes', () => {
    const e = engine({ maxLotsPerSide: 2, maxScalpLots: 4, maxLotsInventory: 5 });
    const b = book('CE', 2, 15_000); // 2 CE scalp lots — at the cap
    const out = e.evaluate(baseInput({ books: [b] }));
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids.some((d) => d.instrumentId === CE_ID)).toBe(false);
    expect(bids.some((d) => d.instrumentId === PE_ID)).toBe(true);
  });

  it('runner inventory counts toward the per-side cap', () => {
    const e = engine({ maxLotsPerSide: 2, maxScalpLots: 4, maxLotsInventory: 5, runnerLots: 1 });
    // Both lots consume CE directional capacity, regardless of runner status.
    const ceBook = book('CE', 2, 15_000);
    const runnerLotId = ceBook.lots![0]!.lotId;
    const out = e.evaluate(baseInput({
      books: [ceBook],
      runner: {
        lotId: runnerLotId,
        qty: LOT,
        entryPricePaise: 15_000,
        openedTs: NOW - 60_000,
        instrumentId: CE_ID,
        activatedTs: NOW - 30_000,
        highWaterBidPaise: 16_000,
        stopPaise: 15_100,
      },
    }));
    // Two total CE lots reach the side cap, so no additional CE bid is allowed.
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids.some((d) => d.instrumentId === CE_ID)).toBe(false);
  });

  it('both sides cap independently', () => {
    const e = engine({ maxLotsPerSide: 2, maxScalpLots: 4, maxLotsInventory: 5 });
    const ceBook = book('CE', 2, 15_000);
    const peBook = book('PE', 2, 15_000);
    const out = e.evaluate(baseInput({ books: [ceBook, peBook] }));
    const bids = out.desired.filter((d) => d.side === 'BUY');
    expect(bids).toHaveLength(0); // both sides at cap
  });
});

describe('v0.5 production directional long-option policy', () => {
  it('is frozen at one global lot, with the runner disabled and neutral entries suppressed', () => {
    expect(strategy.version).toBe('0.5.0');
    expect(strategy.params).toEqual(expect.objectContaining({
      maxLotsInventory: 1,
      maxScalpLots: 1,
      maxLotsPerSide: 1,
      runnerLots: 0,
      ladderLevels: 1,
      directionalOnly: true,
      minRequoteMs: 5_000,
    }));
  });

  it('plans at most one CE and one PE even with multiple requested ladder levels', () => {
    const e = engine({
      maxLotsInventory: 2,
      maxScalpLots: 2,
      maxLotsPerSide: 1,
      runnerLots: 0,
      ladderLevels: 3,
    });
    const bids = e.evaluate(baseInput()).desired.filter((order) => order.side === 'BUY');
    expect(bids).toHaveLength(2);
    expect(bids.filter((order) => order.instrumentId === CE_ID)).toHaveLength(1);
    expect(bids.filter((order) => order.instrumentId === PE_ID)).toHaveLength(1);
  });

  it('leaves capacity unused rather than doubling the only quotable right', () => {
    const e = engine({
      maxLotsInventory: 2,
      maxScalpLots: 2,
      maxLotsPerSide: 1,
      runnerLots: 0,
      ladderLevels: 3,
    });
    const bids = e.evaluate(baseInput({ atmCe: row(CE_ID, 'CE', 0, 15_010) }))
      .desired.filter((order) => order.side === 'BUY');
    expect(bids).toHaveLength(1);
    expect(bids[0]?.instrumentId).toBe(PE_ID);
  });
});

describe('v0.3 escalating same-right loss-streak cooldown', () => {
  it('first losing defensive exit applies the normal 180s cooldown', () => {
    const e = engine();
    e.noteDefensiveExit('CE', NOW);
    const out = e.evaluate(baseInput({ nowMs: NOW + 1_000 }));
    const d = out.defences.find((x) => x.right === 'CE');
    expect(d?.reason).toBe('COOLDOWN');
    expect(d?.untilTs).toBe(NOW + 180_000);
    expect(out.lossStreaks.CE).toBe(1);
  });

  it('the second consecutive loss escalates to 900s and reports LOSS_STREAK', () => {
    const e = engine();
    e.noteDefensiveExit('CE', NOW);
    e.noteDefensiveExit('CE', NOW + 200_000);
    const out = e.evaluate(baseInput({ nowMs: NOW + 201_000 }));
    const d = out.defences.find((x) => x.right === 'CE');
    expect(d?.reason).toBe('LOSS_STREAK');
    expect(d?.untilTs).toBe(NOW + 200_000 + 900_000);
    expect(out.lossStreaks.CE).toBe(2);
    // PE is untouched.
    expect(out.defences.some((x) => x.right === 'PE')).toBe(false);
    expect(out.desired.some((x) => x.side === 'BUY' && x.instrumentId === PE_ID)).toBe(true);
  });

  it('a positive exit resets the streak back to the normal cooldown', () => {
    const e = engine();
    e.noteDefensiveExit('CE', NOW);
    e.noteDefensiveExit('CE', NOW + 200_000);
    e.notePositiveExit('CE');
    e.noteDefensiveExit('CE', NOW + 400_000);
    const out = e.evaluate(baseInput({ nowMs: NOW + 401_000 }));
    const d = out.defences.find((x) => x.right === 'CE');
    expect(d?.reason).toBe('COOLDOWN');
    expect(d?.untilTs).toBe(NOW + 400_000 + 180_000);
    expect(out.lossStreaks.CE).toBe(1);
  });

  it('lossStreakEscalation=0 disables escalation', () => {
    const e = engine({ lossStreakEscalation: 0 });
    e.noteDefensiveExit('CE', NOW);
    e.noteDefensiveExit('CE', NOW + 200_000);
    const out = e.evaluate(baseInput({ nowMs: NOW + 201_000 }));
    const d = out.defences.find((x) => x.right === 'CE');
    expect(d?.reason).toBe('COOLDOWN');
    expect(d?.untilTs).toBe(NOW + 200_000 + 180_000);
  });
});
