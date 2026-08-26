import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, type MarketProfile, type RiskProfile } from '../src/config/schemas.js';
import type { JournalEvent } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId, type PositionId, type SessionId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import type { Position } from '../src/domain/positions.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { FeedMarketData } from '../src/host/feed-market-data.js';
import { PaperHost, type HostRunner, type PaperHostOptions } from '../src/host/paper-host.js';
import { Recorder } from '../src/feed/recorder.js';
import { ReplayFeed } from '../src/feed/replay.js';
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
const START_08AM_IST = Date.UTC(2026, 6, 3, 2, 30, 0); // 08:00 IST

const S1_PARAMS = {
  impulsePct: 0.0008, confirmTicks: 2, lots: 1, ttlMs: 1500, tickSizePaise: 5,
  timeStopSec: 90, hardStopPremiumPct: 25, breakevenAtPct: 12, trailStepPct: 8, trailLockPct: 50,
};

function spotTick(ts: number, ltpPaise: number, volume: number): Tick {
  return { instrumentId: SPOT_ID, ts, recvTs: ts, ltpPaise, qty: 100, volume, bidPaise: ltpPaise - 5, askPaise: ltpPaise + 5, bidQty: 100, askQty: 100 };
}
function optionTick(id: InstrumentId, ts: number, bid: number, ask: number, ltp: number): Tick {
  return { instrumentId: id, ts, recvTs: ts, ltpPaise: ltp, qty: 50, volume: 100_000, oi: 500_000, bidPaise: bid, askPaise: ask, bidQty: 650, askQty: 650 };
}

function makeMarketData(): FeedMarketData {
  return new FeedMarketData({
    spotInstrumentId: SPOT_ID,
    options: [
      { instrumentId: CE_ID, strikePaise: ATM, right: 'CE', expiry: '2026-07-07' },
      { instrumentId: PE_ID, strikePaise: ATM, right: 'PE', expiry: '2026-07-07' },
    ],
    strikeStepPaise: market.contract.strikeStepPaise,
  });
}

function buildHost(dir: string, clock: ManualClock, marketData: FeedMarketData, paper: PaperBroker, extra: Partial<PaperHostOptions> = {}): PaperHost {
  return new PaperHost({
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
    ...extra,
  });
}

/** Drive the full life of one S1 trade through the host (mirrors the M7 e2e ladder). */
async function runFullSession(dir: string): Promise<{ host: PaperHost; paper: PaperBroker; clock: ManualClock }> {
  const clock = new ManualClock(START_10AM_IST);
  const marketData = makeMarketData();
  const paper = new PaperBroker({ clock });
  paper.setQuote(CE_ID, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });

  // Prime: seed a fresh spot tick + option rows so preflight feed.fresh passes.
  let ts = START_10AM_IST;
  marketData.ingest(spotTick(ts, ATM, 100));
  marketData.ingest(optionTick(CE_ID, ts, 14_990, 15_000, 15_000));
  marketData.ingest(optionTick(PE_ID, ts, 14_990, 15_000, 15_000));

  const host = buildHost(dir, clock, marketData, paper);
  const started = await host.start();
  expect(started).toEqual({ recovered: false, halted: false });
  expect(host.sessionPhase()).toBe('OPEN');
  expect(host.runnerState()).toBe('ARMED');

  const spot = async (ltp: number): Promise<void> => {
    ts += 1000; clock.set(ts);
    await host.ingestTick(spotTick(ts, ltp, 100 + ts));
  };
  const prem = async (bid: number, ask: number, ltp: number): Promise<void> => {
    ts += 1000; clock.set(ts);
    paper.setQuote(CE_ID, { bidPaise: bid, askPaise: ask, ltpPaise: ltp });
    await host.ingestTick(optionTick(CE_ID, ts, bid, ask, ltp));
  };

  let s = ATM;
  for (let i = 0; i < 10; i++) await spot(s); // warmup
  s += 2_500; await spot(s); // CONFIRMING
  s += 2_500; await spot(s); // ENTRY → fill @ ask 15000

  await prem(15_590, 15_610, 15_600);
  await prem(16_790, 16_810, 16_800); // breakeven + trail
  await prem(17_990, 18_010, 18_000); // trail → stop 16500
  await prem(16_390, 16_410, 16_400); // ≤16500 → L2_TRAIL trigger → exit @ bid 16390

  for (let i = 0; i < 6; i++) await spot(s); // let cooldown elapse
  return { host, paper, clock };
}

describe('PaperHost — end-to-end paper session (M10 §3)', () => {
  it('uses receive time, not a future exchange timestamp, for runner lifecycle clocks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-receive-clock-'));
    const clock = new ManualClock(START_10AM_IST);
    const marketData = makeMarketData();
    const paper = new PaperBroker({ clock });
    marketData.ingest(spotTick(START_10AM_IST, ATM, 100));
    const observed: number[] = [];
    const runner: HostRunner = {
      arm: () => undefined,
      disarm: () => undefined,
      setParams: () => undefined,
      state: () => 'DISARMED',
      lastNoTrade: () => undefined,
      activeParamsSnapshot: () => ({}),
      onUnderlyingTick: async (nowMs) => { observed.push(nowMs); },
      onOptionTick: async (_instrumentId, _ltpPaise, nowMs) => { observed.push(nowMs); },
      onTimer: async () => undefined,
      onTrade: () => undefined,
    };
    const host = buildHost(dir, clock, marketData, paper, {
      autoArm: false,
      runnerFactory: () => runner,
    });
    await host.start();

    const exchangeAheadMs = 8_000;
    await host.ingestTick({
      ...optionTick(CE_ID, START_10AM_IST + exchangeAheadMs, 14_990, 15_000, 15_000),
      recvTs: START_10AM_IST,
    });
    expect(observed).toEqual([START_10AM_IST]);
    await host.close();
  });

  it('auto-arms once the session reaches OPEN even if the host started pre-market', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-autoarm-'));
    const clock = new ManualClock(START_08AM_IST);
    const marketData = makeMarketData();
    const paper = new PaperBroker({ clock });
    marketData.ingest(spotTick(START_08AM_IST, ATM, 100));
    marketData.ingest(optionTick(CE_ID, START_08AM_IST, 14_990, 15_000, 15_000));
    marketData.ingest(optionTick(PE_ID, START_08AM_IST, 14_990, 15_000, 15_000));

    const host = buildHost(dir, clock, marketData, paper, { autoArm: true });
    const started = await host.start();
    expect(started).toEqual({ recovered: false, halted: false });
    expect(host.sessionPhase()).toBe('PREFLIGHT');
    expect(host.runnerState()).toBe('DISARMED');

    clock.set(Date.UTC(2026, 6, 3, 3, 50, 0)); // 09:20 IST
    await host.onTimer(clock.now());

    expect(host.sessionPhase()).toBe('OPEN');
    expect(host.runnerState()).toBe('ARMED');
    await host.close();
  }, 20_000);

  it('retries a feed-only failed startup preflight when the first live spot arrives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-feed-retry-'));
    const clock = new ManualClock(START_10AM_IST);
    const marketData = makeMarketData();
    const paper = new PaperBroker({ clock });
    const host = buildHost(dir, clock, marketData, paper, { autoArm: true, autoAckPreflight: true });

    await host.start();
    expect(host.sessionPhase()).toBe('PREFLIGHT');
    expect(host.canArm()).toMatchObject({ ok: false, reason: 'PREFLIGHT_FAILED' });

    await host.ingestTick(spotTick(START_10AM_IST, ATM, 100));

    expect(host.sessionPhase()).toBe('OPEN');
    expect(host.runnerState()).toBe('ARMED');
    const preflights = host.journalEvents().filter((event) => event.type === 'session.preflight');
    expect(preflights).toHaveLength(2);
    expect(preflights[1]).toMatchObject({ payload: { ok: true } });
    await host.close();
  }, 20_000);

  it('can require an explicit operator ACK before ARM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-no-autoack-'));
    const clock = new ManualClock(START_10AM_IST);
    const marketData = makeMarketData();
    const paper = new PaperBroker({ clock });
    marketData.ingest(spotTick(START_10AM_IST, ATM, 100));
    marketData.ingest(optionTick(CE_ID, START_10AM_IST, 14_990, 15_000, 15_000));
    marketData.ingest(optionTick(PE_ID, START_10AM_IST, 14_990, 15_000, 15_000));

    const host = buildHost(dir, clock, marketData, paper, { autoArm: false, autoAckPreflight: false });
    await host.start();

    expect(host.sessionPhase()).toBe('PREFLIGHT');
    expect(host.canArm()).toMatchObject({ ok: false, reason: 'PREFLIGHT_NOT_ACKED' });
    expect(host.runnerState()).toBe('DISARMED');

    expect(host.acknowledgePreflight('operator')).toMatchObject({ accepted: true });
    expect(host.sessionPhase()).toBe('OPEN');
    expect(host.canArm()).toMatchObject({ ok: true });
    await host.close();
  }, 20_000);

  it('runs a full trade, journals it, writes trades.jsonl + digest, reconciles GREEN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-full-'));
    const { host } = await runFullSession(dir);

    const events = host.journalEvents();
    const byType = (t: JournalEvent['type']): JournalEvent[] => events.filter((e) => e.type === t);
    expect(byType('session.started').length).toBeGreaterThanOrEqual(1);
    const preflight = byType('session.preflight')[0];
    expect(preflight?.type === 'session.preflight' && preflight.payload.ok).toBe(true);

    const trades = byType('trade.completed');
    expect(trades.length).toBe(1);
    const trade = trades[0];
    if (trade?.type === 'trade.completed') {
      expect(trade.payload.trade.netPnlPaise).toBe(88_398); // hand-pinned M7 waterfall
    expect(trade.payload.trade.exitReason).toBe('L2_TRAIL');
    }

    // Reconciler ran GREEN throughout (a trade closed → reconcile after fill).
    expect(host.reconState()).toBe('GREEN');
    const recon = byType('recon.result');
    expect(recon.length).toBeGreaterThanOrEqual(1);
    expect(recon.every((e) => e.type === 'recon.result' && e.payload.ok)).toBe(true);

    // Latency instrumentation captured decisions.
    expect(host.latencySnapshot().total.count).toBeGreaterThan(0);

    // Square off → digest artifacts.
    const { report, artifacts } = await host.squareOffAndReport();
    expect(report.summary.tradeCount).toBe(1);
    expect(report.summary.netPaise).toBe(88_398);
    expect(report.trades[0]?.maePaise).toBe(0); // md.tick coverage while held; never went adverse
    expect(existsSync(artifacts.mdPath)).toBe(true);
    expect(existsSync(artifacts.csvPath)).toBe(true);
    expect(readFileSync(artifacts.mdPath, 'utf8')).toContain('Net P&L');

    // Completed trades and raw broker events are separate exports. The former
    // is a real blotter input; the latter is execution-debug evidence.
    const tradesJsonl = readFileSync(join(dir, 'trades.jsonl'), 'utf8');
    expect(tradesJsonl).toContain('"kind":"trade"');
    expect(tradesJsonl).not.toContain('"kind":"orderEvent"');
    expect(readFileSync(join(dir, 'broker-events.jsonl'), 'utf8')).toContain('"kind":"orderEvent"');
  }, 30_000);

  it('reconciliation RED (broker book ≠ OMS) trips the kill switch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-recon-'));
    const clock = new ManualClock(START_10AM_IST);
    const marketData = makeMarketData();
    const paper = new PaperBroker({ clock });
    marketData.ingest(spotTick(START_10AM_IST, ATM, 100));
    const host = buildHost(dir, clock, marketData, paper);
    await host.start();

    // Inject a phantom broker position the OMS never saw → RED.
    const phantom: Position = {
      positionId: 'phantom' as PositionId, sessionId: SESSION, strategyId: 's1', instrumentId: CE_ID,
      side: 'BUY', qty: 65, avgEntryPricePaise: 15_000, state: 'OPEN', realizedGrossPaise: 0, openedTs: START_10AM_IST, updatedTs: START_10AM_IST,
    };
    paper.setPositionQty(CE_ID, phantom);
    host.reconcileNow();
    // The reconciler fires kill.trip fire-and-forget (AUTO); its flatten ladder
    // and the notify→session.KILLED land on later microtasks. Drain them.
    await new Promise<void>((r) => setImmediate(r));

    expect(host.reconState()).toBe('RED');
    expect(host.killLocked()).toBe(true);
    expect(host.sessionPhase()).toBe('KILLED');
    const trip = host.journalEvents().find((e) => e.type === 'kill.tripped');
    expect(trip?.type === 'kill.tripped' && trip.payload.reason).toBe('RECON_MISMATCH');
    await host.close();
  }, 20_000);
});

/** Write a hand-built journal file for recovery tests. */
function writeJournal(dir: string, events: Array<Omit<JournalEvent, 'seq' | 'ts'> & { ts?: number }>): void {
  const lines = events.map((e, i) => JSON.stringify({ seq: i + 1, ts: e.ts ?? START_10AM_IST, type: e.type, payload: e.payload }));
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
}

describe('PaperHost — crash recovery (M10 §3, 03 §4)', () => {
  it('abandons recovered open positions in paper mode and arms (no halt)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-recover-halt-'));
    const openPos: Position = {
      positionId: 'p1' as PositionId, sessionId: SESSION, strategyId: 's1', instrumentId: CE_ID,
      side: 'BUY', qty: 65, avgEntryPricePaise: 15_000, state: 'OPEN', realizedGrossPaise: 0, openedTs: START_10AM_IST, updatedTs: START_10AM_IST,
    };
    writeJournal(dir, [
      { type: 'session.started', payload: { session: { sessionId: SESSION, mode: 'paper', date: DATE, phase: 'OPEN', configHashes: {}, startedTs: START_10AM_IST } } },
      { type: 'position.opened', payload: { position: openPos } },
    ]);

    const clock = new ManualClock(START_10AM_IST + 60_000);
    const marketData = makeMarketData();
    const paper = new PaperBroker({ clock });
    // Paper broker starts empty on restart; journal has open position — orphaned lot.
    marketData.ingest(spotTick(clock.now(), ATM, 100));

    const host = buildHost(dir, clock, marketData, paper);
    const res = await host.start();
    // Paper mode: ephemeral broker, no real exposure — abandoned with diag.error warning, continues.
    expect(res.halted).toBe(false);
    expect(host.sessionPhase()).toBe('OPEN');
    expect(host.runnerState()).toBe('ARMED');
    await host.close();
  }, 20_000);

  it('resumes cleanly (flat, reconciled) and continues the journal seq', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-recover-resume-'));
    writeJournal(dir, [
      { type: 'session.started', payload: { session: { sessionId: SESSION, mode: 'paper', date: DATE, phase: 'OPEN', configHashes: {}, startedTs: START_10AM_IST } } },
      { type: 'config.loaded', payload: { sessionId: SESSION, name: 'market', hash: 'abc123abc123', path: 'm' } },
      { type: 'strategy.noTrade', payload: { strategyId: 's1', reason: 'NO_IMPULSE' } },
    ]);
    const priorSeq = 3;

    const clock = new ManualClock(START_10AM_IST + 60_000);
    const marketData = makeMarketData();
    const paper = new PaperBroker({ clock }); // flat broker
    marketData.ingest(spotTick(clock.now(), ATM, 100));

    const host = buildHost(dir, clock, marketData, paper);
    const res = await host.start();
    expect(res).toEqual({ recovered: true, halted: false });
    expect(host.sessionPhase()).toBe('OPEN');
    expect(host.runnerState()).toBe('ARMED');
    // The resumed writer continues the seq stream: first new event is priorSeq+1.
    expect(host.journalEvents()[0]?.seq).toBe(priorSeq + 1);
    await host.close();
  }, 20_000);
});

describe('PaperHost — tick recorder grows the replay corpus (M10 §5)', () => {
  it('records every ingested tick; the file replays back tick-for-tick', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-rec-'));
    const clock = new ManualClock(START_10AM_IST);
    const marketData = makeMarketData();
    const paper = new PaperBroker({ clock });
    marketData.ingest(spotTick(START_10AM_IST, ATM, 100));
    const recorder = new Recorder({ dir, compression: 'none' });

    const host = buildHost(dir, clock, marketData, paper, { recorder, autoArm: false });
    await host.start();

    let ts = START_10AM_IST;
    const feed: Tick[] = [];
    for (let i = 0; i < 12; i++) {
      ts += 1000; clock.set(ts);
      const tk = spotTick(ts, ATM + i * 100, 100 + i);
      feed.push(tk);
      await host.ingestTick(tk);
    }
    expect(recorder.tickCount()).toBe(feed.length);
    await host.close();
    await recorder.close();

    // The recorded corpus replays deterministically for the soak/backtest path.
    const replayed: Tick[] = [];
    const replay = new ReplayFeed({ path: recorder.path });
    replay.setTickHandler((t) => replayed.push(t));
    await replay.playInstant();
    expect(replayed).toHaveLength(feed.length);
    expect(replayed[0]?.ltpPaise).toBe(feed[0]?.ltpPaise);
    expect(replayed.at(-1)?.ltpPaise).toBe(feed.at(-1)?.ltpPaise);
  }, 20_000);
});
