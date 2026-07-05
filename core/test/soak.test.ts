import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, type MarketProfile, type RiskProfile } from '../src/config/schemas.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId, type SessionId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { FeedMarketData } from '../src/host/feed-market-data.js';
import { PaperHost } from '../src/host/paper-host.js';
import { runSoak, type SoakSessionSpec } from '../src/soak/soak-runner.js';
import { S1MomentumBurst } from '../src/strategy/strategies/s1-momentum-burst.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(MarketProfileSchema, fileURLToPath(new URL('market/india-nse-options.json', configDir))).value;
const riskProfile: RiskProfile = loadConfig(RiskProfileSchema, fileURLToPath(new URL('risk/paper-default.json', configDir))).value;

const DATE = '2026-07-03';
const SESSION: SessionId = makeSessionId(DATE, 'paper');
const SPOT_ID: InstrumentId = makeInstrumentId('NSE', 'SPOT');
const CE_ID: InstrumentId = makeInstrumentId('NSE', 'CE1');
const PE_ID: InstrumentId = makeInstrumentId('NSE', 'PE1');
const ATM = 2_450_000;
const START_10AM_IST = Date.UTC(2026, 6, 3, 4, 30, 0); // 10:00 IST

const S1_PARAMS = {
  impulsePct: 0.0008, confirmTicks: 2, lots: 1, ttlMs: 1500, tickSizePaise: 5,
  timeStopSec: 90, hardStopPremiumPct: 25, breakevenAtPct: 12, trailStepPct: 8, trailLockPct: 50,
};

function spotTick(ts: number, ltpPaise: number): Tick {
  return { instrumentId: SPOT_ID, ts, recvTs: ts, ltpPaise, qty: 100, volume: 100 + ts, bidPaise: ltpPaise - 5, askPaise: ltpPaise + 5, bidQty: 100, askQty: 100 };
}
function optTick(id: InstrumentId, ts: number, bid: number, ask: number, ltp: number): Tick {
  return { instrumentId: id, ts, recvTs: ts, ltpPaise: ltp, qty: 50, volume: 100_000, oi: 500_000, bidPaise: bid, askPaise: ask, bidQty: 650, askQty: 650 };
}

/** A full one-trade session as a pure tick stream (fills self-quote via the host). */
function sessionTicks(): Tick[] {
  const ticks: Tick[] = [];
  let t = START_10AM_IST;
  const step = (): number => (t += 1000);
  // Warmup option quotes (set paper touch + chain rows).
  ticks.push(optTick(CE_ID, step(), 14_990, 15_000, 15_000));
  ticks.push(optTick(PE_ID, step(), 14_990, 15_000, 15_000));
  let s = ATM;
  for (let i = 0; i < 10; i++) ticks.push(spotTick(step(), s)); // warmup spots
  s += 2_500; ticks.push(spotTick(step(), s)); // CONFIRMING
  s += 2_500; ticks.push(spotTick(step(), s)); // ENTRY → fill @ ask 15000
  ticks.push(optTick(CE_ID, step(), 15_590, 15_610, 15_600));
  ticks.push(optTick(CE_ID, step(), 16_790, 16_810, 16_800)); // breakeven + trail
  ticks.push(optTick(CE_ID, step(), 17_990, 18_010, 18_000)); // trail → 16500
  ticks.push(optTick(CE_ID, step(), 16_390, 16_410, 16_400)); // ≤16500 → exit @ bid 16390
  for (let i = 0; i < 6; i++) ticks.push(spotTick(step(), s)); // cooldown
  return ticks;
}

function makeSpec(id: string): SoakSessionSpec {
  return {
    id,
    build: async () => {
      const dir = mkdtempSync(join(tmpdir(), `soak-${id}-`));
      const clock = new ManualClock(START_10AM_IST);
      const marketData = new FeedMarketData({
        spotInstrumentId: SPOT_ID,
        options: [
          { instrumentId: CE_ID, strikePaise: ATM, right: 'CE', expiry: '2026-07-07' },
          { instrumentId: PE_ID, strikePaise: ATM, right: 'PE', expiry: '2026-07-07' },
        ],
        strikeStepPaise: market.contract.strikeStepPaise,
      });
      const paper = new PaperBroker({ clock });
      // Prime marketData with a spot so preflight feed.fresh passes.
      marketData.ingest(spotTick(START_10AM_IST, ATM));

      const host = new PaperHost({
        sessionId: SESSION, date: DATE, mode: 'paper', market, riskProfile,
        eligibility: {
          entryWindows: [{ from: '09:20', to: '15:00' }], blackoutDates: new Set(),
          maxSpreadPct: 0.015, minOi: 100, minVolume: 100, strikeBand: 5, strikeStepPaise: market.contract.strikeStepPaise,
        },
        strategy: new S1MomentumBurst(), params: S1_PARAMS,
        regime: { trend: () => 1, highVolDay: () => false }, cooldownSec: 5,
        broker: paper, marketData, ids: new IdFactory(SESSION), clock,
        journalDir: dir, fsync: 'never',
        configs: [{ name: 'market', hash: 'abc123abc123', path: 'm' }, { name: 'risk', hash: 'def456def456', path: 'r' }],
        quoteSink: (instrumentId, quote) => paper.setQuote(instrumentId, quote),
      });
      await Promise.resolve();
      return { host, journalPath: join(dir, 'events.jsonl'), ticks: sessionTicks(), clock };
    },
  };
}

describe('soak — N sessions back-to-back (03-TESTING-PLAN §9)', () => {
  it('every session keeps journal integrity, is deterministic, produces a digest, and does not leak', async () => {
    const N = 6;
    const specs = Array.from({ length: N }, (_, i) => makeSpec(String(i + 1)));
    const report = await runSoak(specs);

    expect(report.sessions).toHaveLength(N);

    // Journal integrity: on-disk == in-memory truth for every session.
    expect(report.allIntegrityOk).toBe(true);

    // Each session ran the same trade to the same net (correctness + determinism).
    for (const s of report.sessions) {
      expect(s.trades).toBe(1);
      expect(s.netPaise).toBe(88_398);
      expect(s.events).toBeGreaterThan(0);
    }

    // Determinism backstop: identical inputs → identical journal hash across all runs.
    const hashes = new Set(report.sessions.map((s) => s.journalHash));
    expect(hashes.size).toBe(1);

    // No unbounded growth. Generous bound (tiny sessions) that a real per-session
    // leak — e.g. cross-session retention — would blow past.
    expect(report.heapGrowthBytes).toBeLessThan(40 * 1024 * 1024);
  }, 60_000);
});
