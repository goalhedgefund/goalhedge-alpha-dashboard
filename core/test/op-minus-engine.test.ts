import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema } from '../src/config/schemas.js';
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import type { Fill, Order, OrderIntent } from '../src/domain/orders.js';
import { OpMinusEngine, type OpMinusInput } from '../src/mm/op-minus-engine.js';
import type { UnderlyingFeatures } from '../src/marketdata/features/library.js';
import { PositionKeeper } from '../src/oms/position-keeper.js';
import { RiskGate } from '../src/risk/risk-gate.js';

const configDir = new URL('../../config/', import.meta.url);
const market = loadConfig(
  MarketProfileSchema,
  fileURLToPath(new URL('market/allop-nse-options.json', configDir)),
).value;
const risk = loadConfig(
  RiskProfileSchema,
  fileURLToPath(new URL('risk/op-minus-paper.json', configDir)),
).value;
const sessionId = makeSessionId('2026-07-22', 'paper');
const ids = new IdFactory(sessionId);
const lot = market.contract.lotSize;
const SCALP_EXPIRY = '2026-07-28';

function row(token: string, right: 'CE' | 'PE', expiry: string, bid = 9_990, ask = 10_000): OptionChainRow {
  return {
    instrumentId: makeInstrumentId('NSE', token),
    strikePaise: 2_500_000,
    right,
    expiry,
    ltpPaise: Math.round((bid + ask) / 2),
    bidPaise: bid,
    askPaise: ask,
    bidQty: lot * 10,
    askQty: lot * 10,
    volume: 10_000,
    oi: 100_000,
    updatedTs: 1,
  };
}

const scalpCe = row('s-ce', 'CE', SCALP_EXPIRY);
const scalpPe = row('s-pe', 'PE', SCALP_EXPIRY);
const params = {
  scalpLotsPerRight: 2,
  rewardRiskRatio: 2,
  runnerLots: 1,
  targetPremiumPct: 5,
  hardStopPremiumPct: 9,
  rangeFilterEnabled: false,
  maxHoldSec: 180,
  quoteFrom: '09:20',
  entryCutoff: '15:10',
};

function baseInput(overrides: Partial<OpMinusInput> = {}): OpMinusInput {
  return {
    nowMs: 1_000,
    nowHHMM: '10:00',
    scalpCe,
    scalpPe,
    shortBooks: [],
    latchedStop: false,
    ...overrides,
  };
}

function shortBook(right: 'CE' | 'PE', askPaise = 9_000) {
  const selected = right === 'CE' ? { ...scalpCe, askPaise } : { ...scalpPe, askPaise };
  return {
    instrumentId: selected.instrumentId,
    right,
    qty: 2 * lot,
    lots: [
      { lotId: `${right}-s1`, qty: lot, entryPricePaise: 10_000, openedTs: 1 },
      { lotId: `${right}-s2`, qty: lot, entryPricePaise: 10_000, openedTs: 2 },
    ],
    row: selected,
  };
}

describe('OP(-) naked short engine', () => {
  it('proposes exactly two CE and two PE one-lot shorts without hedge orders', () => {
    const evaluation = new OpMinusEngine(market, params).evaluate(baseInput());
    const entries = evaluation.desired.filter((order) => order.reason === 'SHORT_ENTRY');
    expect(evaluation.phase).toBe('SCALPING');
    expect(entries).toHaveLength(4);
    expect(entries.every((order) => order.side === 'SELL' && order.qty === lot)).toBe(true);
    expect(entries.filter((order) => order.instrumentId === scalpCe.instrumentId)).toHaveLength(2);
    expect(entries.filter((order) => order.instrumentId === scalpPe.instrumentId)).toHaveLength(2);
  });

  it('uses premium-based stop and target levels that are never tighter than costs', () => {
    const engine = new OpMinusEngine(market, params);
    const cost = engine.costRiskPaise(10_000);
    expect(cost).toBeGreaterThan(0);
    expect(engine.hardStopPaise(10_000)).toBe(10_900);
    expect(engine.targetPaise(10_000)).toBe(9_500);
  });

  it('pauses new short entries when the range filter detects trend or VWAP stretch', () => {
    const evaluation = new OpMinusEngine(market, {
      ...params,
      rangeFilterEnabled: true,
      maxAbsRet30Pct: 0.001,
      maxVwapDistancePct: 0.0015,
    }).evaluate(baseInput({
      spotPaise: 2_510_000,
      underlying: {
        ret1s: 0.001,
        ret5s: 0.002,
        ret30s: 0.003,
        vwapPaise: 2_500_000,
        atr1mPaise: 1_000,
        tickVelocityPerSec: 1,
        volumeBurstRatio: 1,
        codexScore: { bull: 0, bear: 0, signal: 'WAIT', trend: 'flat', indicators: { last: 2_510_000 } },
      },
    }));
    expect(evaluation.phase).toBe('PAUSED_REGIME');
    expect(evaluation.desired.filter((order) => order.purpose === 'ENTRY')).toHaveLength(0);
  });

  it('quotes only the configured expiry window while continuing to manage open shorts', () => {
    const engine = new OpMinusEngine(market, { ...params, maxDaysToExpiry: 1 });
    const paused = engine.evaluate(baseInput({ daysToExpiry: 2, shortBooks: [shortBook('CE')] }));
    expect(paused.phase).toBe('PAUSED_DTE');
    expect(paused.pauseReason).toContain('DTE 2');
    expect(paused.desired.some((order) => order.purpose === 'ENTRY')).toBe(false);
    expect(paused.desired.some((order) => order.purpose === 'EXIT')).toBe(true);

    expect(engine.evaluate(baseInput({ daysToExpiry: 1 })).phase).toBe('SCALPING');
    expect(engine.evaluate(baseInput({ daysToExpiry: 0 })).phase).toBe('SCALPING');
  });

  it('reserves one global runner candidate and targets only its paired lot on that right', () => {
    const evaluation = new OpMinusEngine(market, params).evaluate(baseInput({
      shortBooks: [shortBook('CE'), shortBook('PE')],
    }));
    expect(evaluation.runnerCandidateLotId).toBeDefined();
    const candidateRight = evaluation.runnerCandidateLotId?.startsWith('CE') ? 'CE' : 'PE';
    const targetIds = evaluation.desired.filter((order) => order.reason === 'TARGET').flatMap((order) => order.closeLotIds ?? []);
    expect(targetIds).not.toContain(evaluation.runnerCandidateLotId);
    expect(targetIds.filter((id) => id.startsWith(candidateRight))).toHaveLength(1);
    expect(targetIds).toHaveLength(3);
  });

  it('applies the ADX, ATR-stretch, and straddle-drift gates when configured', () => {
    const engine = new OpMinusEngine(market, {
      ...params,
      rangeFilterEnabled: true,
      maxAbsRet30Pct: 0.01,
      maxVwapDistancePct: 0.01,
      maxVwapDistanceAtrMult: 2,
      maxAdx: 18,
      maxStraddleRisePct: 0.02,
    });
    const underlying = (adx: number | undefined, atr = 1_000) => ({
      ret1s: 0,
      ret5s: 0,
      ret30s: 0,
      vwapPaise: 2_500_000,
      atr1mPaise: atr,
      ...(adx !== undefined ? { adx1m: adx } : {}),
      tickVelocityPerSec: 1,
      volumeBurstRatio: 1,
      codexScore: { bull: 0, bear: 0, signal: 'WAIT' as const, trend: 'flat' as const, indicators: { last: 2_500_500 } },
    });
    // Spot 500 paise from VWAP: inside the 1% cap, inside 2×ATR(1000).
    const calm = (over: Partial<OpMinusInput> = {}) =>
      baseInput({ spotPaise: 2_500_500, straddleDriftPct: 0, underlying: underlying(10), ...over });

    expect(engine.evaluate(calm()).phase).toBe('SCALPING');
    expect(engine.evaluate(calm({ underlying: underlying(25) })).phase).toBe('PAUSED_REGIME'); // trending
    expect(engine.evaluate(calm({ underlying: underlying(undefined) })).phase).toBe('PAUSED_REGIME'); // ADX warm-up
    expect(engine.evaluate(calm({ underlying: underlying(10, 200) })).phase).toBe('PAUSED_REGIME'); // stretch > 2×ATR
    expect(engine.evaluate(calm({ straddleDriftPct: 0.03 })).phase).toBe('PAUSED_REGIME'); // straddle bid = IV rising
    const noDrift = baseInput({ spotPaise: 2_500_500, underlying: underlying(10) });
    expect(engine.evaluate(noDrift).phase).toBe('PAUSED_REGIME'); // drift window still filling
    expect(engine.evaluate(calm({ straddleDriftPct: -0.05 })).phase).toBe('SCALPING'); // falling IV is fine
  });

  it('reports the specific range-gate code and detail that blocked entries', () => {
    const engine = new OpMinusEngine(market, {
      ...params,
      rangeFilterEnabled: true,
      maxAbsRet30Pct: 0.001,
      maxVwapDistancePct: 0.0015,
      maxVwapDistanceAtrMult: 1.5,
      maxAdx: 18,
      maxStraddleRisePct: 0.02,
      straddleTrendWindowSec: 180,
    });
    // adx1m: 'omit' drops the field entirely (exactOptionalPropertyTypes bars an
    // explicit undefined) to exercise the ADX warm-up branch.
    const underlying = (over: { ret30s?: number; atr1mPaise?: number; adx1m?: number | 'omit' } = {}): UnderlyingFeatures => ({
      ret1s: 0, ret5s: 0, ret30s: over.ret30s ?? 0, vwapPaise: 2_500_000,
      atr1mPaise: over.atr1mPaise ?? 1_000, tickVelocityPerSec: 1, volumeBurstRatio: 1,
      codexScore: { bull: 0, bear: 0, signal: 'WAIT', trend: 'flat', indicators: { last: 2_500_000 } },
      ...(over.adx1m === 'omit' ? {} : { adx1m: over.adx1m ?? 10 }),
    });
    // Baseline calm input that clears every gate: spot at VWAP, flat, low ADX.
    const calm = (over: Partial<OpMinusInput> = {}): OpMinusInput =>
      baseInput({ spotPaise: 2_500_000, straddleDriftPct: 0, underlying: underlying(), ...over });

    const codeOf = (input: OpMinusInput) => {
      const e = engine.evaluate(input);
      return { phase: e.phase, code: e.pauseCode, detail: e.pauseReason };
    };

    // No underlying features at all -> FEATURES_WARMUP.
    expect(codeOf(baseInput({ straddleDriftPct: 0 })).code).toBe('FEATURES_WARMUP');
    // ret30 too hot.
    expect(codeOf(calm({ underlying: underlying({ ret30s: 0.02 }) })).code).toBe('RET30');
    // Spot stretched from VWAP beyond the fixed % cap.
    expect(codeOf(calm({ spotPaise: 2_510_000 })).code).toBe('VWAP');
    // ATR not warmed up.
    expect(codeOf(calm({ underlying: underlying({ atr1mPaise: 0 }) })).code).toBe('ATR_WARMUP');
    // ADX warm-up (field absent) vs trending (too high) are distinct codes.
    expect(codeOf(calm({ underlying: underlying({ adx1m: 'omit' }) })).code).toBe('ADX_WARMUP');
    expect(codeOf(calm({ underlying: underlying({ adx1m: 30 }) })).code).toBe('ADX');
    // Straddle window still filling (undefined) vs rising IV are distinct.
    const noDrift = baseInput({ spotPaise: 2_500_000, underlying: underlying() });
    expect(codeOf(noDrift).code).toBe('STRADDLE_WARMUP');
    const straddleUp = codeOf(calm({ straddleDriftPct: 0.05 }));
    expect(straddleUp.code).toBe('STRADDLE');
    expect(straddleUp.detail).toContain('IV rising');
    // All gates clear -> no pause.
    expect(codeOf(calm()).phase).toBe('SCALPING');
    expect(codeOf(calm()).code).toBeUndefined();
  });

  it('can disable the session-VWAP distance gates while retaining momentum and ADX protection', () => {
    const engine = new OpMinusEngine(market, {
      ...params,
      rangeFilterEnabled: true,
      maxAbsRet30Pct: 0.0015,
      maxVwapDistancePct: 0,
      maxVwapDistanceAtrMult: 0,
      maxAdx: 25,
      maxStraddleRisePct: 0.01,
    });
    const underlying: UnderlyingFeatures = {
      ret1s: 0, ret5s: 0, ret30s: 0, vwapPaise: 2_400_000, atr1mPaise: 500, adx1m: 12,
      tickVelocityPerSec: 1, volumeBurstRatio: 1,
      codexScore: { bull: 0, bear: 0, signal: 'WAIT', trend: 'flat', indicators: { last: 2_500_000 } },
    };
    expect(engine.evaluate(baseInput({
      spotPaise: 2_500_000,
      underlying,
      straddleDriftPct: 0,
    })).phase).toBe('SCALPING');
    expect(engine.evaluate(baseInput({
      spotPaise: 2_500_000,
      underlying: { ...underlying, ret30s: 0.01 },
      straddleDriftPct: 0,
    })).phase).toBe('PAUSED_REGIME');
  });

  it('trips the combined pair stop when both rights bleed without either leg stop firing', () => {
    // 7% adverse on each leg: below the 9% per-leg stop, above the 6% pair stop.
    const evaluation = new OpMinusEngine(market, params).evaluate(baseInput({
      shortBooks: [shortBook('CE', 10_700), shortBook('PE', 10_700)],
    }));
    const combined = evaluation.desired.filter((order) => order.reason === 'COMBINED_STOP');
    expect(combined).toHaveLength(4);
    expect(combined.every((order) => order.side === 'BUY' && order.purpose === 'EXIT')).toBe(true);
    expect(evaluation.desired.some((order) => order.reason === 'TARGET')).toBe(false);
  });

  it('manages a theta scalp as one CE+PE package when paired exits are enabled', () => {
    const engine = new OpMinusEngine(market, {
      ...params,
      pairedExitEnabled: true,
      combinedTargetPremiumPct: 1,
      combinedStopPremiumPct: 3,
      maxHoldSec: 600,
      leggingTimeoutSec: 5,
    });
    const target = engine.evaluate(baseInput({
      shortBooks: [shortBook('CE', 9_900), shortBook('PE', 9_900)],
    }));
    expect(target.desired.filter((order) => order.reason === 'COMBINED_TARGET')).toHaveLength(4);
    expect(target.desired.some((order) => order.reason === 'TARGET')).toBe(false);

    const holding = engine.evaluate(baseInput({
      shortBooks: [shortBook('CE', 9_950), shortBook('PE', 9_950)],
    }));
    expect(holding.desired).toHaveLength(0);

    const timedOut = engine.evaluate(baseInput({
      nowMs: 700_000,
      shortBooks: [shortBook('CE', 9_950), shortBook('PE', 9_950)],
    }));
    expect(timedOut.desired.filter((order) => order.reason === 'PAIR_TIMEOUT')).toHaveLength(4);
  });

  it('uses a later, slower package profile on DTE 1 without weakening DTE 0', () => {
    const engine = new OpMinusEngine(market, {
      ...params,
      pairedExitEnabled: true,
      combinedTargetPremiumPct: 1,
      dte1CombinedTargetPremiumPct: 2,
      maxHoldSec: 600,
      dte1MaxHoldSec: 1_200,
      quoteFrom: '09:45',
      dte1QuoteFrom: '12:00',
      entryCutoff: '15:00',
      dte1EntryCutoff: '14:50',
    });
    expect(engine.evaluate(baseInput({ nowHHMM: '11:00', daysToExpiry: 0 })).phase).toBe('SCALPING');
    expect(engine.evaluate(baseInput({ nowHHMM: '11:00', daysToExpiry: 1 })).phase).toBe('PAUSED_WINDOW');
    expect(engine.evaluate(baseInput({ nowHHMM: '14:50', daysToExpiry: 0 })).phase).toBe('SCALPING');
    expect(engine.evaluate(baseInput({ nowHHMM: '14:50', daysToExpiry: 1 })).phase).toBe('EXIT_ONLY');

    const books = [shortBook('CE', 9_900), shortBook('PE', 9_900)];
    expect(engine.evaluate(baseInput({ nowHHMM: '13:00', daysToExpiry: 0, shortBooks: books }))
      .desired.filter((order) => order.reason === 'COMBINED_TARGET')).toHaveLength(4);
    expect(engine.evaluate(baseInput({ nowHHMM: '13:00', daysToExpiry: 1, shortBooks: books }))
      .desired.filter((order) => order.reason === 'COMBINED_TARGET')).toHaveLength(0);
  });

  it('closes an unpaired fill quickly and does not add the missing short while that exit is pending', () => {
    const engine = new OpMinusEngine(market, {
      ...params,
      pairedExitEnabled: true,
      leggingTimeoutSec: 5,
    });
    const evaluation = engine.evaluate(baseInput({
      nowMs: 10_000,
      shortBooks: [shortBook('CE', 10_000)],
    }));
    expect(evaluation.desired.filter((order) => order.reason === 'UNPAIRED_TIMEOUT')).toHaveLength(2);
    expect(evaluation.desired.some((order) => order.purpose === 'ENTRY')).toBe(false);
  });

  it('never trips the combined stop while only one right is short', () => {
    const evaluation = new OpMinusEngine(market, params).evaluate(baseInput({
      shortBooks: [shortBook('CE', 10_700)],
    }));
    expect(evaluation.desired.some((order) => order.reason === 'COMBINED_STOP')).toBe(false);
    expect(evaluation.desired.some((order) => order.reason === 'HARD_STOP')).toBe(false);
  });

  it('rests entry sells at the ask when the spread is one tick — never at the bid', () => {
    const oneTickCe = { ...scalpCe, bidPaise: 9_995, askPaise: 10_000 };
    const evaluation = new OpMinusEngine(market, params).evaluate({
      nowMs: 1_000,
      nowHHMM: '10:00',
      scalpCe: oneTickCe,
      shortBooks: [],
      latchedStop: false,
    });
    const entries = evaluation.desired.filter((order) => order.reason === 'SHORT_ENTRY');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((order) => order.limitPricePaise === 10_000)).toBe(true);
  });

  it('crosses both paired entries to the bid so the package does not leg in passively', () => {
    const oneTickCe = { ...scalpCe, bidPaise: 9_995, askPaise: 10_000 };
    const oneTickPe = { ...scalpPe, bidPaise: 8_995, askPaise: 9_000 };
    const evaluation = new OpMinusEngine(market, { ...params, pairedExitEnabled: true }).evaluate(baseInput({
      scalpCe: oneTickCe,
      scalpPe: oneTickPe,
    }));
    const entries = evaluation.desired.filter((order) => order.reason === 'SHORT_ENTRY');
    expect(entries.map((order) => order.limitPricePaise)).toEqual([9_995, 9_995, 8_995, 8_995]);
  });

  it('uses the protected paired-entry limit below the bid', () => {
    const evaluation = new OpMinusEngine(market, {
      ...params,
      pairedExitEnabled: true,
      pairedEntryAtBid: true,
      pairedEntryProtectTicks: 10,
    }).evaluate(baseInput());
    const entries = evaluation.desired.filter((order) => order.reason === 'SHORT_ENTRY');
    expect(entries.map((order) => order.limitPricePaise)).toEqual([9_940, 9_940, 9_940, 9_940]);
  });

  it('honors the expiry-scalper shape: one lot per right, no runner, DTE 0-1, 09:45–15:10', () => {
    const engine = new OpMinusEngine(market, {
      ...params,
      scalpLotsPerRight: 1,
      runnerLots: 0,
      maxDaysToExpiry: 1,
      quoteFrom: '09:45',
      entryCutoff: '15:10',
    });
    const scalping = engine.evaluate(baseInput({ daysToExpiry: 1 }));
    expect(scalping.phase).toBe('SCALPING');
    const entries = scalping.desired.filter((order) => order.reason === 'SHORT_ENTRY');
    expect(entries).toHaveLength(2);
    expect(entries.filter((order) => order.instrumentId === scalpCe.instrumentId)).toHaveLength(1);
    expect(entries.filter((order) => order.instrumentId === scalpPe.instrumentId)).toHaveLength(1);

    const withBooks = engine.evaluate(baseInput({ shortBooks: [shortBook('CE'), shortBook('PE')] }));
    expect(withBooks.runnerCandidateLotId).toBeUndefined();

    const early = engine.evaluate(baseInput({ nowHHMM: '09:44' }));
    expect(early.phase).toBe('PAUSED_WINDOW');
    expect(early.desired.filter((order) => order.purpose === 'ENTRY')).toHaveLength(0);

    const tooEarlyInCycle = engine.evaluate(baseInput({ daysToExpiry: 2 }));
    expect(tooEarlyInCycle.phase).toBe('PAUSED_DTE');

    const late = engine.evaluate(baseInput({ nowHHMM: '15:10', daysToExpiry: 1 }));
    expect(late.phase).toBe('EXIT_ONLY');
    expect(late.desired.filter((order) => order.purpose === 'ENTRY')).toHaveLength(0);
  });

  it('holds an active runner until its short cost stop is crossed', () => {
    const engine = new OpMinusEngine(market, params);
    const stop = engine.runnerCostStopPaise(10_000);
    const quiet = engine.evaluate(baseInput({
      shortBooks: [shortBook('CE', stop - 5)],
      runner: {
        ...shortBook('CE').lots[0]!,
        instrumentId: scalpCe.instrumentId,
        activatedTs: 10,
        lowWaterAskPaise: 8_000,
        stopPaise: stop,
      },
    }));
    expect(quiet.desired.some((order) => order.reason === 'RUNNER_COST_STOP')).toBe(false);

    const stopped = engine.evaluate(baseInput({
      shortBooks: [shortBook('CE', stop)],
      runner: {
        ...shortBook('CE').lots[0]!,
        instrumentId: scalpCe.instrumentId,
        activatedTs: 10,
        lowWaterAskPaise: 8_000,
        stopPaise: stop,
      },
    }));
    expect(stopped.desired.filter((order) => order.reason === 'RUNNER_COST_STOP')).toHaveLength(1);
  });

});

describe('shared short inventory and risk plumbing', () => {
  it('records SELL entry then BUY exit with short-side P&L', () => {
    const keeper = new PositionKeeper(sessionId, market, ids);
    const entryOrder: Order = {
      clientOrderId: ids.clientOrderId(), intentId: ids.intentId(), sessionId,
      instrumentId: scalpCe.instrumentId, side: 'SELL', qty: lot, filledQty: lot,
      avgFillPricePaise: 10_000, type: 'LIMIT', state: 'FILLED', purpose: 'ENTRY',
      tag: 'op-minus-atm-short:short_entry', createdTs: 1, updatedTs: 1,
    };
    const entryFill: Fill = { clientOrderId: entryOrder.clientOrderId, fillId: 'short-fill', ts: 1, qty: lot, pricePaise: 10_000 };
    keeper.onFill(entryOrder, entryFill);
    expect(keeper.getPositions()[0]).toMatchObject({ side: 'SELL', qty: lot });

    const exitOrder: Order = {
      clientOrderId: ids.clientOrderId(), intentId: ids.intentId(), sessionId,
      instrumentId: scalpCe.instrumentId, side: 'BUY', qty: lot, filledQty: lot,
      avgFillPricePaise: 9_000, type: 'LIMIT', state: 'FILLED', purpose: 'EXIT',
      tag: 'op-minus-atm-short:target', closeLotIds: ['short-fill'], createdTs: 2, updatedTs: 2,
    };
    const update = keeper.onFill(exitOrder, { clientOrderId: exitOrder.clientOrderId, fillId: 'cover-fill', ts: 2, qty: lot, pricePaise: 9_000 });
    expect(update.trades[0]).toMatchObject({ grossPnlPaise: 1_000 * lot, entry: { side: 'SELL' }, exit: { side: 'BUY' } });
    expect(keeper.getPositions()).toHaveLength(0);
  });

  it('risk gate accepts a SELL entry only when its stop is above entry', () => {
    const gate = new RiskGate(market, risk);
    const makeIntent = (stop: number): OrderIntent => ({
      intentId: ids.intentId(), sessionId, strategyId: 'op-minus-atm-short', ts: 1,
      side: 'SELL', instrumentId: scalpCe.instrumentId, qty: lot, type: 'LIMIT', limitPricePaise: 10_000,
      ttlMs: 1_000, tag: 'op-minus-atm-short:short_entry', purpose: 'ENTRY',
      stopPlan: { hardStopPremiumPaise: stop, timeStopSec: 180 },
    });
    const context = {
      nowMs: 1,
      nowHHMM: '10:00',
      allowedInstruments: new Set([scalpCe.instrumentId]),
      optionRows: new Map([[scalpCe.instrumentId, scalpCe]]),
      openPositions: [],
      session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
    };
    expect(gate.evaluate(makeIntent(10_100), context).approved).toBe(true);
    expect(gate.evaluate(makeIntent(9_900), context)).toMatchObject({ approved: false, reason: 'INVALID_STOP_PLAN' });
  });
});
