import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema } from '../src/config/schemas.js';
import { IdFactory, makeSessionId } from '../src/domain/ids.js';
import type { Bar, Tick } from '../src/domain/marketdata.js';
import type { OrderIntent } from '../src/domain/orders.js';
import { computeUnderlyingFeatures } from '../src/marketdata/features/library.js';
import { RiskGate, type RiskGateContext } from '../src/risk/risk-gate.js';
import { SessionRiskState } from '../src/risk/session-risk.js';
import { buildLongOptionStopPlan } from '../src/strategy/stop-plan.js';
import { S1MomentumBurst } from '../src/strategy/strategies/s1-momentum-burst.js';
import type { StrategyView } from '../src/strategy/types.js';
import { LatencySampler } from '../src/telemetry/latency.js';
import { CE_ID, PE_ID, ATM_STRIKE, mkRow } from './helpers/strategy-fixtures.js';

/**
 * Latency benchmark (01-DESIGN §7, 03-TESTING-PLAN §6). Budget: internal
 * tick-in → order-out p99 < 5 ms, measured on a high-rate synthetic burst
 * through the REAL feature/decide/gate pipeline, with per-hop assertions so a
 * regression names the hop that slowed.
 *
 * Unlike production (the gate runs only when a signal fires), the benchmark
 * exercises the FULL recv→sent path on every tick — that is the worst-case
 * "produces an order" latency we commit to, which is what the budget gates.
 */

const configUrl = (rel: string): string => fileURLToPath(new URL(`../../config/${rel}`, import.meta.url));

const BUDGET_MS = 5;
const N = 20_000; // measured samples (p99 has ≥200 tail samples)
const WARMUP = 1_000; // unrecorded — drops JIT warmup out of the percentiles
const RING = 200; // spot ticks retained (matches the live view provider)

function makeBars(count: number, base: number): Bar[] {
  const bars: Bar[] = [];
  let p = base;
  for (let i = 0; i < count; i++) {
    const o = p;
    const c = o + ((i % 7) - 3) * 200; // deterministic zigzag → indicators compute
    bars.push({
      instrumentId: CE_ID,
      tf: '1m',
      startTs: i * 60_000,
      o,
      h: Math.max(o, c) + 300,
      l: Math.min(o, c) - 300,
      c,
      volume: 6_000,
      tickCount: 60,
    });
    p = c;
  }
  return bars;
}

describe('latency benchmark — internal tick→order p99 < 5ms (01-DESIGN §7)', () => {
  it(
    'sustains ≥5k ticks/s with per-hop budget headroom',
    () => {
      const market = loadConfig(MarketProfileSchema, configUrl('market/india-nse-options.json')).value;
      const riskProfile = loadConfig(RiskProfileSchema, configUrl('risk/paper-default.json')).value;

      const gate = new RiskGate(market, riskProfile);
      const strategy = new S1MomentumBurst();
      const sampler = new LatencySampler({ capacity: N }); // real performance.now() clock
      const ids = new IdFactory(makeSessionId('2026-07-04', 'paper'));
      const sessionId = makeSessionId('2026-07-04', 'paper');
      const bars = makeBars(40, ATM_STRIKE); // ≥30 → codex 8-indicator math runs
      const ceRow = mkRow(CE_ID, 'CE');
      const peRow = mkRow(PE_ID, 'PE');

      // Rolling window of real ticks the feature library reduces over.
      const ticks: Tick[] = [];
      for (let i = 0; i < RING; i++) {
        ticks.push({
          instrumentId: CE_ID,
          ts: i * 250,
          recvTs: i * 250,
          ltpPaise: ATM_STRIKE + (i % 11) * 50,
          qty: 75,
          volume: 75 * (i + 1),
          bidPaise: ATM_STRIKE - 500,
          askPaise: ATM_STRIKE + 500,
          bidQty: 100,
          askQty: 100,
        });
      }

      const ctx: RiskGateContext = {
        nowMs: 0,
        nowHHMM: '10:00',
        allowedInstruments: new Set([CE_ID, PE_ID]),
        optionRows: new Map([
          [CE_ID, ceRow],
          [PE_ID, peRow],
        ]),
        atmStrikePaise: ATM_STRIKE,
        strikeBand: 5,
        maxSpreadPct: 0.015,
        minOi: 100,
        minVolume: 100,
        openPositions: [],
        session: new SessionRiskState(riskProfile).current(),
        throttleAvailable: 1,
      };

      const stopPlan = buildLongOptionStopPlan({
        entryPremiumPaise: 15_000,
        tickSizePaise: market.tickSizePaise,
        right: 'CE',
        pcts: { hardStopPremiumPct: 25, breakevenAtPct: 12, trailStepPct: 8, trailLockPct: 50, timeStopSec: 90 },
      });

      let nextTs = RING * 250;
      const runOnce = (record: boolean): void => {
        // Advance the ring by one tick (append + evict) so features recompute.
        ticks.push({
          instrumentId: CE_ID,
          ts: nextTs,
          recvTs: nextTs,
          ltpPaise: ATM_STRIKE + (nextTs % 13) * 40,
          qty: 75,
          volume: 75 * (nextTs / 250 + 1),
          bidPaise: ATM_STRIKE - 500,
          askPaise: ATM_STRIKE + 500,
          bidQty: 100,
          askQty: 100,
        });
        if (ticks.length > RING) ticks.shift();
        nextTs += 250;

        if (record) sampler.begin();
        const view: StrategyView = {
          nowMs: nextTs,
          spotPaise: ticks[ticks.length - 1]!.ltpPaise,
          underlyingFeatures: computeUnderlyingFeatures(ticks, bars),
          atmStrikePaise: ATM_STRIKE,
          atmOption: (right) => (right === 'CE' ? { instrumentId: CE_ID, row: ceRow } : { instrumentId: PE_ID, row: peRow }),
          params: { impulsePct: 0.0008, confirmTicks: 2, lots: 1, ttlMs: 1500, tickSizePaise: 5, timeStopSec: 90, hardStopPremiumPct: 25 },
        };
        if (record) sampler.mark('features');

        strategy.decide(view);
        if (record) sampler.mark('signal');

        const intent: OrderIntent = {
          intentId: ids.intentId(),
          sessionId,
          strategyId: strategy.id,
          ts: nextTs,
          side: 'BUY',
          instrumentId: CE_ID,
          qty: market.contract.lotSize,
          type: 'LIMIT',
          limitPricePaise: 15_000,
          ttlMs: 1500,
          tag: 'bench:entry',
          purpose: 'ENTRY',
          stopPlan,
        };
        gate.evaluate(intent, ctx);
        if (record) {
          sampler.mark('risk');
          sampler.mark('sent'); // decision handed to OMS (broker RTT excluded by design)
          sampler.end();
        }
      };

      for (let i = 0; i < WARMUP; i++) runOnce(false);
      const startNs = process.hrtime.bigint();
      for (let i = 0; i < N; i++) runOnce(true);
      const elapsedSec = Number(process.hrtime.bigint() - startNs) / 1e9;

      const snap = sampler.snapshot();
      const throughput = N / elapsedSec;

      console.log(
        `[latency-bench] n=${snap.total.count} p50=${snap.total.p50Ms.toFixed(4)}ms ` +
          `p99=${snap.total.p99Ms.toFixed(4)}ms max=${snap.total.maxMs.toFixed(4)}ms ` +
          `throughput=${Math.round(throughput)}/s | hops p99(ms) ` +
          `features=${snap.hops.features.p99Ms.toFixed(4)} signal=${snap.hops.signal.p99Ms.toFixed(4)} ` +
          `risk=${snap.hops.risk.p99Ms.toFixed(4)} sent=${snap.hops.sent.p99Ms.toFixed(4)}`,
      );

      // Every measured tick reached 'sent' (full path).
      expect(snap.total.count).toBe(N);
      // The budget: internal tick→order p99 < 5 ms.
      expect(snap.total.p99Ms).toBeLessThan(BUDGET_MS);
      // Per-hop assertions — a regression in any single hop trips and names it.
      expect(snap.hops.features.p99Ms).toBeLessThan(BUDGET_MS);
      expect(snap.hops.signal.p99Ms).toBeLessThan(BUDGET_MS);
      expect(snap.hops.risk.p99Ms).toBeLessThan(BUDGET_MS);
      expect(snap.hops.sent.p99Ms).toBeLessThan(BUDGET_MS);
      // Sustains well beyond the §6 5k ticks/s floor.
      expect(throughput).toBeGreaterThan(5_000);
    },
    30_000,
  );
});
