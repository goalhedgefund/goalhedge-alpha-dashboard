import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema } from '../src/config/schemas.js';
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';
import type { Order, OrderIntent } from '../src/domain/orders.js';
import type { Position } from '../src/domain/positions.js';
import type { RiskVerdict } from '../src/domain/risk.js';
import { ManualClock } from '../src/domain/time.js';
import { flattenAllPositions, type FlattenOmsPort } from '../src/oms/flatten.js';
import type { SubmitResult } from '../src/oms/oms.js';
import { RiskGate } from '../src/risk/risk-gate.js';

const configDir = new URL('../../config/', import.meta.url);
const market = loadConfig(MarketProfileSchema, fileURLToPath(new URL('market/allop-nse-options.json', configDir))).value;
const risk = loadConfig(RiskProfileSchema, fileURLToPath(new URL('risk/op-minus-paper.json', configDir))).value;
const sessionId = makeSessionId('2026-07-22', 'paper');
const shortId = makeInstrumentId('NSE', 'short');
const hedgeId = makeInstrumentId('NSE', 'hedge');

function position(instrumentId: typeof shortId, side: 'BUY' | 'SELL', sequence: number): Position {
  return {
    positionId: `pos-${sequence}` as Position['positionId'], sessionId, strategyId: 'op-minus-atm-short',
    instrumentId, side, qty: market.contract.lotSize, avgEntryPricePaise: 10_000,
    state: 'OPEN', realizedGrossPaise: 0, openedTs: 1, updatedTs: 1,
  };
}

describe('covered short flatten ordering', () => {
  it('buys shorts first and releases long hedges only after the short book is flat', async () => {
    const submitted: OrderIntent[] = [];
    let positions: Position[] = [position(shortId, 'SELL', 1), position(hedgeId, 'BUY', 2)];
    const oms: FlattenOmsPort = {
      getOrders: () => [],
      getPositions: () => positions,
      cancel: async () => undefined,
      submit: async (intent: OrderIntent, _verdict: RiskVerdict): Promise<SubmitResult> => {
        submitted.push(intent);
        return { accepted: true, order: { ...intent, clientOrderId: `order-${submitted.length}` as Order['clientOrderId'], filledQty: 0, avgFillPricePaise: 0, state: 'SENT', createdTs: 1, updatedTs: 1 } as Order };
      },
    };
    const clock = new ManualClock(1);
    const ids = new IdFactory(sessionId);
    const gate = new RiskGate(market, risk);
    const ports = {
      sessionId, oms, gate, ids, market, clock, protectTicks: 5,
      markPrice: (_instrumentId: unknown, side?: 'BUY' | 'SELL') => side === 'BUY' ? 10_010 : 9_990,
      gateContext: () => ({
        nowMs: 1, nowHHMM: '10:00', allowedInstruments: new Set([shortId, hedgeId]),
        optionRows: new Map(), openPositions: positions,
        session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
      }),
    };

    await flattenAllPositions(ports, 'KILL', 'kill:test');
    expect(submitted.map((intent) => ({ side: intent.side, instrumentId: intent.instrumentId }))).toEqual([
      { side: 'BUY', instrumentId: shortId },
    ]);

    positions = [position(hedgeId, 'BUY', 2)];
    await flattenAllPositions(ports, 'KILL', 'kill:test:retry');
    expect(submitted.map((intent) => ({ side: intent.side, instrumentId: intent.instrumentId }))).toEqual([
      { side: 'BUY', instrumentId: shortId },
      { side: 'SELL', instrumentId: hedgeId },
    ]);
  });
});
