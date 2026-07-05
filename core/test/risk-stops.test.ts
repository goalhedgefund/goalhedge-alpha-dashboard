import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, type MarketProfile, type RiskProfile } from '../src/config/schemas.js';
import { IdFactory, makeInstrumentId, makeSessionId } from '../src/domain/ids.js';
import type { OrderIntent, StopPlan } from '../src/domain/orders.js';
import type { Position } from '../src/domain/positions.js';
import type { OptionChainRow } from '../src/domain/marketdata.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import { SessionRiskState } from '../src/risk/session-risk.js';
import { StopEngine } from '../src/stops/stop-engine.js';
import { buildLongOptionStopPlan } from '../src/strategy/stop-plan.js';
import { hashValue } from '../src/config/loader.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(MarketProfileSchema, fileURLToPath(new URL('market/india-nse-options.json', configDir))).value;
const risk: RiskProfile = loadConfig(RiskProfileSchema, fileURLToPath(new URL('risk/paper-default.json', configDir))).value;
const SESSION = makeSessionId('2026-07-03', 'paper');
const INSTR = makeInstrumentId('NSE', '35022');

function stopPlan(entry = 10_000): StopPlan {
  return {
    hardStopPremiumPaise: entry - 1000,
    hardStopUnderlyingPaise: 29_000_00,
    hardStopUnderlyingDir: 'BELOW',
    breakevenAtPaise: entry + 500,
    trailStepPaise: 500,
    trailLockPct: 50,
    timeStopSec: 30,
  };
}

function intent(ids: IdFactory, overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    intentId: ids.intentId(),
    sessionId: SESSION,
    strategyId: 's1',
    ts: 1,
    side: 'BUY',
    instrumentId: INSTR,
    qty: 65,
    type: 'LIMIT',
    limitPricePaise: 10_000,
    ttlMs: 1000,
    tag: 's1:entry',
    purpose: 'ENTRY',
    stopPlan: stopPlan(),
    ...overrides,
  };
}

function row(overrides: Partial<OptionChainRow> = {}): OptionChainRow {
  return {
    instrumentId: INSTR,
    strikePaise: 29_300_00,
    right: 'CE',
    expiry: '2026-07-07',
    ltpPaise: 10_000,
    bidPaise: 9_990,
    askPaise: 10_010,
    bidQty: 130,
    askQty: 130,
    volume: 1000,
    oi: 10_000,
    updatedTs: 1,
    ...overrides,
  };
}

function context(overrides: Partial<RiskGateContext> = {}): RiskGateContext {
  return {
    nowMs: 1,
    nowHHMM: '10:00',
    allowedInstruments: new Set([INSTR]),
    optionRows: new Map([[INSTR, row()]]),
    atmStrikePaise: 29_300_00,
    strikeBand: 5,
    maxSpreadPct: 0.015,
    minOi: 100,
    minVolume: 100,
    openPositions: [],
    session: { realizedNetPnlPaise: 0, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0 },
    throttleAvailable: 1,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
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
    ...overrides,
  };
}

describe('RiskGate ordered checks', () => {
  it('approves a valid entry and computes risk against stopPlan', () => {
    const ids = new IdFactory(SESSION);
    const gate = new RiskGate(market, risk);
    const next = intent(ids);
    const verdict = gate.evaluate(next, context());
    expect(verdict.approved).toBe(true);
    expect(verdict.riskPaise).toBe(65_000);
  });

  it('short-circuits on session stop before market checks', () => {
    const ids = new IdFactory(SESSION);
    const gate = new RiskGate(market, risk);
    const verdict = gate.evaluate(
      intent(ids),
      context({ nowHHMM: '08:00', session: { realizedNetPnlPaise: -1, peakNetPnlPaise: 0, lossStreak: 0, tradesTaken: 0, latchedStop: 'DAILY_LOSS' } }),
    );
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toBe('SESSION_STOP_LATCHED');
  });

  it('rejects spread, liquidity, missing stop, position limit and throttle failures', () => {
    const ids = new IdFactory(SESSION);
    const gate = new RiskGate(market, risk);
    expect(gate.evaluate(intent(ids), context({ optionRows: new Map([[INSTR, row({ bidPaise: 9000, askPaise: 10_500 })]]) })).reason).toBe('SPREAD_GATE');
    expect(gate.evaluate(intent(ids), context({ optionRows: new Map([[INSTR, row({ oi: 0 })]]) })).reason).toBe('LIQUIDITY_FLOOR');
    expect(gate.evaluate(intent(ids, { stopPlan: undefined } as never), context()).reason).toBe('MISSING_STOP_PLAN');
    expect(gate.evaluate(intent(ids), context({ openPositions: [position()] })).reason).toBe('POSITION_LIMIT');
    expect(gate.evaluate(intent(ids), context({ throttleAvailable: 0 })).reason).toBe('THROTTLE_HEADROOM');
  });

  it('pins freeze-quantity scope: oversized orders are rejected, not silently split', () => {
    const ids = new IdFactory(SESSION);
    const gate = new RiskGate(market, risk);
    const oversized = intent(ids, { qty: market.contract.freezeQty + market.contract.lotSize });

    const verdict = gate.evaluate(oversized, context());

    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toBe('FREEZE_QTY');
  });

  it('property: approved entry risk never exceeds configured budget', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 50_000 }),
        fc.integer({ min: 1, max: 20 }),
        (entry, lots) => {
          const ids = new IdFactory(SESSION);
          const qty = lots * market.contract.lotSize;
          const hardStop = Math.max(1, entry - Math.floor((risk.capitalPaise * (risk.perTradeRiskPct / 100)) / qty));
          const next = intent(ids, {
            qty,
            limitPricePaise: entry,
            stopPlan: { hardStopPremiumPaise: hardStop, timeStopSec: 30 },
          });
          const verdict = new RiskGate(market, risk).evaluate(next, context({
            optionRows: new Map([[INSTR, row({ ltpPaise: entry, bidPaise: entry - 5, askPaise: entry + 5 })]]),
          }));
          if (verdict.approved) {
            expect(verdict.riskPaise ?? 0).toBeLessThanOrEqual(Math.round(risk.capitalPaise * (risk.perTradeRiskPct / 100)));
          }
        },
      ),
    );
  });
});

describe('SessionRiskState latches', () => {
  it('daily loss and loss streak latch until operator reset', () => {
    const state = new SessionRiskState(risk);
    state.recordTrade(-Math.round(risk.capitalPaise * 0.011));
    expect(state.current().latchedStop).toBe('DAILY_LOSS');
    state.recordTrade(999_999_999);
    expect(state.current().latchedStop).toBe('DAILY_LOSS');
    state.operatorReset();
    expect(state.current().latchedStop).toBeUndefined();

    const streak = new SessionRiskState(risk);
    streak.recordTrade(-1);
    streak.recordTrade(-1);
    streak.recordTrade(-1);
    expect(streak.current().latchedStop).toBe('LOSS_STREAK');
  });

  it('give-back and max-trades latch until operator reset', () => {
    const giveBack = new SessionRiskState(risk);
    giveBack.recordTrade(Math.round(risk.capitalPaise * 0.006)); // arms give-back at a meaningful peak
    expect(giveBack.current().latchedStop).toBeUndefined();
    giveBack.recordTrade(-Math.round(risk.capitalPaise * 0.0045));
    expect(giveBack.current().latchedStop).toBe('GIVE_BACK');
    giveBack.recordTrade(999_999_999);
    expect(giveBack.current().latchedStop).toBe('GIVE_BACK');
    giveBack.operatorReset();
    expect(giveBack.current().latchedStop).toBeUndefined();

    const maxTrades = new SessionRiskState({ ...risk, maxTradesPerDay: 2 });
    maxTrades.recordTrade(1);
    expect(maxTrades.current().latchedStop).toBeUndefined();
    maxTrades.recordTrade(1);
    expect(maxTrades.current().latchedStop).toBe('MAX_TRADES');
    maxTrades.operatorReset();
    expect(maxTrades.current().latchedStop).toBeUndefined();
  });
});

describe('StopEngine trigger matrix', () => {
  it('triggers L1 premium and creates protection-limit exit intent', () => {
    const ids = new IdFactory(SESSION);
    const engine = new StopEngine({ ids, tickSizePaise: 5, protectionTicks: 2 });
    const pos = position();
    engine.arm(pos, stopPlan());
    const decision = engine.update(pos, { nowMs: 2_000, premiumPaise: 8_900 });
    expect(decision?.trigger?.reason).toBe('L1_HARD_PREMIUM');
    expect(decision?.trigger?.exitIntent.side).toBe('SELL');
    expect(decision?.trigger?.exitIntent.limitPricePaise).toBe(8_890);
  });

  it.each([
    { right: 'CE', qty: 65, premiumPaise: 9_000, expectedLimit: 8_985, label: 'full normal' },
    { right: 'CE', qty: 30, premiumPaise: 8_100, expectedLimit: 8_085, label: 'partial gap-through' },
    { right: 'PE', qty: 65, premiumPaise: 9_000, expectedLimit: 8_985, label: 'full normal' },
    { right: 'PE', qty: 30, premiumPaise: 8_100, expectedLimit: 8_085, label: 'partial gap-through' },
  ] as const)('L1 premium matrix: $right $label exits current qty with protection limit', ({ qty, premiumPaise, expectedLimit }) => {
    const ids = new IdFactory(SESSION);
    const engine = new StopEngine({ ids, tickSizePaise: 5 });
    const pos = position({ qty });
    engine.arm(pos, stopPlan());

    const decision = engine.update(pos, { nowMs: 2_000, premiumPaise });

    expect(decision?.trigger?.reason).toBe('L1_HARD_PREMIUM');
    expect(decision?.trigger?.exitIntent.qty).toBe(qty);
    expect(decision?.trigger?.exitIntent.limitPricePaise).toBe(expectedLimit);
  });

  it.each([
    { right: 'CE', dir: 'BELOW', invalidSpot: 28_900_00 },
    { right: 'PE', dir: 'ABOVE', invalidSpot: 29_700_00 },
  ] as const)('L1 underlying matrix: $right invalidation fires before time stop', ({ dir, invalidSpot }) => {
    const ids = new IdFactory(SESSION);
    const engine = new StopEngine({ ids, tickSizePaise: 5 });
    const pos = position();
    engine.arm(pos, {
      ...stopPlan(),
      hardStopUnderlyingDir: dir,
      hardStopUnderlyingPaise: dir === 'BELOW' ? 29_000_00 : 29_600_00,
    });

    const decision = engine.update(pos, { nowMs: 2_000, premiumPaise: 10_100, underlyingPaise: invalidSpot });

    expect(decision?.trigger?.reason).toBe('L1_UNDERLYING');
    expect(decision?.trigger?.exitIntent.qty).toBe(pos.qty);
  });

  it.each(['DAILY_LOSS', 'GIVE_BACK', 'LOSS_STREAK'] as const)('L4 session stop matrix: %s exits immediately', (sessionStop) => {
    const ids = new IdFactory(SESSION);
    const engine = new StopEngine({ ids, tickSizePaise: 5 });
    const pos = position({ qty: 30 });
    engine.arm(pos, stopPlan());

    const decision = engine.update(pos, { nowMs: 2_000, premiumPaise: 10_100 }, sessionStop);

    expect(decision?.trigger?.reason).toBe('L4_SESSION');
    expect(decision?.trigger?.exitIntent.qty).toBe(30);
  });

  it('ATR-derived invalidation levels are directional for CE and PE stop plans', () => {
    const ce = buildLongOptionStopPlan({
      entryPremiumPaise: 10_000,
      tickSizePaise: 5,
      right: 'CE',
      pcts: { hardStopPremiumPct: 25, timeStopSec: 30 },
      invalidation: { kind: 'atr', spotPaise: 29_500_00, atrPaise: 12_500, mult: 2 },
    });
    const pe = buildLongOptionStopPlan({
      entryPremiumPaise: 10_000,
      tickSizePaise: 5,
      right: 'PE',
      pcts: { hardStopPremiumPct: 25, timeStopSec: 30 },
      invalidation: { kind: 'atr', spotPaise: 29_500_00, atrPaise: 12_500, mult: 2 },
    });

    expect(ce.hardStopUnderlyingDir).toBe('BELOW');
    expect(ce.hardStopUnderlyingPaise).toBe(29_250_00);
    expect(pe.hardStopUnderlyingDir).toBe('ABOVE');
    expect(pe.hardStopUnderlyingPaise).toBe(29_750_00);
  });

  it('triggers underlying invalidation, time stop, and session stop', () => {
    const ids = new IdFactory(SESSION);
    const pos = position();
    const engine = new StopEngine({ ids, tickSizePaise: 5 });
    engine.arm(pos, stopPlan());
    expect(engine.update(pos, { nowMs: 2_000, premiumPaise: 10_100, underlyingPaise: 28_900_00 })?.trigger?.reason).toBe('L1_UNDERLYING');

    const timeEngine = new StopEngine({ ids, tickSizePaise: 5 });
    timeEngine.arm(pos, stopPlan());
    expect(timeEngine.update(pos, { nowMs: 40_000, premiumPaise: 10_100 })?.trigger?.reason).toBe('L3_TIME');

    const sessionEngine = new StopEngine({ ids, tickSizePaise: 5 });
    sessionEngine.arm(pos, stopPlan());
    expect(sessionEngine.update(pos, { nowMs: 2_000, premiumPaise: 10_100 }, 'DAILY_LOSS')?.trigger?.reason).toBe('L4_SESSION');
  });

  it('ratchets to breakeven/trail and stop never widens', () => {
    const ids = new IdFactory(SESSION);
    const engine = new StopEngine({ ids, tickSizePaise: 5 });
    const pos = position();
    engine.arm(pos, stopPlan());
    const a = engine.update(pos, { nowMs: 2_000, premiumPaise: 10_600 });
    expect(a?.state.stopPremiumPaise).toBe(10_300);
    expect(a?.state.layer).toBe('TRAIL');
    const b = engine.update(pos, { nowMs: 3_000, premiumPaise: 10_200 });
    expect(b?.state.stopPremiumPaise).toBe(10_300);
    expect(b?.trigger?.reason).toBe('L2_TRAIL');
  });

  it('property: stop level is monotonic favorable-only', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 8_000, max: 14_000 }), { minLength: 1, maxLength: 100 }), (prices) => {
        const ids = new IdFactory(SESSION);
        const engine = new StopEngine({ ids, tickSizePaise: 5 });
        const pos = position();
        engine.arm(pos, stopPlan());
        let last = engine.get(pos.positionId)?.stopPremiumPaise ?? 0;
        for (let i = 0; i < prices.length; i++) {
          const decision = engine.update(pos, { nowMs: 2_000 + i, premiumPaise: prices[i] as number });
          const current = decision?.state.stopPremiumPaise ?? last;
          expect(current).toBeGreaterThanOrEqual(last);
          last = current;
        }
      }),
    );
  });

  it('deterministic nightmare replay produces pinned decision hash', () => {
    const ids = new IdFactory(SESSION);
    const engine = new StopEngine({ ids, tickSizePaise: 5 });
    const pos = position();
    engine.arm(pos, stopPlan());
    const decisions = [10_200, 10_700, 11_000, 10_600, 10_300, 9_500].map((premium, i) =>
      engine.update(pos, { nowMs: 2_000 + i * 1000, premiumPaise: premium }),
    );
    const summary = decisions.map((d) => ({
      stop: d?.state.stopPremiumPaise,
      layer: d?.state.layer,
      trigger: d?.trigger?.reason ?? 'NONE',
    }));
    expect(hashValue(summary)).toBe('de8d260e63e7283582be6828bb12402d5abcdbe6f797a6d06b08b6fa34e860f9');
  });
});
