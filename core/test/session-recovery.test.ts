/**
 * M9b step 4 acceptance: crash recovery. Run a trade life-cycle to a journal
 * on disk (a completed round trip + a still-open position), simulate a crash
 * by reopening the file, and assert the rebuilt orders / positions / trades /
 * session-risk state are identical and the seq stream continues gap-free. Also
 * covers the partial-tail truncation (never resume onto a torn line) and the
 * reconcile-vs-adapter mismatch that drives a safe-halt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema, RiskProfileSchema, type MarketProfile, type RiskProfile } from '../src/config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../src/domain/events.js';
import { IdFactory, makeInstrumentId, makeSessionId, type InstrumentId } from '../src/domain/ids.js';
import type { OrderIntent } from '../src/domain/orders.js';
import type { RiskVerdict } from '../src/domain/risk.js';
import type { SessionState } from '../src/domain/session.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { readJournal } from '../src/journal/reader.js';
import { JournalWriter } from '../src/journal/writer.js';
import { Oms } from '../src/oms/oms.js';
import { SessionRiskState } from '../src/risk/session-risk.js';
import { recoverFromJournal, reconcileRecovered } from '../src/session/recovery.js';

const configDir = new URL('../../config/', import.meta.url);
const market: MarketProfile = loadConfig(MarketProfileSchema, fileURLToPath(new URL('market/india-nse-options.json', configDir))).value;
const risk: RiskProfile = loadConfig(RiskProfileSchema, fileURLToPath(new URL('risk/paper-default.json', configDir))).value;
const SESSION = makeSessionId('2026-07-03', 'paper');
const CE: InstrumentId = makeInstrumentId('NSE', 'CE1');
const LOT = market.contract.lotSize;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'scalper-recover-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  oms: Oms;
  paper: PaperBroker;
  writer: JournalWriter;
  preRisk: SessionRiskState;
  clock: ManualClock;
  ids: IdFactory;
  submit: (side: 'BUY' | 'SELL', limitPricePaise: number, purpose: OrderIntent['purpose']) => Promise<void>;
}

function buildHarness(dir: string): Harness {
  const clock = new ManualClock(Date.UTC(2026, 6, 3, 4, 30));
  const ids = new IdFactory(SESSION);
  const paper = new PaperBroker({ clock });
  paper.setQuote(CE, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });
  const writer = new JournalWriter({ dir, clock, fsync: 'never', flushIntervalMs: 60_000 });
  const preRisk = new SessionRiskState(risk);
  const sink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void => {
    writer.append(type, payload);
    if (type === 'trade.completed') preRisk.recordTrade((payload as JournalPayloads['trade.completed']).trade.netPnlPaise);
  };
  const oms = new Oms({ sessionId: SESSION, adapter: paper, marketProfile: market, clock, ids, journal: sink });

  const submit = async (side: 'BUY' | 'SELL', limitPricePaise: number, purpose: OrderIntent['purpose']): Promise<void> => {
    clock.advance(1_000);
    const intent: OrderIntent = {
      intentId: ids.intentId(),
      sessionId: SESSION,
      strategyId: 's1',
      ts: clock.now(),
      side,
      instrumentId: CE,
      qty: LOT,
      type: 'LIMIT',
      limitPricePaise,
      ttlMs: 1_500,
      tag: `s1:${purpose.toLowerCase()}`,
      purpose,
      ...(purpose === 'ENTRY' ? { stopPlan: { hardStopPremiumPaise: 11_250, timeStopSec: 90 } } : {}),
    };
    await oms.submit(intent, { intentId: intent.intentId, ts: clock.now(), approved: true } as RiskVerdict);
  };

  // Session bookkeeping events so the reducer's session/config/phase branches run.
  const startedState: SessionState = {
    sessionId: SESSION,
    mode: 'paper',
    date: '2026-07-03',
    phase: 'PREFLIGHT',
    configHashes: { market: 'abc' },
    startedTs: clock.now(),
  };
  sink('session.started', { session: startedState });
  sink('config.loaded', { sessionId: SESSION, name: 'market', hash: 'abc', path: 'config/market/india-nse-options.json' });
  sink('session.phase', { sessionId: SESSION, phase: 'OPEN' });

  return { oms, paper, writer, preRisk, clock, ids, submit };
}

// ------------------------------------------------------------------- recovery

describe('crash recovery', () => {
  it('rebuilds orders/positions/trades/risk identically and resumes the seq stream', async () => {
    const dir = tmp();
    const h = buildHarness(dir);

    // A completed round trip, then a second entry left OPEN at the "crash".
    await h.submit('BUY', 15_000, 'ENTRY'); // fills @ 15000 → open
    h.paper.setQuote(CE, { bidPaise: 15_500, askPaise: 15_510, ltpPaise: 15_500 });
    await h.submit('SELL', 15_500, 'EXIT'); // fills @ 15500 → closes → trade.completed
    h.paper.setQuote(CE, { bidPaise: 14_990, askPaise: 15_000, ltpPaise: 15_000 });
    await h.submit('BUY', 15_000, 'ENTRY'); // fills @ 15000 → open position survives

    const prePositions = h.oms.getPositions();
    const preOrders = h.oms.getOrders();
    const preRiskSnap = h.preRisk.current();
    const preLastSeq = h.writer.lastSeq();
    expect(prePositions.filter((p) => p.state === 'OPEN').length).toBe(1);

    // Simulate the crash: flush + close the writer, reopen the journal cold.
    await h.writer.close();
    const path = h.writer.path;

    const rec = await recoverFromJournal(path, { riskProfile: risk });

    expect(rec.partialTail).toBe(false);
    expect(rec.lastSeq).toBe(preLastSeq);
    expect(rec.phase).toBe('OPEN');
    expect(rec.session?.sessionId).toBe(SESSION);
    expect(rec.configHashes).toMatchObject({ market: 'abc' });
    expect(rec.trades.length).toBe(1);

    // Positions + orders rebuilt byte-for-byte equal to the live books.
    const byCoid = <T extends { clientOrderId: string }>(a: T[]): T[] => [...a].sort((x, y) => x.clientOrderId.localeCompare(y.clientOrderId));
    expect(rec.positions).toEqual(prePositions);
    expect(byCoid(rec.orders)).toEqual(byCoid(preOrders));

    // Session-risk rebuilt by replaying completed-trade net P&L.
    expect(rec.sessionRisk.current()).toEqual(preRiskSnap);

    // Resume the writer at lastSeq+1 → the next event continues the stream.
    const resumed = new JournalWriter({ dir, clock: h.clock, fsync: 'never', flushIntervalMs: 60_000, resume: { startSeq: rec.lastSeq + 1 } });
    const ev = resumed.append('diag.error', { where: 'recovery.test', message: 'resumed' });
    expect(ev.seq).toBe(preLastSeq + 1);
    await resumed.close();

    const reread = await readJournal(path, { strictSeq: true });
    expect(reread.partialTail).toBe(false);
    expect(reread.events.length).toBe(preLastSeq + 1);
    expect(reread.events[reread.events.length - 1]?.seq).toBe(preLastSeq + 1);
  });

  it('drops a torn trailing line and never resumes onto it (seq stays gap-free)', async () => {
    const dir = tmp();
    const h = buildHarness(dir);
    await h.submit('BUY', 15_000, 'ENTRY');
    const preLastSeq = h.writer.lastSeq();
    await h.writer.close();
    const path = h.writer.path;

    // Simulate a crash mid-write: a half-written JSON line, no newline.
    appendFileSync(path, '{"seq":999,"ts":1,"type":"diag.error","payl');

    const rec = await recoverFromJournal(path, { riskProfile: risk });
    expect(rec.partialTail).toBe(true);
    expect(rec.lastSeq).toBe(preLastSeq); // torn line excluded

    // File is now clean: resume + append + strict re-read has no gap/corruption.
    const resumed = new JournalWriter({ dir, clock: h.clock, fsync: 'never', flushIntervalMs: 60_000, resume: { startSeq: rec.lastSeq + 1 } });
    resumed.append('diag.error', { where: 'recovery.test', message: 'after-torn' });
    await resumed.close();

    const reread = await readJournal(path, { strictSeq: true });
    expect(reread.partialTail).toBe(false);
    expect(reread.events.length).toBe(preLastSeq + 1);
  });

  it('reconcile vs adapter: matching book is clean, a broker mismatch flags the safe-halt', async () => {
    const dir = tmp();
    const h = buildHarness(dir);
    await h.submit('BUY', 15_000, 'ENTRY'); // one open position
    await h.writer.close();

    const rec = await recoverFromJournal(h.writer.path, { riskProfile: risk });
    expect(rec.positions.length).toBe(1);

    // Broker still holds the same position → clean, safe to resume.
    expect(reconcileRecovered(rec, h.paper.getPositions())).toEqual([]);

    // Broker is flat (missed the fill on restart) → mismatch → caller must halt.
    const mismatch = reconcileRecovered(rec, []);
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]).toMatchObject({ instrumentId: CE, omsNet: LOT, brokerNet: 0 });
  });
});
