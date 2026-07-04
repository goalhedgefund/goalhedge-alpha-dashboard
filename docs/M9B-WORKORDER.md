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
2. Session module + preflight + ACK_PREFLIGHT + square-off + tests.
3. Reconciler + auto-kill wiring + tests.
4. Crash recovery + tests.
5. Gateway slices + UI (REARM button, preflight panel) + Playwright update.
6. Chaos suite; tag `m9b`.

## Cautions
- Do not let square-off LOCK the session (only kill locks).
- Escalation must reuse the exit throttle lane (purpose ≠ ENTRY).
- Recovery must never resume seq on a journal with a partial tail without
  truncating/accounting for it (readJournal reports `partialTail`).
- Keep KillSwitch dependency-minimal — session/recon call INTO it, never
  the reverse.
