# 03 — End-to-End Testing Plan

Test pyramid, bottom-up. Layers 1–7 run in CI on every commit; 8–9 nightly/pre-release; 10 is the human go-live gate. Naming: every test cites the requirement it pins (e.g., `stops/L2.ratchet.monotonic`).

---

## 1. Unit tests (per module, written in the same milestone as the code)

- **Charges:** each `india-nse-options` component against hand-computed contract-note examples, to the paisa; buy vs sell asymmetry (STT sell-only, stamp buy-only); GST base composition; zero-brokerage default; a second dummy market profile proves genericity.
- **Stop Engine trigger matrix:** every layer (L1 premium, L1 underlying, L2 breakeven, L2 step-trail, L2 ATR-trail, L3 time, L4 daily-loss, L4 give-back, L4 streak) × {CE, PE} × {full, partial position} × {normal move, gap-through}. Assert trigger price, exit ladder behavior, journal reason codes.
- **OMS transition table:** every legal transition; every illegal transition throws + journals a diagnostic; idempotent resubmission; duplicate/out-of-order ack dedupe; TTL expiry; timeout-cancel-verify; partial-fill accounting.
- **Risk Gate:** each check in isolation (pass + each failure reason code); check ordering (first failure short-circuits); freeze-quantity order splitting; ₹-risk-vs-stopPlan arithmetic.
- **Analytics:** Black-76 IV vs published values; greeks signs and monotonicity; ATM tracker hysteresis; bar builder with late/out-of-order ticks.
- **Throttle:** token bucket at burst, sustained, and multi-window (per-second/minute/day) limits.
- **Journal:** write/read round-trip; rotation; buffered-write flush on shutdown signal.

## 2. Property-based tests (fast-check)

- **Stop monotonicity:** for any random sequence of ticks/updates, a position's stop level never moves adversely. (The single most important invariant in the system.)
- **Risk ceilings:** for any random intent stream, positions/notional/lot counts never exceed configured limits; no order without `RISK_APPROVED`.
- **Money conservation:** net P&L = gross − Σ itemized charges exactly, over any random trade set (integer paise).
- **Replay determinism:** any generated event sequence → replay twice → identical state hashes.
- **Session latches:** once a session stop (daily loss / give-back / streak) latches, no random event sequence un-latches it without an operator event.

## 3. Integration tests (scripted tick fixtures through the real pipeline)

- Feed → features → strategy → gate → OMS → paper fill → journal → SQLite, asserting the full artifact chain for: clean entry+trail+exit; entry with partial fill (stop sized to filled qty, remainder cancelled); intent TTL expiry (no orphan orders); spread-gate rejection mid-signal; square-off flatten with open position; end-of-day digest correctness (gross→charges→net waterfall).
- Gateway: snapshot correctness against engine state at random points; delta stream reconstructs state (hash compare); command ack semantics.

## 4. Chaos / fault-injection suite (paper mode, the "angry desk" tests)

Each scenario is scripted, repeatable, and asserts *specific* defensive behavior:

| Injection | Required behavior |
|---|---|
| Feed freeze while holding a position | staleness trip → kill sequence → flat + locked within budgeted time |
| Feed flap (connect/disconnect storm) | no duplicate subscriptions, no tick double-processing, health amber |
| Reject storm (N rejects/min) | auto kill trip; no retry loop hammering the adapter |
| Duplicate acks / out-of-order fills | state machine unaffected (dedupe), journal notes anomaly |
| Fill-after-cancel race | position correct, no orphan; reconciliation clean |
| Adapter timeout on cancel | cancel-and-verify escalation; alarm if unverifiable |
| Process kill −9 mid-position, restart | journal replay + reconciliation recovers exact state; resume or safe-halt per config |
| Clock skew injection | preflight/runtime detection trips before trading continues |
| Journal disk-full | trading halts safely (never trades blind), clear operator error |
| Reconciliation mismatch (adapter book ≠ internal) | amber → red → auto-kill per config |

## 5. Market-scenario suite (scripted synthetic markets with expected-behavior assertions)

Opening spike · slow grind (time stops dominate) · V-reversal (ratchet locks profit) · **gap-through-stop** (exit ladder reaches market within N ms, loss bounded and reported honestly) · spread blowout (gate blocks entries; open position may still exit) · circuit-limit move · expiry-afternoon premium decay (theta-aware behavior, square-off correctness) · flat dead market (zero trades is the *correct* output — asserted).

## 6. Latency benchmarks (CI, regression-failing)

- Tick-in → order-out p50/p99 vs **5 ms p99 budget** on replayed high-rate bursts (≥5k ticks/s synthetic).
- Per-hop assertions (`t_recv→t_features→t_signal→t_risk→t_sent`) so a regression names its hop.
- GC pause tracking during burst; gateway backpressure test proves UI load cannot slow the hot path.

## 7. Determinism / golden-session CI

- Golden recorded session + pinned config → replay must produce byte-identical journal hash on every commit. Any diff = a behavior change that must be explicitly re-pinned in review. This is the platform's anti-regression backstop.

## 8. UI end-to-end (Playwright)

Kill-switch flow (arm → trip → locked → typed re-arm) · refresh mid-session reconstructs state · seq-gap forces resnapshot · mode banner correctness (paper/live flag) · risk meters vs injected state · "why not trading now" surfaces the right reason code · blotter drill-down to raw journal events.

## 9. Soak

≥5 full recorded sessions replayed back-to-back at accelerated speed, then 1 at wall-clock: flat memory profile, no handle leaks, journal integrity (counts + hash), SQLite/journal consistency, digest per session.

## 10. Acceptance gates — paper → live (human sign-off, pre-registered)

Written down **before** paper starts, so results can't be renegotiated to fit (per the desk's OOS-honesty rule):

1. **≥15 live-data paper sessions** (DhanFeed) with zero reconciliation mismatches, zero unhandled rejects, zero manual interventions for platform (not strategy) reasons.
2. **Weekly kill-switch drill** executed and journaled; flatten-time within budget every drill.
3. **Latency:** live-data internal p99 within budget; order RTT distribution recorded (paper-simulated + later real).
4. **Strategy gate (per strategy, pre-registered thresholds):** net-of-charges expectancy > 0 over the paper window with a minimum trade count; max drawdown within its risk profile; performance attribution reviewed (edge vs spread vs slippage vs charges decomposition). A strategy failing the gate does **not** go live — the platform can go live with strategies disarmed only for further paper.
5. **Compliance checklist complete** (04-RUNBOOK §5) once a live broker is selected.
6. **Staged rollout:** first live week = 1 lot, halved daily-loss limit, tightened kill thresholds; review before scaling.
