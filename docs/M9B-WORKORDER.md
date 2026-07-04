# M9b Work Order — Session Lifecycle, Reconciliation, Crash Recovery, Chaos Suite

Self-contained brief for a fresh session. Context: M0–M8 + M9a complete.
M9a (tag `m9a`) delivered the KillSwitch (`core/src/killswitch/kill-switch.ts`):
trip sequence (disarm→cancel→flatten→LOCK), auto-trips (FEED_STALE while
positioned via `checkFeedStale`, REJECT_STORM via `noteReject`), typed re-arm,
`selfTest()`, gateway KILL/REARM commands (`registerKillCommands`), ARM lock
check, and the reserved exit throttle lane in the OMS. Read `01-DESIGN.md`
§5–§9 and `03-TESTING-PLAN.md` §4 before starting.

## Scope (delivers the rest of 02-CODING-PLAN M9)

1. **Session module** (`core/src/session/session.ts`):
   - Phase machine per domain SessionPhase: PREFLIGHT → OPEN → ENTRY_CUTOFF →
     SQUARE_OFF → CLOSED (+ HALTED/KILLED), journaling `session.phase`.
   - **Preflight checklist** (each check named, journaled, ANY failure blocks
     ARM): instrument master loaded + weekly expiry resolved
     (`resolveNiftyWeeklyChain`); feed freshness (last tick age vs clock);
     config hashes journaled (`config.loaded` ×3); risk profile loaded +
     **operator ACK required** (register ACK_PREFLIGHT gateway command);
     `killSwitch.selfTest().ok`; journal disk writable (JournalWriter.ready()).
   - **Square-off scheduler**: on timer, at market.entryCutoff journal phase
     ENTRY_CUTOFF (runner eligibility already blocks entries by window); at
     market.hardSquareOff flatten via a SQUARE_OFF-purpose path (reuse
     KillSwitch.trip? NO — square-off is not a kill: implement
     `flattenAll('SQUARE_OFF')` by extracting the flatten loop from KillSwitch
     into a shared helper both use; square-off does NOT lock, phase → SQUARE_OFF
     then CLOSED).
2. **Reconciliation loop** (`core/src/oms/reconciler.ts`): every N ms + after
   every order event, diff OMS orders/positions vs
   `adapter.getOrders()/getPositions()` (IBrokerAdapter has both). Result
   states GREEN/AMBER/RED; journal `recon.result` (dedup on state change);
   RED (position qty mismatch) → `killSwitch.trip('AUTO','RECON_MISMATCH')`.
   PaperBroker path must reconcile GREEN in normal runs (exercises the loop
   daily). NOTE: PaperBroker keeps its own position book — expect drift vs
   PositionKeeper only under injected faults; write one fault-injection test
   mutating the paper book directly.
3. **Crash recovery** (`core/src/session/recovery.ts`): given a journal path,
   `readJournal` → rebuild orders/positions/trades/session-risk state (pure
   reducer over events — reuse mirror.ts switch shape); resume JournalWriter
   with `resume: { startSeq: lastSeq+1 }`; then reconcile vs adapter; if
   mismatch → safe-halt (phase HALTED, do not ARM). Test: run half the M7 e2e
   scenario, kill writer mid-position (simulate by reopening from disk),
   recover, assert positions/risk state identical + seq continuous.
4. **Escalation ladder** (`core/src/oms/escalation.ts`): watch a submitted
   exit order; if not FILLED within T1 (e.g. 750ms) → cancel + resubmit at
   worse price (mark − 2×protectTicks); after T2 → cancel + pure MARKET.
   Wire into StrategyRunner.handleTrigger and the shared flatten helper.
   Chaos test: PaperBroker with fillLatencyMs > T1 or rejectNext forcing the
   ladder to step. (PaperBroker may need a `holdFills(instrumentId)` knob —
   add it.)
5. **Watchdog + clock skew trips**: watchdog = timer that must be petted by
   the main loop every X ms else `trip('AUTO','WATCHDOG')`; clock skew =
   |Date.now() − last exchange tick ts| > threshold while CONNECTED →
   trip('AUTO','CLOCK_SKEW') (config).
6. **Gateway/UI**: add `session: { phase, preflight: SelfTestCheck[] }` and
   `kill: { state, reason? }` slices to GatewayState (update ingest/demo/UI);
   AlgoPanel gains REARM button (prompt for reason, sends typed confirm) +
   preflight checklist panel; ModeBanner shows phase from session slice.
   Update Playwright: REARM flow spec (kill → rearm with reason → ARM works).
7. **Chaos suite** (`core/test/chaos.test.ts`) per 03 §4 — minimum: feed
   freeze mid-position trips kill; reject storm trips; recon RED trips;
   crash/restart recovers exactly; disk-full → JournalWriter failure latch
   halts trading (assert runner submit path refuses after journal failure —
   may need a `journalHealthy()` guard in runner); duplicate/out-of-order
   acks unchanged (already covered in oms.test — extend if gaps).

## Order of work (commit each green step)
1. ✅ DONE (commit 947e8f3): flatten.ts (buildFlattenIntent/cancelAllOpenOrders/
   flattenAllPositions), escalation.ts (ExitEscalator, stageTimeoutMs 750,
   repriceTicks 10, event 'exit.escalated'), KillSwitch refactored onto helpers
   (+ optional escalator), runner tracks stop exits + polls on onTimer,
   PaperBroker.holdFills(instr, count) chaos knob. 7 tests in escalation.test.ts.
2. ✅ DONE: session/session.ts (SessionManager) — phase machine
   PREFLIGHT→OPEN→ENTRY_CUTOFF→SQUARE_OFF→CLOSED (+HALTED/KILLED); preflight
   checklist (instrument.master, feed.fresh, config.loaded ×3, kill.selftest,
   journal.writable) + operator ACK, both gating canArm(); square-off reuses
   flattenAllPositions('SQUARE_OFF') via shared flatten helper, does NOT lock.
   New: session.preflight journal event, PreflightCheck domain type,
   registerSessionCommands(ACK_PREFLIGHT), canArm option on
   registerRunnerCommands. 8 tests in session.test.ts. 223 core tests green.
   NOTE: SessionManager not yet wired into demo-gateway/runtime — deferred to
   step 5 (gateway session slice) alongside the UI.
3. ✅ DONE: oms/reconciler.ts (Reconciler) — diffs OMS book vs adapter book
   (getOrders/getPositions), GREEN/AMBER/RED (RED = net position qty
   mismatch, AMBER = working-order presence drift), journals recon.result
   deduped on STATE CHANGE, RED → kill.trip('AUTO','RECON_MISMATCH') once
   (guarded by isLocked). Caller-driven reconcile() (timer + post-event wiring
   is step 5). PaperBroker.setPositionQty chaos knob for out-of-band drift.
   7 tests in reconciler.test.ts (classification, dedup, real OMS+PaperBroker
   GREEN + injected-drift RED→trip). 230 core tests green.
4. ✅ DONE: session/recovery.ts — reduceJournal (pure reducer, mirrors
   mirror.ts switch; position.closed DELETES the book so rebuilt positions ===
   Oms.getPositions(); rebuilds SessionRiskState by replaying trade.completed
   net P&L); recoverFromJournal (read→reduce→prepareJournalForResume);
   prepareJournalForResume crash-safety (torn tail truncated, valid-but-
   newline-less tail terminated) so the resumed writer never appends onto a
   torn line; reconcileRecovered(rebuilt vs adapter positions) → non-empty
   means caller must safe-halt. Extracted diffNetPositions from reconciler.ts
   (shared). 3 tests in session-recovery.test.ts (rebuild identical + seq
   continuity, torn-tail drop, reconcile mismatch). 233 core tests green.
5. ✅ DONE: gateway session/kill slices + UI + Playwright.
   - 5a (commit cf52dd6): GatewayState gains `session.preflight?: PreflightCheck[]`
     + top-level `kill: { state, reason? }` slice; Gateway.ingestJournal derives
     both from the journal (session.phase / session.preflight /
     kill.tripped→TRIPPING → kill.completed→LOCKED carrying reason →
     kill.rearmed→READY). Exported GatewaySessionState/GatewayKillState. +1
     gateway derivation test (234 core).
   - 5b (commit 08019d2): PreflightPanel (checklist + ACK_PREFLIGHT button),
     KillSwitch panel re-arm box (reason input + RE-ARM sending typed
     {confirm:'REARM',reason}, disabled until reason entered), ModeBanner kill
     badge. Demo-gateway now runs a real SessionManager: preflight→ACK→OPEN at
     boot (seeds a spot tick so feed.fresh passes; kill notify→session.onKill).
     Playwright +（a2) preflight ALL PASS + ACK, +(f) re-arm→ARM. 7 e2e green.
   NOTE: canArm NOT wired into demo runner-commands (kept ARM robust vs session
     phase; canArm gating is unit-tested in session.test.ts). Reconciler +
     recovery NOT wired into the demo runtime (they are library-tested; the demo
     is a scripted single-position loop with no drift/restart to exercise) —
     wire into the real live/paper host in M10, not the demo.
   DEFERRED to step 6: watchdog + clock-skew trips (scope item 5) — they are
     KillSwitch AUTO trips, natural to add alongside the chaos tests that
     exercise them.
6. ✅ DONE (commit b1f9752, tag `m9b`): watchdog + clock-skew AUTO trips on the
   KillSwitch (petWatchdog/checkWatchdog, checkClockSkew — future-stamped or
   in-window skew; large positive gap stays feed-staleness); JournalWriter.healthy()
   + StrategyRunner.journalHealthy? guard (refuses NEW entries as
   JOURNAL_UNHEALTHY, never gates driveStops protection); core/test/chaos.test.ts
   (10 tests: feed-freeze flat+locked, reject storm, watchdog, clock skew, recon
   RED→RECON_MISMATCH, crash→exact rebuild + gap-free resume, disk-full latch→
   entries refused). Dup/out-of-order acks covered in oms.test. 244 core tests green.

**M9b COMPLETE (tag `m9b`). NEXT: M10 hardening** — latency instrumentation
(hop timestamps → latency.sample + HUD histograms, CI budget < 5ms p99 internal),
soak test, daily digest (markdown/xlsx: trades, hit rate, gross→charges→net
waterfall, per-strategy attribution, latency, MAE), runbook (04-RUNBOOK), and the
first live-DATA paper session. Also wire Reconciler + recovery into the real
live/paper host (they are library-tested but not yet in a runtime; the demo is
not the place). Then M11 = live broker adapter (IBrokerAdapter + conformance).

## Cautions
- Do not let square-off LOCK the session (only kill locks).
- Escalation must reuse the exit throttle lane (purpose ≠ ENTRY).
- Recovery must never resume seq on a journal with a partial tail without
  truncating/accounting for it (readJournal reports `partialTail`).
- Keep KillSwitch dependency-minimal — session/recon call INTO it, never
  the reverse.
