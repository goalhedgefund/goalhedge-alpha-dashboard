import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketProfile, RiskProfile } from '../config/schemas.js';
import type { JournalEvent, JournalEventType, JournalPayloads } from '../domain/events.js';
import type { IdFactory, InstrumentId, SessionId, SessionMode } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';
import { isTerminalOrderState } from '../domain/orders.js';
import { formatHHMMIst, systemClock, type Clock } from '../domain/time.js';
import type { IBrokerAdapter } from '../exec/adapter.js';
import { TradesWriter } from '../exec/trades-writer.js';
import { toGatewayLatency, type GatewayMmState, type GatewayStateSlices } from '../gateway/protocol.js';
import { mirrorEvent } from '../journal/mirror.js';
import { JournalWriter, type FsyncPolicy } from '../journal/writer.js';
import { Persistence } from '../persistence/db.js';
import { ExitEscalator } from '../oms/escalation.js';
import { Oms } from '../oms/oms.js';
import { Reconciler } from '../oms/reconciler.js';
import { KillSwitch } from '../killswitch/kill-switch.js';
import { FeedRecoveryRearm } from '../killswitch/auto-rearm.js';
import { RiskGate, type RiskGateContext } from '../risk/risk-gate.js';
import { SessionRiskState } from '../risk/session-risk.js';
import { buildDigest, writeDigest, type DigestArtifacts, type DigestReport } from '../report/digest.js';
import { recoverFromJournal, reconcileRecovered, type RecoveredState } from '../session/recovery.js';
import { SessionManager, type LoadedConfigRef } from '../session/session.js';
import { StopEngine } from '../stops/stop-engine.js';
import { StrategyRunner, type JournalSink } from '../strategy/runner.js';
import type { EligibilityConfig, RegimeTrend } from '../strategy/eligibility.js';
import type { IStrategy, StrategyLifecycle, StrategyParams } from '../strategy/types.js';
import type { Trade } from '../domain/positions.js';
import { LatencySampler } from '../telemetry/latency.js';
import type { WeeklyChainResult } from '../marketdata/instrument-master.js';
import type { FeedMarketData } from './feed-market-data.js';

/** Optional tick sink (Recorder) so every session grows the replay corpus. */
export interface TickRecorderPort {
  record(tick: Tick): void;
}

/** Optional gateway sink so a UI can attach to a live host. */
export interface GatewayPort {
  ingestJournal(ev: JournalEvent): void;
  /**
   * Optional: periodic push of the derived slices the journal alone cannot
   * keep fresh (health ages, risk meters, chain quotes, algo lifecycle).
   * The real Gateway implements this; a journal-only sink may omit it.
   */
  publishState?(slices: GatewayStateSlices): void;
}

/**
 * The runner surface the host drives. StrategyRunner satisfies it
 * structurally; the ALL_OP MmRunner implements it directly — the host does
 * not care whether entries come from one proposal or a standing quote set.
 */
export interface HostRunner {
  arm(): void;
  disarm(): void;
  setParams(params: StrategyParams): void;
  state(): StrategyLifecycle;
  lastNoTrade(): string | undefined;
  activeParamsSnapshot(): StrategyParams;
  mmState?(): GatewayMmState;
  onUnderlyingTick(nowMs: number): Promise<void>;
  onOptionTick(instrumentId: InstrumentId, ltpPaise: number, nowMs: number): Promise<void>;
  onTimer(nowMs: number): Promise<void>;
  onTrade(trade: Trade): void;
}

/** Runtime pieces wire() builds that a custom runner needs to plug into. */
export interface HostRunnerPorts {
  gate: RiskGate;
  oms: Oms;
  sessionRisk: SessionRiskState;
  escalator: ExitEscalator;
  clock: Clock;
  journal: JournalSink;
  journalHealthy: () => boolean;
  latency: LatencySampler;
}

export interface PaperHostOptions {
  sessionId: SessionId;
  date: string;
  mode?: SessionMode;
  market: MarketProfile;
  riskProfile: RiskProfile;
  eligibility: EligibilityConfig;
  strategy: IStrategy;
  params: StrategyParams;
  regime?: { trend(): RegimeTrend; highVolDay(): boolean };
  cooldownSec?: number;

  broker: IBrokerAdapter;
  marketData: FeedMarketData;
  ids: IdFactory;
  clock?: Clock;

  /** journals/<date>/ — journal + trades.jsonl + digest land here. */
  journalDir: string;
  journalFilename?: string;
  fsync?: FsyncPolicy;
  /** Loaded config descriptors journaled at preflight. */
  configs: ReadonlyArray<LoadedConfigRef>;
  /** Preflight chain probe; a stub resolved from the option set by default. */
  resolveChain?: () => WeeklyChainResult | undefined;
  /** Timestamp used by preflight feed freshness. Defaults to marketData.lastSpotTs(). */
  preflightLastTickTs?: () => number;
  feedStaleMs?: number;

  reconcileEveryMs?: number;
  /** Auto-ARM once preflight passes (headless paper/soak). Default true. */
  autoArm?: boolean;
  /** Auto-ACK preflight once technical checks pass. Default true for legacy tests/headless runs. */
  autoAckPreflight?: boolean;
  recorder?: TickRecorderPort;
  gateway?: GatewayPort;
  /**
   * SQLite mirror (01-DESIGN §9). Default: scalper.db inside journalDir.
   * Pass an existing Persistence to share one, or 'off' to disable.
   */
  persistence?: Persistence | 'off';
  /**
   * Paper-only: forward option quotes to the broker so fills track the replayed
   * feed (e.g. PaperBroker.setQuote). Without it, a pure tick replay can't fill
   * because the broker never learns the touch. Absent in live mode.
   */
  quoteSink?: (instrumentId: InstrumentId, quote: { bidPaise: number; askPaise: number; ltpPaise: number }) => void;
  /**
   * Build a custom runner (e.g. the ALL_OP MmRunner) instead of the default
   * StrategyRunner. The factory receives the wired runtime ports; kill
   * switch, session square-off, and gateway commands target it identically.
   */
  runnerFactory?: (ports: HostRunnerPorts) => HostRunner;
  /**
   * Opt-in: automatically re-arm a FEED_STALE kill (only that reason) once
   * the feed has streamed continuously for stableMs, at most maxPerDay times
   * per session. The trip already flattened all positions; re-entries still
   * pass every gate. All other trip reasons stay operator-only.
   */
  autoRearmFeedRecovery?: { stableMs: number; maxPerDay: number };
}

export interface HostStartResult {
  recovered: boolean;
  halted: boolean;
  reason?: string;
}

/**
 * Real paper/live host (02-CODING-PLAN M10). Composes the whole runtime the
 * demo only mimicked: journal + trades.jsonl writers, OMS, Risk Gate, Stop
 * Engine, Strategy Runner (with latency instrumentation + exit escalator),
 * Kill Switch, Session Manager, and — the two pieces M9 left library-tested —
 * the **Reconciler** (on a cadence + after fills) and **crash recovery**
 * (journal replay + broker reconcile → resume or safe-halt on start).
 *
 * It is driven, not self-clocked: `ingestTick` and `onTimer` are called by the
 * feed/host loop (deterministic under a ManualClock in tests; a thin
 * setInterval wrapper drives it in wall-clock live mode). At square-off it
 * flattens, reconciles once more, and writes the daily digest.
 */
export class PaperHost {
  private readonly clock: Clock;
  private readonly mode: SessionMode;
  private readonly journalPath: string;
  private readonly reconcileEveryMs: number;

  private writer!: JournalWriter;
  private tradesWriter!: TradesWriter;
  private oms!: Oms;
  private runner!: HostRunner;
  private kill!: KillSwitch;
  private session!: SessionManager;
  private reconciler!: Reconciler;
  private sessionRisk!: SessionRiskState;
  private readonly latency = new LatencySampler();
  private readonly events: JournalEvent[] = [];
  private lastReconcileMs = Number.NEGATIVE_INFINITY;
  private started = false;
  private journalBroken = false;
  private db: Persistence | undefined;
  private mirrorBroken = false;
  private lastTickTs = 0;
  private readonly autoRearm: FeedRecoveryRearm | undefined;

  constructor(private readonly opts: PaperHostOptions) {
    this.clock = opts.clock ?? systemClock;
    this.mode = opts.mode ?? 'paper';
    this.journalPath = join(opts.journalDir, opts.journalFilename ?? 'events.jsonl');
    this.reconcileEveryMs = opts.reconcileEveryMs ?? 2_000;
    this.autoRearm =
      opts.autoRearmFeedRecovery !== undefined
        ? new FeedRecoveryRearm({
            stableMs: opts.autoRearmFeedRecovery.stableMs,
            maxPerDay: opts.autoRearmFeedRecovery.maxPerDay,
            feedFreshMs: opts.feedStaleMs ?? 5_000,
          })
        : undefined;
  }

  /**
   * Recover-if-present → open writer (resuming after a crash) → wire the
   * runtime → preflight → (safe-halt on unsafe recovery, else) ACK + ARM.
   * Prime the marketData with a recent spot tick before calling this so the
   * preflight feed-freshness check passes.
   */
  async start(): Promise<HostStartResult> {
    const recovered = await this.recoverIfPresent();
    this.sessionRisk = recovered?.sessionRisk ?? new SessionRiskState(this.opts.riskProfile);

    this.writer = new JournalWriter({
      dir: this.opts.journalDir,
      filename: this.opts.journalFilename ?? 'events.jsonl',
      clock: this.clock,
      fsync: this.opts.fsync ?? 'never',
      ...(recovered !== undefined ? { resume: { startSeq: recovered.lastSeq + 1 } } : {}),
    });
    await this.writer.ready();
    this.tradesWriter = new TradesWriter({ dir: this.opts.journalDir });
    this.db =
      this.opts.persistence === 'off'
        ? undefined
        : this.opts.persistence ?? new Persistence(join(this.opts.journalDir, 'scalper.db'));
    this.wire();
    // Rehydrate the gateway's in-memory UI state from the durable journal.
    // Risk and recovery gates are rebuilt above; this replay restores trades,
    // orders, positions, and the event stream after a process restart.
    if (recovered !== undefined) {
      for (const event of recovered.events) this.opts.gateway?.ingestJournal(event);
    }

    await this.session.runPreflight();

    // Crash recovery gate: refuse to resume trading into an unsafe state.
    // A recovered open position can't be safely re-adopted in v1, and any
    // OMS-vs-broker mismatch is dangerous — both safe-halt (operator flattens
    // then restarts). A flat, clean book resumes.
    //
    // Paper-mode exception: the paper broker is ephemeral (starts empty on every
    // restart), so recovered open positions are always journal artifacts — there is
    // no real exposure to protect. Abandon them with a diagnostic warning and let
    // trading resume. A genuine OMS-vs-broker mismatch (diffs on both sides) still
    // halts even in paper mode.
    if (recovered !== undefined) {
      const diffs = reconcileRecovered(recovered, this.opts.broker.getPositions());
      const openPositions = recovered.positions.length > 0;
      if (diffs.length > 0 || openPositions) {
        const reason = openPositions ? 'RECOVERED_OPEN_POSITION' : 'RECON_MISMATCH_ON_RECOVERY';
        if (this.mode === 'paper' && reason === 'RECOVERED_OPEN_POSITION') {
          // Abandon the orphaned lots in the journal; broker starts flat.
          this.sink('diag.error', { where: 'recovery', message: 'RECOVERED_OPEN_POSITION:PAPER_ABANDONED' });
        } else {
          this.sink('diag.error', { where: 'recovery', message: reason });
          this.session.halt(reason);
          this.started = true;
          return { recovered: true, halted: true, reason };
        }
      }
    }

    const shouldAutoAck = this.opts.autoAckPreflight ?? true;
    const ack = shouldAutoAck ? this.session.acknowledge('host') : { accepted: false };
    if ((this.opts.autoArm ?? true) && ack.accepted && this.session.canArm().ok) {
      this.runner.arm();
    }
    this.started = true;
    return { recovered: recovered !== undefined, halted: false };
  }

  /**
   * Route one normalized tick: update market state, journal a bounded md.tick
   * only while the instrument is held (so MAE has coverage without journal
   * bloat), drive the runner, record to the corpus, and reconcile on cadence.
   */
  async ingestTick(tick: Tick): Promise<void> {
    if (!this.started) throw new Error('PaperHost.ingestTick before start()');
    this.opts.recorder?.record(tick);
    // Kill-switch/health freshness is based on arrival time. Broker feeds may
    // expose tick.ts as last-traded/exchange time, which can lag or occasionally
    // lead local wall time; that timestamp still drives bars/strategy below.
    const observedTs = Math.min(tick.recvTs, this.clock.now());
    if (observedTs > this.lastTickTs) this.lastTickTs = observedTs;
    this.kill.noteTick(observedTs);
    this.kill.checkClockSkew(this.clock.now());
    const kind = this.opts.marketData.ingest(tick);
    // Stale carryover (prior-day ts): recorded + arrival-noted above so the feed
    // reads healthy, but it must not drive the view, runner, or reconcile cadence.
    if (kind === 'stale') return;

    if (kind === 'option') {
      this.opts.quoteSink?.(tick.instrumentId, { bidPaise: tick.bidPaise, askPaise: tick.askPaise, ltpPaise: tick.ltpPaise });
      if (this.isHeld(tick.instrumentId)) this.sink('md.tick', { tick });
    }

    if (kind === 'spot') {
      await this.runner.onUnderlyingTick(tick.ts);
    } else if (kind === 'option') {
      await this.runner.onOptionTick(tick.instrumentId, tick.ltpPaise, tick.ts);
    }

    this.maybeReconcile(tick.ts);
  }

  /** Timer cadence: time-stops / escalation ladder + reconcile cadence. */
  async onTimer(nowMs: number): Promise<void> {
    if (!this.started) return;
    this.kill.petWatchdog(nowMs);
    this.kill.checkFeedStale(nowMs); // trips only while positioned + silent
    // Opt-in FEED_STALE self-recovery: rearm restores the session phase via
    // notify→onKill, and the autoArm block below re-arms the runner this tick.
    const rearmReason = this.autoRearm?.poll(nowMs, this.kill.state(), this.kill.lastTripReason(), this.lastTickTs);
    if (rearmReason !== undefined) this.kill.rearm('REARM', rearmReason);
    this.oms.expireTtl(nowMs); // TTL lapse → EXPIRED + broker cancel-and-verify
    this.oms.cancelUnacked(nowMs); // unacked past timeout → cancel-and-verify
    await this.runner.onTimer(nowMs);
    await this.kill.retryFlatten();
    await this.session.onTimer(nowMs);
    if ((this.opts.autoArm ?? true) && this.runner.state() === 'DISARMED' && this.session.canArm().ok) {
      this.runner.arm();
    }
    this.maybeReconcile(nowMs);
    this.publishGateway(nowMs);
  }

  /** Force a reconcile now (after a fill, or on demand). Returns the state. */
  reconcileNow(): void {
    this.reconciler.reconcile();
    this.lastReconcileMs = this.clock.now();
  }

  /**
   * Square off, final reconcile, write the digest, and close the writers.
   * Returns the digest + artifact paths. Idempotent-ish (guarded by session).
   */
  async squareOffAndReport(): Promise<{ report: DigestReport; artifacts: DigestArtifacts }> {
    await this.session.squareOff();
    this.reconcileNow();
    const stillOpen = this.oms.getPositions().filter((p) => p.state !== 'CLOSED' && p.qty > 0);
    if (stillOpen.length > 0) {
      this.sink('diag.error', {
        where: 'host.squareOff',
        message: `${stillOpen.length} position(s) still open at digest time — exits are being chased; digest may be incomplete`,
      });
    }
    await this.writer.flush();
    const report = buildDigest(this.events, { sessionId: String(this.opts.sessionId), date: this.opts.date, mode: this.mode });
    const artifacts = await writeDigest(report, this.opts.journalDir);
    await this.close();
    return { report, artifacts };
  }

  async close(): Promise<void> {
    await this.writer.close();
    await this.tradesWriter.close();
    if (this.db !== undefined && this.opts.persistence === undefined) this.db.close();
    this.db = undefined;
  }

  // ------------------------------------------------------------ accessors (UI/tests)

  arm(): void {
    this.runner.arm();
  }
  disarm(): void {
    this.runner.disarm();
  }
  setParams(params: StrategyParams): void {
    this.runner.setParams(params);
  }
  canArm(): ReturnType<SessionManager['canArm']> {
    return this.session.canArm();
  }
  resetSessionRisk(reason: string): { accepted: boolean; reason?: string } {
    const hasOpenPosition = this.oms.getPositions().some((position) => position.state !== 'CLOSED' && position.qty > 0);
    const hasWorkingOrder = this.oms.getOrders().some((order) => !isTerminalOrderState(order.state));
    if (hasOpenPosition || hasWorkingOrder) return { accepted: false, reason: 'BOOK_NOT_FLAT' };
    if (this.sessionRisk.current().latchedStop === undefined) return { accepted: false, reason: 'NO_SESSION_LOCKOUT' };
    this.sessionRisk.operatorReset();
    this.sink('risk.sessionReset', { reason });
    return { accepted: true, reason: 'SESSION_LOCKOUT_CLEARED' };
  }
  disableLossStreak(reason: string): { accepted: boolean; reason?: string } {
    const hasOpenPosition = this.oms.getPositions().some((position) => position.state !== 'CLOSED' && position.qty > 0);
    const hasWorkingOrder = this.oms.getOrders().some((order) => !isTerminalOrderState(order.state));
    if (hasOpenPosition || hasWorkingOrder) return { accepted: false, reason: 'BOOK_NOT_FLAT' };
    this.sessionRisk.disableLossStreak();
    this.sessionRisk.operatorReset();
    this.sink('risk.lossStreakDisabled', { reason });
    this.sink('risk.sessionReset', { reason });
    return { accepted: true, reason: 'LOSS_STREAK_DISABLED_AND_LOCKOUT_CLEARED' };
  }
  acknowledgePreflight(operator?: string): ReturnType<SessionManager['acknowledge']> {
    return this.session.acknowledge(operator);
  }
  tripKill(source: 'MANUAL' | 'AUTO', reason: string): Promise<unknown> {
    return this.kill.trip(source, reason);
  }
  rearmKill(confirm: string, reason: string): ReturnType<KillSwitch['rearm']> {
    return this.kill.rearm(confirm, reason);
  }
  journalGatewayCommand<K extends 'command.received' | 'command.acked'>(type: K, payload: JournalPayloads[K]): void {
    if (!this.started) throw new Error('PaperHost.journalGatewayCommand before start()');
    this.sink(type, payload);
  }

  runnerState(): ReturnType<StrategyRunner['state']> {
    return this.runner.state();
  }
  sessionPhase(): string {
    return this.session.phase();
  }
  killLocked(): boolean {
    return this.kill.isLocked();
  }
  reconState(): string | undefined {
    return this.reconciler.lastReconState();
  }
  latencySnapshot(): ReturnType<LatencySampler['snapshot']> {
    return this.latency.snapshot();
  }
  journalEvents(): readonly JournalEvent[] {
    return this.events;
  }
  positions(): ReturnType<Oms['getPositions']> {
    return this.oms.getPositions();
  }

  // ---------------------------------------------------------------- internals

  private wire(): void {
    const { opts } = this;
    const gate = new RiskGate(opts.market, opts.riskProfile);
    const markPrice = (id: InstrumentId, exitSide: 'BUY' | 'SELL' = 'SELL'): number | undefined => {
      const row = opts.marketData.optionRows().get(id);
      if (row === undefined) return undefined;
      const touch = exitSide === 'BUY' ? row.askPaise : row.bidPaise;
      return touch > 0 ? touch : row.ltpPaise > 0 ? row.ltpPaise : undefined;
    };
    const killGateCtx = (): RiskGateContext => ({
      nowMs: this.clock.now(),
      nowHHMM: formatHHMMIst(this.clock.now()),
      allowedInstruments: opts.marketData.allowedInstruments(),
      optionRows: opts.marketData.optionRows(),
      openPositions: this.oms.getPositions(),
      session: this.sessionRisk.current(),
    });

    this.oms = new Oms({
      sessionId: opts.sessionId,
      adapter: opts.broker,
      marketProfile: opts.market,
      clock: this.clock,
      ids: opts.ids,
      journal: this.sink,
      tradesWriter: this.tradesWriter,
      // Trades carry strike/right resolved at fill time so the UI blotter
      // survives expiry rolls without a live chain lookup.
      instrumentInfo: (id) => {
        const row = opts.marketData.optionRows().get(id);
        return row !== undefined ? { strikePaise: row.strikePaise, right: row.right } : undefined;
      },
    });

    const escalator = new ExitEscalator({
      oms: this.oms,
      gate,
      gateContext: killGateCtx,
      ids: opts.ids,
      market: opts.market,
      markPrice,
      clock: this.clock,
      journal: this.sink,
    });

    const runnerPorts: HostRunnerPorts = {
      gate,
      oms: this.oms,
      sessionRisk: this.sessionRisk,
      escalator,
      clock: this.clock,
      journal: this.sink,
      journalHealthy: () => this.writer.healthy(),
      latency: this.latency,
    };
    this.runner =
      opts.runnerFactory !== undefined
        ? opts.runnerFactory(runnerPorts)
        : new StrategyRunner({
            sessionId: opts.sessionId,
            strategy: opts.strategy,
            params: opts.params,
            market: opts.market,
            gate,
            oms: this.oms,
            stopEngine: new StopEngine({ ids: opts.ids, tickSizePaise: opts.market.tickSizePaise }),
            sessionRisk: this.sessionRisk,
            ids: opts.ids,
            clock: this.clock,
            view: opts.marketData,
            eligibility: opts.eligibility,
            todayDate: opts.date,
            journal: this.sink,
            journalHealthy: () => this.writer.healthy(),
            latency: this.latency,
            escalator,
            ...(opts.regime !== undefined ? { regime: opts.regime } : {}),
            ...(opts.cooldownSec !== undefined ? { cooldownSec: opts.cooldownSec } : {}),
          });

    const sessionBox: { session?: SessionManager } = {};
    this.kill = new KillSwitch({
      sessionId: opts.sessionId,
      target: this.runner,
      oms: this.oms,
      gate,
      gateContext: killGateCtx,
      ids: opts.ids,
      market: opts.market,
      markPrice,
      clock: this.clock,
      journal: this.sink,
      escalator,
      notify: (event) => sessionBox.session?.onKill(event),
      ...(opts.feedStaleMs !== undefined ? { feedStaleMs: opts.feedStaleMs } : {}),
    });

    this.session = new SessionManager({
      sessionId: opts.sessionId,
      mode: this.mode,
      date: opts.date,
      market: opts.market,
      target: this.runner,
      flattenPorts: () => ({
        sessionId: opts.sessionId,
        oms: this.oms,
        gate,
        gateContext: killGateCtx,
        ids: opts.ids,
        market: opts.market,
        markPrice,
        clock: this.clock,
        journal: this.sink,
        protectTicks: 5,
        // Square-off exits ride the same reprice→market ladder as stop/kill
        // exits — a resting square-off limit must be chased, never abandoned.
        escalator,
      }),
      preflight: {
        resolveChain: opts.resolveChain ?? (() => this.defaultChain()),
        lastTickTs: opts.preflightLastTickTs ?? (() => opts.marketData.lastSpotTs()),
        feedStaleMs: opts.feedStaleMs ?? 5_000,
        killSelfTest: () => this.kill.selfTest(),
        journalReady: () => this.writer.ready(),
        configs: opts.configs,
      },
      clock: this.clock,
      journal: this.sink,
    });
    sessionBox.session = this.session;

    this.reconciler = new Reconciler({
      oms: this.oms,
      adapter: opts.broker,
      kill: this.kill,
      clock: this.clock,
      journal: this.sink,
    });

    // Spot 1m bars → journal (UI chart + ATR/codex features read them).
    opts.marketData.setBarSink((bar) => this.sink('md.bar', { bar }));
  }

  /** Single journal sink: append (truth) → mirror to memory/gateway → fan-outs. */
  private sink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]): void => {
    let ev: JournalEvent;
    try {
      ev = this.writer.append(type, payload);
    } catch (err) {
      // A latched journal failure must never strand an open position: the
      // writer latches + journalHealthy() already blocks NEW entries, but the
      // exit path journals before it submits — keep the event flow alive so
      // stops/kill/square-off can still get flat. seq -1 marks unpersisted.
      if (!this.journalBroken) {
        this.journalBroken = true;
        console.error('[scalper] journal write failed; entries blocked, exits continue:', err);
      }
      ev = { seq: -1, ts: this.clock.now(), type, payload } as JournalEvent;
    }
    this.events.push(ev);
    if (this.db !== undefined) {
      try {
        mirrorEvent(this.db, ev);
      } catch (mirrorErr) {
        // Journal stays the source of truth; a mirror failure must never
        // touch the trading path. Surface it once, keep mirroring the rest.
        if (!this.mirrorBroken) {
          this.mirrorBroken = true;
          this.sink('diag.error', { where: 'host.mirror', message: `sqlite mirror failed: ${String(mirrorErr)}` });
        }
      }
    }
    this.opts.gateway?.ingestJournal(ev);
    if (ev.type === 'order.updated' && ev.payload.order.state === 'REJECTED') {
      this.kill.noteReject(ev.ts); // reject-storm auto trip
    }
    if (ev.type === 'trade.completed') {
      this.runner.onTrade(ev.payload.trade);
      this.reconcileNow(); // reconcile after every completed round trip
    }
  };

  private maybeReconcile(nowMs: number): void {
    if (nowMs - this.lastReconcileMs < this.reconcileEveryMs) return;
    this.lastReconcileMs = nowMs;
    this.reconciler.reconcile();
  }

  /** Push the derived gateway slices the journal can't keep fresh (01 §3.1). */
  private publishGateway(nowMs: number): void {
    const gw = this.opts.gateway;
    if (gw?.publishState === undefined) return;
    const rp = this.opts.riskProfile;
    const snap = this.latency.snapshot();
    const staleMs = this.opts.feedStaleMs ?? 5_000;
    const noTrade = this.runner.lastNoTrade();
    const slices: GatewayStateSlices = {
      health: {
        feedStatus: this.lastTickTs === 0 ? 'DISCONNECTED' : nowMs - this.lastTickTs > staleMs ? 'STALE' : 'CONNECTED',
        lastTickTs: this.lastTickTs,
        gatewayTs: nowMs,
        ...(snap.total.count > 0 ? { latency: toGatewayLatency(snap) } : {}),
      },
      risk: {
        snapshot: this.sessionRisk.current(),
        limits: {
          dailyMaxLossPaise: Math.round(rp.capitalPaise * (rp.dailyMaxLossPct / 100)),
          perTradeRiskPaise: Math.round(rp.capitalPaise * (rp.perTradeRiskPct / 100)),
          maxTradesPerDay: rp.maxTradesPerDay,
          maxConcurrentPositions: rp.maxConcurrentPositions,
        },
      },
      chain: this.opts.marketData.chainRows(),
      algo: {
        strategyId: this.opts.strategy.id,
        lifecycle: this.runner.state(),
        params: this.runner.activeParamsSnapshot(),
        ...(noTrade !== undefined ? { lastNoTradeReason: noTrade } : {}),
        ...(this.runner.mmState !== undefined ? { mm: this.runner.mmState() } : {}),
      },
    };
    gw.publishState(slices);
  }

  private isHeld(instrumentId: InstrumentId): boolean {
    return this.oms.getPositions().some((p) => p.instrumentId === instrumentId && p.state !== 'CLOSED' && p.qty > 0);
  }

  private async recoverIfPresent(): Promise<RecoveredState | undefined> {
    if (!existsSync(this.journalPath)) return undefined;
    return recoverFromJournal(this.journalPath, { riskProfile: this.opts.riskProfile, strictSeq: false });
  }

  private defaultChain(): WeeklyChainResult {
    const rows = this.opts.marketData.chainRows();
    return {
      expiryDate: rows[0]?.expiry ?? this.opts.date,
      chain: new Map(),
      lotSize: this.opts.market.contract.lotSize,
      tickSizePaise: this.opts.market.tickSizePaise,
      rowCount: rows.length,
    };
  }
}
