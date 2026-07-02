# 02 — AI-Ready Stepwise Coding Plan

Each milestone below is a **self-contained work order**: paste it (plus `00-OVERVIEW.md` + the relevant `01-DESIGN.md` sections) into an AI coding session and it has everything it needs. Every milestone ends with green tests and a runnable demo — never more than one session of work in flight without a checkpoint.

Rules that apply to every milestone:
- TypeScript strict mode; no `any` on domain types. Tests with **vitest**; property tests with **fast-check**.
- Every new module ships with its unit tests in the same milestone. CI = `npm test` + lint + typecheck.
- All times IST epoch-ms; all money in **paise as integers** (no floating-point rupees).
- Every event type added to the journal schema in the same PR that produces it.
- Commit at every green checkpoint; milestone ends with a tagged commit `m<N>`.

---

## M0 — Scaffold
**Goal:** empty but disciplined monorepo.
**Build:** npm workspaces (`core`, `ui`); TS strict configs; vitest + fast-check; eslint; pino logger; zod config loader (`config/` schemas for market/risk/strategy profiles); typed in-proc event bus (sync dispatch, no async on hot path); git init + `.gitignore` (journals/, data/, node_modules/).
**Accept:** `npm test` green with a config round-trip test (load → validate → hash → reload → same hash).

## M1 — Domain + Journal + Persistence
**Goal:** the event backbone everything else rides on.
**Build:** `src/domain/` types (Instrument, Tick, Quote, Bar, OptionChainRow, OrderIntent, Order + state enum, Position, Trade, RiskVerdict, StopState, SessionState, all journal event types as a discriminated union); JSONL journal writer (async-buffered, rotation per session, fsync policy configurable) + reader/iterator; SQLite (better-sqlite3, WAL) schema: sessions, orders, order_events, trades, positions, config_hashes.
**Accept:** write 100k mixed events → read back → byte-identical round trip; replay iterator preserves order; SQLite mirrors match journal counts. Property test: any sequence of valid events serializes/deserializes to identical state hash.

## M2 — Charges Engine
**Goal:** to-the-paisa charges for any market via profiles.
**Build:** `src/charges/` — profile schema (list of components: name, basis [buy_premium|sell_premium|both|per_order], rate/flat, gstApplicable); `config/market/india-nse-options.json` with the table from `01-DESIGN.md §5.1`; `computeCharges(fill, profile)` and `computeTradeNet(trades[])`.
**Accept:** unit tests pinned to ≥6 hand-computed contract-note examples (long CE win, long PE loss, multi-leg day, partial fill) to the paisa; property test: net = gross − Σcomponents exactly, no drift over 10k random trades.

## M3 — Market Data Layer: Feeds + Recorder
**Goal:** normalized tick stream from three sources through one interface.
**Build:** `IFeedAdapter { connect, subscribe(instruments), onTick(cb), health() }`; `ReplayFeed` (reads recorded JSONL at wall-clock or accelerated speed, deterministic); `SynthFeed` (generated microstructure: trending/choppy/gappy regimes, configurable spread behavior — for dev without market hours); `Recorder` (normalized compressed JSONL per session); **DhanFeed port**: adapt `D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone\server\adapters\dhan\{dhan.ws.client.js, dhan.packet.decoder.js, dhan.rest.client.js}` to TS behind `IFeedAdapter`, including instrument-master load from the Dhan scrip master (NSE_FNO options rows: strikes, expiries, lot size, securityId).
**Accept:** replay determinism (same file → identical tick stream hash); SynthFeed statistical sanity tests; DhanFeed decode unit-tested against captured binary fixtures; instrument master resolves current NIFTY weekly chain (strike ladder + expiry) correctly.

## M4 — Option Chain + Analytics + Features
**Goal:** the option-aware brain food.
**Build:** chain state (per-strike quote book for ATM±N), ATM tracker (spot-driven, hysteresis so it doesn't flap), expiry roll logic; Black-76 IV solver + greeks (delta/gamma/theta/vega) off synthetic future (put-call parity) or future LTP; feature library per `01-DESIGN.md §2.2` incl. port of CODEX `signal.scalper.js` 8-indicator score; 1s/1m bar builder.
**Accept:** IV solver vs known-good published values (±1e-6); greeks sign/monotonicity property tests; chain state correct through a scripted ATM-drift replay; bar builder handles late/out-of-order ticks per policy.

## M5 — OMS + PaperBroker (system becomes end-to-end testable here)
**Goal:** orders flow, paper trades hit a file.
**Build:** order state machine with explicit legal-transition table; `clientOrderId` idempotency + event dedupe; token-bucket throttle (per-adapter config); unacked-timeout → cancel-and-verify; TTL expiry; partial-fill handling; `IBrokerAdapter` contract + **adapter conformance test suite** (any adapter must pass it); `PaperBroker`: fill model (touch ∓ slippage haircut, latency distribution, partial/reject injection knobs, simulated L0 resting stops); `journals/<date>/trades.jsonl` writer; position keeper.
**Accept:** full lifecycle tests incl. partials, rejects, timeout-cancel-verify, fill-after-cancel race; conformance suite green on PaperBroker; a scripted replay produces a deterministic trades.jsonl (hash-pinned); property test: no order reaches SENT without RISK_APPROVED (gate stubbed in M5, real in M6).

## M6 — Risk Gate + Stop Engine (the heart; most-tested module)
**Goal:** risk defined before entry, enforced in layers, never widens.
**Build:** `RiskGate.evaluate(intent) → RiskVerdict` with ordered checks (instrument whitelist, strike band, spread gate, liquidity floor, per-trade ₹ risk vs stopPlan, position/notional/lot caps incl. freeze-qty split rule, margin check via adapter, session-stop states, trade-count, throttle headroom, market-hours/blackout windows) — every rejection carries a reason code, journaled; Stop Engine per `01-DESIGN.md §4`: per-position state machine (L1 hard premium+underlying, L2 breakeven ratchet + step/ATR trail, L3 time stop, L4 session stops with latching), stop-exit execution ladder (protect-limit → reprice → market); session risk state (daily loss, peak P&L give-back, streaks).
**Accept:** full trigger matrix unit tests (every layer × CE/PE × gap-through × partial-position); property tests: **stop level monotonic favorable-only**, ₹ risk at entry ≤ budget for all random intents, session halts latch until operator event; deterministic replay of a scripted "nightmare day" produces pinned journal.

## M7 — Strategy Framework + S1/S2
**Goal:** the brain, pluggable and honest.
**Build:** `IStrategy` runtime (event dispatch, 250ms timer, lifecycle DISARMED/ARMED/ACTIVE/COOLDOWN, params apply-when-flat); eligibility filter chain per `01-DESIGN.md §2.3` (each filter a pure function with reason code; port CODEX regime filter); S1 momentum-burst and S2 vwap-fade per §2.4, both emitting complete `stopPlan`s; strategy-level attribution tagging.
**Accept:** replay run journals signals with no-trade reasons for every eligible tick window; end-to-end on replay: intent → gate → paper fill → trail → exit, with net-of-charges attribution in the digest; determinism: same replay → same trades hash.

## M8 — Gateway + Mission-Control UI
**Goal:** eyes and hands.
**Build:** `src/gateway/` ws server: versioned state tree, snapshot+sequenced-delta protocol (100ms batches), heartbeats, resnapshot-on-gap; command channel (`commandId` + ack; ARM/DISARM/KILL/REARM/SET_PARAMS/ACK_PREFLIGHT), commands journaled; `ui/` React console with all panels from `01-DESIGN.md §1.1` (mode banner, health HUD, kill switch, risk meters, positions+stop ladder, chain strip, underlying chart, blotter, event stream, algo panel with "why not trading now"); `.claude/launch.json` entries for core (replay mode) + ui dev server.
**Accept:** Playwright: UI reconstructs full state after refresh mid-replay; seq-gap forces resnapshot; command ack round-trip; kill button two-step works. Manual demo: drive a replay session and watch it live.

## M9 — Kill Switch + Session Lifecycle + Reconciliation
**Goal:** the platform can defend itself and run a whole day unattended.
**Build:** kill switch per `01-DESIGN.md §6` (manual paths, auto trips wired to health monitors, flatten ladder, lock/re-arm with typed confirmation, notify hook); session lifecycle: preflight checklist (instrument master + expiry roll, feed freshness vs NTP, charges profile hash, risk profile load + operator ACK, **kill-switch self-test**, disk headroom) — failure blocks ARM; square-off scheduler (entry cutoff, hard flatten); reconciliation loop (interval + on-event diff vs adapter, amber/red escalation, auto-kill on position mismatch); crash recovery (restart mid-session → journal replay + reconcile → resume or safe-halt).
**Accept:** chaos suite from `03-TESTING-PLAN.md §4` green (feed freeze trips kill while positioned; reject storm trips; recon mismatch trips; crash/restart recovers state exactly); preflight blocks ARM on each injected failure; kill self-test runs at every session start.

## M10 — Hardening + Paper Go-Live
**Goal:** production posture on paper.
**Build:** hop-timestamp latency instrumentation + HUD histograms + CI benchmark (tick→order p99 < 5ms budget, regression-failing); multi-day soak runner (replay N recorded sessions back-to-back; memory/GC assertions); daily digest report (md + optional xlsx); operator runbook finalization (`04-RUNBOOK.md`); Recorder scheduled for every live session (DhanFeed) to grow the corpus.
**Accept:** full test pyramid green in CI; soak run clean (no leak, journal integrity); first **live-data paper session** end-to-end with digest + trades.jsonl reviewed.

## M11 — *(post-decision)* Live Broker Adapter
**Goal:** first real wire, only after paper gates pass and broker is chosen.
**Build:** `<Broker>Adapter implements IBrokerAdapter` (orders, modifies, cancels, positions, margins, order-update stream); pass the **adapter conformance suite** + recorded-fixture tests; L0 resting-stop support; rate limits from broker docs into throttle config; India compliance checklist executed (`04-RUNBOOK.md §5`: algo registration if required, static IP, algo tagging); staged rollout: 1 lot × reduced limits × tightened kill thresholds.
**Accept:** conformance green; go-live gates in `03-TESTING-PLAN.md §10` all signed off.

---

## Python research sidecar (parallel track, anytime after M1)
`research/` venv (pandas, numpy, scipy, matplotlib, jupyter). Loaders for journals/SQLite + recorded ticks. Deliverables: walk-forward validation notebooks, charge-sensitivity studies (edge vs cost per prior CODEX findings), strategy param studies. **Interface = files only.** Findings return to the core exclusively as config/strategy changes that must pass the 03 §10 gates.
