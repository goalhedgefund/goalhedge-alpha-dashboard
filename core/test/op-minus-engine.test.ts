import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema } from '../src/config/schemas.js';
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import type { Fill, Order, OrderIntent } from '../src/domain/orders.js';
import { OpMinusEngine, type OpMinusInput } from '../src/mm/op-minus-engine.js';
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
