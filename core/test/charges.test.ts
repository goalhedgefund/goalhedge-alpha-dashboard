/**
 * Charges engine tests — M2 acceptance.
 *
 * Hand-computation reference (india-nse-options profile, all paise):
 *
 *   Component     Basis         Rate / flat   GST?
 *   stt           sell_premium  0.001         no
 *   exchange_txn  both_premium  0.0003503     yes
 *   sebi_fee      both_premium  0.000001      yes    (₹10/crore applied to paise turnover)
 *   stamp_duty    buy_premium   0.00003       no
 *   ipft          both_premium  0.000005      yes
 *   brokerage     per_order     0p flat       yes
 *   gst           —             18% on above  —
 *
 * Rate semantics: rate × turnover_paise → charge_paise (Math.round each).
 * GST: Math.round(gst_base × 0.18), where gst_base = sum of gstApplicable pre-GST charges.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import fc from 'fast-check';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema } from '../src/config/schemas.js';
import { aggregateCharges, computeCharges, computeTradeNet } from '../src/charges/engine.js';

const configDir = fileURLToPath(new URL('../../config/', import.meta.url));
const profile = loadConfig(
  MarketProfileSchema,
  join(configDir, 'market/india-nse-options.json'),
).value;

// ---------------------------------------------------------------------------
// Helper to extract a named component.
// ---------------------------------------------------------------------------
function component(name: string, breakdown: ReturnType<typeof computeCharges>): number {
  return breakdown.components.find((c) => c.name === name)?.paise ?? -1;
}

// ---------------------------------------------------------------------------
// Example 1 — 1 lot (75 units) long CE, winner
//
// Buy  : 75 × 12000p = 900 000p
// Sell : 75 × 15000p = 1 125 000p
// Both :              2 025 000p
//
// stt          : round(1 125 000 × 0.001)     = round(1 125)    = 1 125p
// exchange_txn : round(2 025 000 × 0.0003503) = round(709.3575) = 709p
// sebi_fee     : round(2 025 000 × 0.000001)  = round(2.025)    = 2p
// stamp_duty   : round(  900 000 × 0.00003)   = round(27)       = 27p
// ipft         : round(2 025 000 × 0.000005)  = round(10.125)   = 10p
// brokerage    : 0 × 2 fills                                     = 0p
// gst_base     : 709 + 2 + 10 + 0                                = 721p
// gst          : round(721 × 0.18)            = round(129.78)   = 130p
// total        : 1 125 + 709 + 2 + 27 + 10 + 0 + 130           = 2 003p
// gross        : (15 000 − 12 000) × 75 = 225 000p
// net          : 225 000 − 2 003 = 222 997p
// ---------------------------------------------------------------------------

describe('example 1 — 1 lot CE long winner', () => {
  const fills = [
    { side: 'BUY' as const, qty: 75, pricePaise: 12000 },
    { side: 'SELL' as const, qty: 75, pricePaise: 15000 },
  ];
  const bd = computeCharges(fills, profile);

  it('stt = 1125p', () => expect(component('stt', bd)).toBe(1125));
  it('exchange_txn = 709p', () => expect(component('exchange_txn', bd)).toBe(709));
  it('sebi_fee = 2p', () => expect(component('sebi_fee', bd)).toBe(2));
  it('stamp_duty = 27p', () => expect(component('stamp_duty', bd)).toBe(27));
  it('ipft = 10p', () => expect(component('ipft', bd)).toBe(10));
  it('brokerage = 0p (mandate)', () => expect(component('brokerage', bd)).toBe(0));
  it('gst = 130p', () => expect(component('gst', bd)).toBe(130));
  it('total = 2003p', () => expect(bd.totalPaise).toBe(2003));
  it('net P&L = 222 997p', () => {
    const gross = (15000 - 12000) * 75;
    expect(computeTradeNet(gross, bd)).toBe(222_997);
  });
});

// ---------------------------------------------------------------------------
// Example 2 — 1 lot CE long loser
//
// Buy  : 75 × 12000p = 900 000p
// Sell : 75 ×  8000p = 600 000p
// Both :            1 500 000p
//
// stt          : round(600 000 × 0.001)     = 600p
// exchange_txn : round(1 500 000 × 0.0003503) = round(525.45) = 525p
// sebi_fee     : round(1 500 000 × 0.000001) = round(1.5) = 2p  (Math.round ties → 2)
// stamp_duty   : round(900 000 × 0.00003)   = 27p
// ipft         : round(1 500 000 × 0.000005) = round(7.5) = 8p  (Math.round ties → 8)
// brokerage    : 0p
// gst_base     : 525 + 2 + 8 + 0 = 535p
// gst          : round(535 × 0.18) = round(96.3) = 96p
// total        : 600 + 525 + 2 + 27 + 8 + 0 + 96 = 1 258p
// gross        : (8 000 − 12 000) × 75 = −300 000p
// net          : −300 000 − 1 258 = −301 258p
// ---------------------------------------------------------------------------

describe('example 2 — 1 lot CE long loser', () => {
  const fills = [
    { side: 'BUY' as const, qty: 75, pricePaise: 12000 },
    { side: 'SELL' as const, qty: 75, pricePaise: 8000 },
  ];
  const bd = computeCharges(fills, profile);

  it('stt = 600p (on lower sell premium)', () => expect(component('stt', bd)).toBe(600));
  it('total = 1258p', () => expect(bd.totalPaise).toBe(1258));
  it('net = −301 258p (loss + charges)', () => {
    const gross = (8000 - 12000) * 75;
    expect(computeTradeNet(gross, bd)).toBe(-301_258);
  });
});

// ---------------------------------------------------------------------------
// Example 3 — 2 lots (150 units) PE long winner
//
// Buy  : 150 × 20000p = 3 000 000p
// Sell : 150 × 28000p = 4 200 000p
// Both :               7 200 000p
//
// stt          : round(4 200 000 × 0.001)       = 4 200p
// exchange_txn : round(7 200 000 × 0.0003503)   = round(2 522.16) = 2 522p
// sebi_fee     : round(7 200 000 × 0.000001)    = round(7.2) = 7p
// stamp_duty   : round(3 000 000 × 0.00003)     = 90p
// ipft         : round(7 200 000 × 0.000005)    = 36p
// brokerage    : 0p
// gst_base     : 2 522 + 7 + 36 + 0 = 2 565p
// gst          : round(2 565 × 0.18) = round(461.7) = 462p
// total        : 4 200 + 2 522 + 7 + 90 + 36 + 0 + 462 = 7 317p
// gross        : (28 000 − 20 000) × 150 = 1 200 000p
// net          : 1 200 000 − 7 317 = 1 192 683p
// ---------------------------------------------------------------------------

describe('example 3 — 2 lots PE long winner (lot-size scaling)', () => {
  const fills = [
    { side: 'BUY' as const, qty: 150, pricePaise: 20000 },
    { side: 'SELL' as const, qty: 150, pricePaise: 28000 },
  ];
  const bd = computeCharges(fills, profile);

  it('stt = 4200p', () => expect(component('stt', bd)).toBe(4200));
  it('total = 7317p', () => expect(bd.totalPaise).toBe(7317));
  it('net = 1 192 683p', () => {
    expect(computeTradeNet((28000 - 20000) * 150, bd)).toBe(1_192_683);
  });
});

// ---------------------------------------------------------------------------
// Example 4 — small premium, near-zero charges round correctly
//
// Buy  : 75 × 500p  = 37 500p
// Sell : 75 × 500p  = 37 500p
// Both :              75 000p
//
// stt          : round(37 500 × 0.001)   = round(37.5) = 38p
// exchange_txn : round(75 000 × 0.0003503) = round(26.2725) = 26p
// sebi_fee     : round(75 000 × 0.000001) = round(0.075) = 0p
// stamp_duty   : round(37 500 × 0.00003) = round(1.125) = 1p
// ipft         : round(75 000 × 0.000005) = round(0.375) = 0p
// brokerage    : 0p
// gst_base     : 26 + 0 + 0 + 0 = 26p
// gst          : round(26 × 0.18) = round(4.68) = 5p
// total        : 38 + 26 + 0 + 1 + 0 + 0 + 5 = 70p
// gross        : 0
// net          : −70p
// ---------------------------------------------------------------------------

describe('example 4 — small premium (₹5) break-even, charges dominate', () => {
  const fills = [
    { side: 'BUY' as const, qty: 75, pricePaise: 500 },
    { side: 'SELL' as const, qty: 75, pricePaise: 500 },
  ];
  const bd = computeCharges(fills, profile);

  it('stt = 38p', () => expect(component('stt', bd)).toBe(38));
  it('sebi_fee = 0p (rounds down at tiny size)', () => expect(component('sebi_fee', bd)).toBe(0));
  it('ipft = 0p (rounds down at tiny size)', () => expect(component('ipft', bd)).toBe(0));
  it('total = 70p', () => expect(bd.totalPaise).toBe(70));
  it('break-even trade nets to −70p (charges are real even at zero gross)', () => {
    expect(computeTradeNet(0, bd)).toBe(-70);
  });
});

// ---------------------------------------------------------------------------
// Example 5 — partial fill: two entry fills at different prices, one exit fill
//
// Entry fills: BUY 75 @ 12000p + BUY 75 @ 12100p (total 150 units entered)
// Exit fill  : SELL 150 @ 14000p
//
// Buy turnover  : 75×12000 + 75×12100 = 900 000 + 907 500 = 1 807 500p
// Sell turnover : 150×14000 = 2 100 000p
// Both          : 3 907 500p
//
// stt          : round(2 100 000 × 0.001) = 2 100p
// exchange_txn : round(3 907 500 × 0.0003503) = round(1 368.7972…) = 1 369p
// sebi_fee     : round(3 907 500 × 0.000001)  = round(3.9075) = 4p
// stamp_duty   : round(1 807 500 × 0.00003)   = round(54.225) = 54p
// ipft         : round(3 907 500 × 0.000005)  = round(19.5375) = 20p
// brokerage    : 0 × 3 fills = 0p
// gst_base     : 1 369 + 4 + 20 + 0 = 1 393p
// gst          : round(1 393 × 0.18) = round(250.74) = 251p
// total        : 2 100 + 1 369 + 4 + 54 + 20 + 0 + 251 = 3 798p
//
// blended entry : 1 807 500 / 150 = 12 050p/unit
// gross         : (14 000 − 12 050) × 150 = 1 950 × 150 = 292 500p
// net           : 292 500 − 3 798 = 288 702p
// ---------------------------------------------------------------------------

describe('example 5 — partial fill (two entry tranches, blended price)', () => {
  const fills = [
    { side: 'BUY' as const, qty: 75, pricePaise: 12000 },
    { side: 'BUY' as const, qty: 75, pricePaise: 12100 },
    { side: 'SELL' as const, qty: 150, pricePaise: 14000 },
  ];
  const bd = computeCharges(fills, profile);

  it('stt = 2100p (on sell only)', () => expect(component('stt', bd)).toBe(2100));
  it('stamp_duty = 54p (on blended buy turnover)', () => expect(component('stamp_duty', bd)).toBe(54));
  it('exchange_txn = 1369p', () => expect(component('exchange_txn', bd)).toBe(1369));
  it('gst = 251p', () => expect(component('gst', bd)).toBe(251));
  it('total = 3798p', () => expect(bd.totalPaise).toBe(3798));
  it('net = 288 702p', () => {
    const blendedEntry = (75 * 12000 + 75 * 12100) / 150;   // = 12050 exactly
    const gross = (14000 - blendedEntry) * 150;               // = 292500
    expect(computeTradeNet(gross, bd)).toBe(288_702);
  });
});

// ---------------------------------------------------------------------------
// Example 6 — zero brokerage verified across all fill counts
// The mandate is brokerage = 0 regardless of how many fills.
// ---------------------------------------------------------------------------

describe('example 6 — zero brokerage mandate (any fill count)', () => {
  it('brokerage = 0 for 1 fill', () => {
    const bd = computeCharges(
      [{ side: 'BUY' as const, qty: 75, pricePaise: 10000 }],
      profile,
    );
    expect(component('brokerage', bd)).toBe(0);
  });

  it('brokerage = 0 for 10 fills', () => {
    const fills = Array.from({ length: 10 }, () => ({
      side: 'BUY' as const,
      qty: 75,
      pricePaise: 10000,
    }));
    const bd = computeCharges(fills, profile);
    expect(component('brokerage', bd)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Example 7 — generic second market profile
// A minimal synthetic profile with only two components; verifies the engine
// is driven by config, not hardcoded to India.
// ---------------------------------------------------------------------------

describe('example 7 — generic second market profile (proves config-driven)', () => {
  const syntheticProfile = {
    profileId: 'test-exchange-options',
    version: 1,
    asOf: '2026-01-01',
    exchange: 'TEST',
    segment: 'OPTIONS',
    currency: 'USD',
    timezone: 'America/New_York',
    session: { open: '09:30', close: '16:00' },
    entryCutoff: '15:45',
    hardSquareOff: '15:50',
    tickSizePaise: 1,
    contract: {
      underlying: 'SPX',
      lotSize: 100,
      freezeQty: 1000,
      weeklyExpiryDay: 'FRI' as const,
      strikeStepPaise: 50000,
    },
    charges: {
      gstRate: 0,
      components: [
        {
          name: 'sec_fee',
          basis: 'sell_premium' as const,
          rate: 0.0002,
          gstApplicable: false,
          verifyAtGoLive: false,
        },
        {
          name: 'orf',
          basis: 'both_premium' as const,
          rate: 0.00004,
          gstApplicable: false,
          verifyAtGoLive: false,
        },
      ],
    },
  };

  it('applies only the components in the profile, GST = 0 when rate is 0', () => {
    // BUY 100 @ 5000p, SELL 100 @ 6000p
    // sell_turnover = 600 000p, both = 1 100 000p
    // sec_fee = round(600 000 × 0.0002) = 120p
    // orf     = round(1 100 000 × 0.00004) = 44p
    // gst     = round(0 × 0.00) = 0p
    // total   = 164p
    const bd = computeCharges(
      [
        { side: 'BUY' as const, qty: 100, pricePaise: 5000 },
        { side: 'SELL' as const, qty: 100, pricePaise: 6000 },
      ],
      syntheticProfile,
    );
    expect(component('sec_fee', bd)).toBe(120);
    expect(component('orf', bd)).toBe(44);
    expect(component('gst', bd)).toBe(0);
    expect(bd.totalPaise).toBe(164);
  });
});

// ---------------------------------------------------------------------------
// aggregateCharges
// ---------------------------------------------------------------------------

describe('aggregateCharges', () => {
  it('sums component paise across trades', () => {
    const a = computeCharges(
      [
        { side: 'BUY' as const, qty: 75, pricePaise: 12000 },
        { side: 'SELL' as const, qty: 75, pricePaise: 15000 },
      ],
      profile,
    );
    const b = computeCharges(
      [
        { side: 'BUY' as const, qty: 75, pricePaise: 10000 },
        { side: 'SELL' as const, qty: 75, pricePaise: 9000 },
      ],
      profile,
    );
    const agg = aggregateCharges([a, b]);
    expect(agg.totalPaise).toBe(a.totalPaise + b.totalPaise);
    const sttAgg = agg.components.find((c) => c.name === 'stt')?.paise ?? -1;
    const sttA = component('stt', a);
    const sttB = component('stt', b);
    expect(sttAgg).toBe(sttA + sttB);
  });

  it('returns zero breakdown for empty input', () => {
    const agg = aggregateCharges([]);
    expect(agg.totalPaise).toBe(0);
    expect(agg.components).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('property tests — money conservation', () => {
  it('total === sum of all component paise (no rounding drift over 10k trades)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            side: fc.constantFrom('BUY' as const, 'SELL' as const),
            qty: fc.integer({ min: 75, max: 1800 }).filter((n) => n % 75 === 0),
            pricePaise: fc.integer({ min: 1, max: 100_000 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (fills) => {
          const bd = computeCharges(fills, profile);
          const componentSum = bd.components.reduce((s, c) => s + c.paise, 0);
          expect(bd.totalPaise).toBe(componentSum);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('net === gross − total (integer identity, no float drift)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_000, max: 10_000_000 }),
        fc.array(
          fc.record({
            side: fc.constantFrom('BUY' as const, 'SELL' as const),
            qty: fc.integer({ min: 75, max: 1800 }).filter((n) => n % 75 === 0),
            pricePaise: fc.integer({ min: 1, max: 100_000 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (grossPaise, fills) => {
          const bd = computeCharges(fills, profile);
          expect(computeTradeNet(grossPaise, bd)).toBe(grossPaise - bd.totalPaise);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('all component paise are non-negative integers', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            side: fc.constantFrom('BUY' as const, 'SELL' as const),
            qty: fc.integer({ min: 1, max: 10000 }),
            pricePaise: fc.integer({ min: 0, max: 500_000 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        (fills) => {
          const bd = computeCharges(fills, profile);
          for (const c of bd.components) {
            expect(c.paise).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(c.paise)).toBe(true);
          }
          expect(bd.totalPaise).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 5_000 },
    );
  });

  it('charges are monotonically non-decreasing in turnover (larger trade ≥ charges of sub-trade)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 75, max: 750 }).filter((n) => n % 75 === 0),
        fc.integer({ min: 1000, max: 50_000 }),
        fc.integer({ min: 1000, max: 50_000 }),
        (qty, buyPrice, sellPrice) => {
          const small = computeCharges(
            [
              { side: 'BUY' as const, qty, pricePaise: buyPrice },
              { side: 'SELL' as const, qty, pricePaise: sellPrice },
            ],
            profile,
          );
          const double = computeCharges(
            [
              { side: 'BUY' as const, qty: qty * 2, pricePaise: buyPrice },
              { side: 'SELL' as const, qty: qty * 2, pricePaise: sellPrice },
            ],
            profile,
          );
          expect(double.totalPaise).toBeGreaterThanOrEqual(small.totalPaise);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
