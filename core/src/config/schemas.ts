import { z } from 'zod';

/** 'HH:MM' 24-hour exchange-local wall time. */
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, 'expected HH:MM (24h)');

/**
 * One statutory/broker charge line. Exactly one of `rate` (decimal fraction
 * of premium turnover) or `flatPaise` (per order) must be present.
 */
export const ChargeComponentSchema = z
  .object({
    name: z.string().min(1),
    basis: z.enum(['buy_premium', 'sell_premium', 'both_premium', 'per_order']),
    rate: z.number().min(0).max(1).optional(),
    flatPaise: z.number().int().min(0).optional(),
    gstApplicable: z.boolean(),
    verifyAtGoLive: z.boolean().default(false),
  })
  .refine((c) => (c.rate !== undefined) !== (c.flatPaise !== undefined), {
    message: 'exactly one of rate or flatPaise must be set',
  });

export const MarketProfileSchema = z.object({
  profileId: z.string().min(1),
  version: z.number().int().min(1),
  /** ISO date the exchange facts / charge rates were last confirmed. */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  exchange: z.string().min(1),
  segment: z.string().min(1),
  currency: z.string().length(3),
  timezone: z.string().min(1),
  session: z.object({ open: hhmm, close: hhmm }),
  entryCutoff: hhmm,
  hardSquareOff: hhmm,
  tickSizePaise: z.number().int().positive(),
  contract: z.object({
    underlying: z.string().min(1),
    lotSize: z.number().int().positive(),
    freezeQty: z.number().int().positive(),
    weeklyExpiryDay: z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI']),
    strikeStepPaise: z.number().int().positive(),
  }),
  charges: z.object({
    gstRate: z.number().min(0).max(1),
    components: z.array(ChargeComponentSchema).min(1),
  }),
});

export const RiskProfileSchema = z.object({
  profileId: z.string().min(1),
  version: z.number().int().min(1),
  mode: z.enum(['paper', 'live']),
  capitalPaise: z.number().int().positive(),
  /** Max rupee risk per trade as % of capital, enforced against the stopPlan. */
  perTradeRiskPct: z.number().positive().max(5),
  dailyMaxLossPct: z.number().positive().max(10),
  giveBack: z.object({
    /** Give-back stop arms once day P&L peak exceeds this % of capital. */
    armAtPct: z.number().positive(),
    /** % of the day's peak P&L that must be retained once armed. */
    retainPct: z.number().min(0).max(100),
  }),
  lossStreak: z.object({
    count: z.number().int().min(1),
    cooldownMin: z.number().int().min(1),
  }),
  maxTradesPerDay: z.number().int().min(1),
  maxConcurrentPositions: z.number().int().min(1),
  maxLotsPerOrder: z.number().int().min(1),
});

export const StrategyConfigSchema = z.object({
  strategyId: z.string().min(1),
  version: z.string().min(1),
  enabled: z.boolean(),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])),
});

export type ChargeComponent = z.output<typeof ChargeComponentSchema>;
export type MarketProfile = z.output<typeof MarketProfileSchema>;
export type RiskProfile = z.output<typeof RiskProfileSchema>;
export type StrategyConfig = z.output<typeof StrategyConfigSchema>;
