/**
 * Exit-lane regression tests: an exit (STOP / EXIT / SQUARE_OFF / KILL) must
 * NEVER be trapped by entry eligibility. These pin the purpose-aware gate.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import {
  MarketProfileSchema,
  RiskProfileSchema,
  type MarketProfile,
  type RiskProfile,
} from '../src/config/schemas.js';
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';
import type { IntentPurpose, OrderIntent } from '../src/domain/orders.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import type { Position } from '../src/domain/positions.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import { StopEngine } from '../src/stops/stop-engine.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(
  MarketProfileSchema,
  fileURLToPath(new URL('market/india-nse-options.json', configDir)),
).value;
const risk: RiskProfile = loadConfig(
  RiskProfileSchema,
  fileURLToPath(new URL('risk/paper-default.json', configDir)),
).value;
const SESSION = makeSessionId('2026-07-03', 'paper');
const INSTR = makeInstrumentId('NSE', '35022');

function exitIntent(ids: IdFactory, purpose: IntentPurpose, overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intentId: ids.intentId(),
    sessionId: SESSION,
    strategyId: 's1',
    ts: 1,
    side: 'SELL',
    instrumentId: INSTR,
    qty: 65,
    type: 'LIMIT',
    limitPricePaise: 9_500,
    ttlMs: 500,
    tag: 's1:stop:L1_HARD_PREMIUM',
    purpose,
    ...overrides,
  };
}

function blownSpreadRow(): OptionChainRow {
  return {
    instrumentId: INSTR,
    strikePaise: 29_300_00,
    right: 'CE',
    expiry: '2026-07-07',
    ltpPaise: 10_000,
    bidPaise: 9_000,
    askPaise: 11_000, // 20% spread — far beyond any gate
    bidQty: 65,
    askQty: 65,
    volume: 0, // and zero liquidity
    oi: 0,
    updatedTs: 1,
  };
}

function ctx(overrides: Partial<RiskGateContext> = {}): RiskGateContext {
  return {
    nowMs: 1,
    nowHHMM: '10:00',
    allowedInstruments: new Set([INSTR]),
    optionRows: new Map([[INSTR, blownSpreadRow()]]),
    atmStrikePaise: 29_300_00,
    openPositions: [],
    session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
    ...overrides,
  };
}

const gate = new RiskGate(market, risk);

describe('exit lane is never trapped by entry eligibility', () => {
  it('STOP exit passes while a session stop is LATCHED (flatten after daily-loss halt)', () => {
    const ids = new IdFactory(SESSION);
    const verdict = gate.evaluate(
      exitIntent(ids, 'STOP'),
      ctx({ session: { realizedNetPnlPaise: -2_000_000, peakNetPnlPaise: 0, lossStreak: 3, tradesTaken: 5, latchedStop: 'DAILY_LOSS' } }),
    );
    expect(verdict.approved).toBe(true);
  });

  it('SQUARE_OFF passes after the entry cutoff (15:12 hard flatten)', () => {
    const ids = new IdFactory(SESSION);
    const verdict = gate.evaluate(exitIntent(ids, 'SQUARE_OFF'), ctx({ nowHHMM: '15:12' }));
    expect(verdict.approved).toBe(true);
  });

  it('exit is rejected only past the session close', () => {
    const ids = new IdFactory(SESSION);
    const verdict = gate.evaluate(exitIntent(ids, 'SQUARE_OFF'), ctx({ nowHHMM: '15:35' }));
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toBe('MARKET_CLOSED');
  });

  it('STOP exit passes through a spread blowout with zero liquidity', () => {
    const ids = new IdFactory(SESSION);
    const verdict = gate.evaluate(exitIntent(ids, 'STOP'), ctx());
    expect(verdict.approved).toBe(true);
  });

  it('EXIT passes when the daily trade count is exhausted', () => {
    const ids = new IdFactory(SESSION);
    const verdict = gate.evaluate(
      exitIntent(ids, 'EXIT'),
      ctx({ session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: risk.maxTradesPerDay, latchedStop: 'MAX_TRADES' } }),
    );
    expect(verdict.approved).toBe(true);
  });

  it('KILL flatten passes under every adverse condition at once', () => {
    const ids = new IdFactory(SESSION);
    const verdict = gate.evaluate(
      exitIntent(ids, 'KILL'),
      ctx({
        nowHHMM: '15:20',
        session: { realizedNetPnlPaise: -9_999_999, peakNetPnlPaise: 0, lossStreak: 9, tradesTaken: 99, latchedStop: 'DAILY_LOSS' },
        throttleAvailable: 0,
      }),
    );
    expect(verdict.approved).toBe(true);
  });

  it('exit still enforces exchange sanity: non-lot quantity rejected', () => {
    const ids = new IdFactory(SESSION);
    const verdict = gate.evaluate(exitIntent(ids, 'STOP', { qty: 70 }), ctx());
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toBe('MAX_LOTS_PER_ORDER');
  });

  it('exit still enforces exchange sanity: freeze quantity rejected', () => {
    const ids = new IdFactory(SESSION);
    const verdict = gate.evaluate(
      exitIntent(ids, 'STOP', { qty: market.contract.freezeQty + market.contract.lotSize }),
      ctx(),
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toBe('FREEZE_QTY');
  });

  it('ENTRY under the same adverse conditions is still rejected', () => {
    const ids = new IdFactory(SESSION);
    const entry = exitIntent(ids, 'ENTRY', {
      side: 'BUY',
      stopPlan: { hardStopPremiumPaise: 8_000, timeStopSec: 60 },
    });
    const verdict = gate.evaluate(
      entry,
      ctx({ session: { realizedNetPnlPaise: -2_000_000, peakNetPnlPaise: 0, lossStreak: 3, tradesTaken: 5, latchedStop: 'DAILY_LOSS' } }),
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toBe('SESSION_STOP_LATCHED');
  });
});

describe('StopEngine.disarm prevents duplicate exit intents', () => {
  function pos(): Position {
    return {
      positionId: new IdFactory(SESSION).positionId(),
      sessionId: SESSION,
      strategyId: 's1',
      instrumentId: INSTR,
      side: 'BUY',
      qty: 65,
      avgEntryPricePaise: 10_000,
      state: 'OPEN',
      realizedGrossPaise: 0,
      openedTs: 1_000,
      updatedTs: 1_000,
    };
  }

  it('after trigger + disarm, update() returns undefined (no re-fire)', () => {
    const ids = new IdFactory(SESSION);
    const engine = new StopEngine({ ids, tickSizePaise: 5 });
    const p = pos();
    engine.arm(p, { hardStopPremiumPaise: 9_000, timeStopSec: 600 });

    const first = engine.update(p, { nowMs: 2_000, premiumPaise: 8_900 });
    expect(first?.trigger?.reason).toBe('L1_HARD_PREMIUM');

    expect(engine.disarm(p.positionId)).toBe(true);
    const second = engine.update(p, { nowMs: 3_000, premiumPaise: 8_800 });
    expect(second).toBeUndefined();
    expect(engine.get(p.positionId)).toBeUndefined();
  });

  it('without disarm, a second update re-fires (documents why disarm is mandatory)', () => {
    const ids = new IdFactory(SESSION);
    const engine = new StopEngine({ ids, tickSizePaise: 5 });
    const p = pos();
    engine.arm(p, { hardStopPremiumPaise: 9_000, timeStopSec: 600 });
    const first = engine.update(p, { nowMs: 2_000, premiumPaise: 8_900 });
    const second = engine.update(p, { nowMs: 2_100, premiumPaise: 8_900 });
    expect(first?.trigger).toBeDefined();
    expect(second?.trigger).toBeDefined();
    expect(second?.trigger?.exitIntent.intentId).not.toBe(first?.trigger?.exitIntent.intentId);
  });
});
