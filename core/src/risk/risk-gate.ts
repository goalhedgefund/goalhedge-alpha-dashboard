import type { MarketProfile, RiskProfile } from '../config/schemas.js';
import type { InstrumentId } from '../domain/ids.js';
import type { OrderIntent } from '../domain/orders.js';
import type { Position } from '../domain/positions.js';
import type { RiskVerdict } from '../domain/risk.js';
import type { OptionChainRow } from '../domain/marketdata.js';
import type { SessionRiskSnapshot } from './session-risk.js';
import { computeCharges } from '../charges/engine.js';

export type RiskRejectReason =
  | 'SESSION_STOP_LATCHED'
  | 'MARKET_CLOSED'
  | 'INSTRUMENT_NOT_WHITELISTED'
  | 'NO_OPTION_QUOTE'
  | 'STRIKE_BAND'
  | 'SPREAD_GATE'
  | 'LIQUIDITY_FLOOR'
  | 'MISSING_STOP_PLAN'
  | 'INVALID_STOP_PLAN'
  | 'COST_GATE'
  | 'PER_TRADE_RISK'
  | 'POSITION_LIMIT'
  | 'MAX_LOTS_PER_ORDER'
  | 'FREEZE_QTY'
  | 'TRADE_COUNT'
  | 'THROTTLE_HEADROOM';

export interface RiskGateContext {
  nowMs: number;
  nowHHMM: string;
  allowedInstruments: ReadonlySet<InstrumentId>;
  optionRows: ReadonlyMap<InstrumentId, OptionChainRow>;
  atmStrikePaise?: number;
  strikeBand?: number;
  maxSpreadPct?: number;
  minOi?: number;
  minVolume?: number;
  openPositions: readonly Position[];
  session: SessionRiskSnapshot;
  throttleAvailable?: number;
}

/**
 * Pre-trade risk gate. Purpose-aware by design:
 *
 * - ENTRY intents run the full eligibility stack (session stops, entry
 *   cutoff, whitelist, strike band, spread, liquidity, stop-plan budget,
 *   position/trade limits, throttle headroom).
 * - Everything else (EXIT / STOP / SQUARE_OFF / KILL) is an exit: it must
 *   NEVER be trapped by entry eligibility. A latched daily-loss stop, a
 *   spread blowout, the entry cutoff, or an exhausted trade count all still
 *   allow flattening. Exits are bounded by the session close, not the entry
 *   cutoff, and only hard exchange sanity (lot integrity, freeze quantity)
 *   applies.
 */
export class RiskGate {
  constructor(
    private readonly market: MarketProfile,
    private readonly risk: RiskProfile,
  ) {}

  evaluate(intent: OrderIntent, ctx: RiskGateContext): RiskVerdict {
    const reject = (reason: RiskRejectReason, riskPaise?: number): RiskVerdict => ({
      intentId: intent.intentId,
      ts: ctx.nowMs,
      approved: false,
      reason,
      ...(riskPaise !== undefined ? { riskPaise } : {}),
    });

    // Universal exchange sanity — applies to every purpose.
    const lots = intent.qty / this.market.contract.lotSize;
    if (!Number.isInteger(lots) || lots <= 0) return reject('MAX_LOTS_PER_ORDER');
    if (intent.qty > this.market.contract.freezeQty) return reject('FREEZE_QTY');

    if (intent.purpose !== 'ENTRY') {
      // Exit lane: bounded by session close only.
      if (ctx.nowHHMM < this.market.session.open || ctx.nowHHMM > this.market.session.close) {
        return reject('MARKET_CLOSED');
      }
      return { intentId: intent.intentId, ts: ctx.nowMs, approved: true };
    }

    // ---- ENTRY lane ----
    if (ctx.session.latchedStop !== undefined) return reject('SESSION_STOP_LATCHED');
    if (ctx.nowHHMM < this.market.session.open || ctx.nowHHMM > this.market.entryCutoff) {
      return reject('MARKET_CLOSED');
    }
    if (!ctx.allowedInstruments.has(intent.instrumentId)) return reject('INSTRUMENT_NOT_WHITELISTED');

    // An ENTRY without a live quote row can never be priced or spread-checked —
    // a limit price alone must not bypass the quote gates.
    const row = ctx.optionRows.get(intent.instrumentId);
    if (row === undefined) return reject('NO_OPTION_QUOTE');

    if (ctx.atmStrikePaise !== undefined) {
      const band = ctx.strikeBand ?? 5;
      const steps = Math.abs(row.strikePaise - ctx.atmStrikePaise) / this.market.contract.strikeStepPaise;
      if (steps > band) return reject('STRIKE_BAND');
    }

    if (row.bidPaise > 0 && row.askPaise > 0) {
      const mid = (row.bidPaise + row.askPaise) / 2;
      const spreadPct = mid > 0 ? (row.askPaise - row.bidPaise) / mid : Infinity;
      if (spreadPct > (ctx.maxSpreadPct ?? 0.015)) return reject('SPREAD_GATE');
    } else {
      // One-sided or empty book is the worst spread there is — never let an
      // ENTRY through exactly when liquidity has vanished.
      return reject('SPREAD_GATE');
    }
    if (row.oi < (ctx.minOi ?? 0) || row.volume < (ctx.minVolume ?? 0)) return reject('LIQUIDITY_FLOOR');

    if (intent.stopPlan === undefined) return reject('MISSING_STOP_PLAN');
    const entry = intent.limitPricePaise ?? row.askPaise;
    const riskPaise = Math.max(0, entry - intent.stopPlan.hardStopPremiumPaise) * intent.qty;
    if (entry <= 0 || intent.stopPlan.hardStopPremiumPaise >= entry) return reject('INVALID_STOP_PLAN', riskPaise);
    if (!this.costGatePasses(intent, row, entry)) return reject('COST_GATE', riskPaise);
    const budget = Math.round(this.risk.capitalPaise * (this.risk.perTradeRiskPct / 100));
    if (riskPaise > budget) return reject('PER_TRADE_RISK', riskPaise);

    const openCount = ctx.openPositions.filter((p) => p.state !== 'CLOSED' && p.qty > 0).length;
    if (openCount >= this.risk.maxConcurrentPositions) return reject('POSITION_LIMIT');
    if (lots > this.risk.maxLotsPerOrder) return reject('MAX_LOTS_PER_ORDER');
    if (ctx.session.tradesTaken >= this.risk.maxTradesPerDay) return reject('TRADE_COUNT');
    if ((ctx.throttleAvailable ?? 1) < 1) return reject('THROTTLE_HEADROOM');

    return {
      intentId: intent.intentId,
      ts: ctx.nowMs,
      approved: true,
      riskPaise,
    };
  }

  private costGatePasses(intent: OrderIntent, row: OptionChainRow, entryPaise: number): boolean {
    const cfg = this.risk.costGate;
    if (cfg === undefined || !cfg.enabled) return true;

    const expectedMovePaise = Math.round(entryPaise * (cfg.minExpectedMovePct / 100));
    if (expectedMovePaise <= 0) return false;
    const expectedExitPaise = entryPaise + expectedMovePaise;
    const charges = computeCharges(
      [
        { side: 'BUY', qty: intent.qty, pricePaise: entryPaise },
        { side: 'SELL', qty: intent.qty, pricePaise: expectedExitPaise },
      ],
      this.market,
    ).totalPaise;
    const spreadPaise = row.askPaise > 0 && row.bidPaise > 0 ? row.askPaise - row.bidPaise : entryPaise;
    const slippagePaise = cfg.slippageTicks * this.market.tickSizePaise * 2;
    const frictionPaise = charges + Math.max(0, spreadPaise + slippagePaise) * intent.qty;
    if (frictionPaise <= 0) return true;
    const expectedGrossPaise = expectedMovePaise * intent.qty;
    return expectedGrossPaise >= frictionPaise * cfg.minRewardToCost;
  }
}
