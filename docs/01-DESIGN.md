# 01 — Detailed Subsystem Design

Everything here is v1 scope unless marked *(later)*. Cross-references: build order in `02-CODING-PLAN.md`, tests in `03-TESTING-PLAN.md`, operations in `04-RUNBOOK.md`.

---

## 1. Front End — Mission Control Console

Stack: **React + Vite + TypeScript**, `lightweight-charts` (TradingView OSS) for charting, native WebSocket client. Dark, dense, single-screen. Fully-automated control model → the UI's job is **situational awareness and control authority**, never order entry.

### 1.1 Panels

1. **Mode banner** — full-width, impossible to miss. `PAPER` (blue) / `LIVE` (red), session state (`PREFLIGHT / OPEN / SQUARE-OFF / CLOSED`), strategy `ARMED / DISARMED / COOLDOWN`.
2. **Health HUD** — feed status + last-tick age (ms), tick rate, internal latency tick→order (p50/p99 rolling), order RTT, gateway WS state, reconciliation state (green/amber/red), clock skew, journal disk headroom. Any red is pre-kill territory and visually loud.
3. **KILL SWITCH** — large, red, always visible. Two-step (click + 1s hold) plus keyboard chord. When auto-tripped, shows trip reason + timestamp + the re-arm procedure.
4. **Risk dashboard** — meters: daily loss vs limit, give-back (drawdown from day's peak P&L), trades used / max, loss streak, current per-trade risk ₹, margin usage. Limits come from the active risk profile; usage from live session state.
5. **Positions & stops** — per position: entry, LTP, qty, gross P&L, **net P&L after charges**, and the **stop ladder**: hard stop level, current trailed stop, breakeven-ratchet state, time-stop countdown, distance-to-stop in ticks and ₹.
6. **Option chain strip** — ATM±5 strikes both sides: LTP, bid/ask + spread (abs and % of premium), IV, OI, volume. Highlights strikes the algo is watching or holding; grays out strikes failing the spread/liquidity gate.
7. **Underlying chart** — NIFTY spot/synthetic-future 1-min candles, VWAP + bands, regime state ribbon, entry/exit markers.
8. **Blotter** — orders tab (full state history per order, expandable to raw journal events) and trades tab (itemized charges per trade).
9. **Event stream** — live tail of significant events: signals, **risk rejections with reason codes**, stop movements, reconciliation results, kill events.
10. **Algo panel** — active strategy + params (read-only while armed; edits queue and apply only when flat), all regime/filter states, and the always-on **"why not trading now"** line (the top-most failing eligibility condition, e.g. `SPREAD_GATE: 24500CE spread 2.1% > 1.5% max`).

### 1.2 UI rules

- UI is **stateless**: full state arrives as snapshot on connect, then sequenced deltas. Refresh mid-session loses nothing.
- Every panel shows a staleness indicator if its data is older than its refresh contract.
- Sounds: fill, stop hit, session halt, kill. Paper mode uses distinct (softer) sounds.
- No trading-affecting action without an acked command round-trip (§3.2).

## 2. Scalper Brain — Strategy Engine

Framework first, edge second. No strategy reaches live without the gates in `03-TESTING-PLAN.md §10`.

### 2.1 `IStrategy` contract

```ts
interface IStrategy {
  id: string; version: string;
  onTick(ctx: StrategyCtx, tick: Tick): void;
  onBar(ctx: StrategyCtx, bar: Bar): void;          // 1s and 1m bars provided
  onOrderUpdate(ctx: StrategyCtx, ev: OrderEvent): void;
  onPositionUpdate(ctx: StrategyCtx, ev: PositionEvent): void;
  onTimer(ctx: StrategyCtx, now: EpochMs): void;    // 250ms cadence
  onSessionEvent(ctx: StrategyCtx, ev: SessionEvent): void;
}
```

- Strategies are **pure decision logic**: they read `ctx.features`, `ctx.chain`, `ctx.position` and emit `ctx.propose(intent)` — they cannot touch the OMS. `OrderIntent = { side, instrument, qty, type: MKT_PROTECT|LIMIT, limitPrice?, ttlMs, tag, stopPlan, confidence }`. The `stopPlan` (hard stop levels, trail params, time stop) is mandatory — an intent without a complete stop plan is rejected at the gate.
- Strategy lifecycle: `DISARMED → ARMED → ACTIVE(position open) → COOLDOWN → ARMED`. Param changes and re-arms only when flat.

### 2.2 Shared feature library (computed once in marketdata)

Underlying: micro-momentum (1s/5s/30s returns), VWAP + σ bands, ATR(1m), tick-velocity/volume bursts, day structure (opening range, prior day levels).
Options: premium velocity, bid/ask imbalance, spread state (abs, % of premium, stability), IV per strike (Black-76), delta/gamma/theta/vega, ATM drift rate.
Ported: the CODEX 8-indicator score (`signal.scalper.js`: RSI, MACD, Stoch, CCI, Williams %R, EMA9>21, Bollinger %B, ADX) exposed as `features.codexScore` on the underlying.

### 2.3 Regime & eligibility filters (evaluated before any strategy logic)

Config-driven chain; **first failure short-circuits and is journaled + shown in UI**:
time-of-day windows (default: no entries 09:15–09:20 and after 15:00) → event blackout calendar (RBI/Fed/budget days; expiry-day special mode) → volatility regime gate (port of CODEX high-vol-day block) → NIFTY trend gate (port of regime.filter.js) → **spread gate** (strike spread ≤ X% of premium; the #1 scalping cost) → liquidity floor (min OI + min volume) → strike band (only ATM±N tradable).

### 2.4 v1 reference strategies (long-only CE/PE)

- **S1 Momentum burst:** underlying impulse (return + tick-velocity z-score) + option premium confirmation + order-flow imbalance filter → buy ATM/ITM1 in impulse direction; exits owned by Stop Engine (trail + time stop). Designed hold: seconds to a few minutes.
- **S2 VWAP fade:** stretch beyond outer VWAP band with fading momentum → buy the opposite-side option; tighter time stop; disabled in trending regime.

Both are reference implementations to validate the platform and are **expected to be cost-challenged** (prior research: intraday cost ≈ edge). Their honest net-of-charges performance in paper is a *deliverable*, not a disappointment.

## 3. Wiring — Front End ↔ Back End Sync

### 3.1 State fan-out (server → UI)

- Gateway holds a **versioned state tree**: `{ session, health, risk, positions, orders, trades, chain, algo, events }`.
- On WS connect: full **snapshot** `{ seq, state }`. Then **deltas** `{ seq, path, value }` batched every 100 ms (hot-path never waits on the gateway; it posts to a queue).
- Client detects a seq gap → requests resnapshot automatically. Heartbeat both directions every 2 s; missed heartbeats flip the UI to STALE overlay.

### 3.2 Commands (UI → server)

- `{ commandId, type, payload, issuedAt }` over WS (REST fallback). Server acks `{ commandId, accepted|rejected, reason }` and the resulting state change arrives as a normal delta — the UI never assumes success.
- v1 command set: `ARM`, `DISARM`, `KILL`, `REARM(confirmToken, reason)`, `SET_PARAMS(strategyId, params)` (queued until flat), `ACK_PREFLIGHT`.
- Commands are journaled like every other event, with origin (UI/CLI/auto).

## 4. The Stoploss Engine (layered, strict, never widens)

Per-position **stop state machine**; deterministic; the most property-tested module in the system. All layers are active simultaneously; first trigger wins; every stop decision journals its trigger reason.

| Layer | What | Detail |
|---|---|---|
| **L0** | Broker-resting catastrophic stop *(live)* | Real SL order resting at broker/exchange immediately after entry fill, at the hard-stop level. Survives our process dying. PaperBroker simulates the resting order so the code path is identical. |
| **L1** | Software hard stop | Premium-based (−X% or −₹Y from entry) AND underlying-based (spot beyond invalidation level) — whichever fires first. Defined in the intent's `stopPlan` **before entry**; Risk Gate rejects intents whose implied ₹ risk exceeds the per-trade budget. |
| **L2** | Trailing ratchet | Breakeven move after +B; then step-trail locking a % of open profit per +T step, or ATR-trail. **Monotonic invariant: stop may only move favorably** — enforced in code, property-tested, and any violation attempt trips diagnostics. |
| **L3** | Time stop | Scalps must prove themselves: exit if neither stopped nor target within N seconds (per-strategy config). Countdown visible in UI. |
| **L4** | Session stops | Daily max loss (halt + disarm), give-back stop (drawdown from day's peak P&L), loss-streak breaker (N consecutive → cooldown M min), max trades/day. All latch until operator action. |
| **L5** | Kill switch | §6. |

**Stop execution:** trigger → **market-with-protection** exit (limit at LTP ∓ protection ticks) with an escalation ladder: reprice after T₁ ms → wider reprice after T₂ → pure market. Gap-through-stop is a first-class scenario test.

## 5. Order & Trade Flow — OMS

The most-tested code in the system (see 03 §1–§4).

- **State machine:** `DRAFT → RISK_APPROVED → SENT → ACKED → PARTIAL → FILLED | REJECTED | CANCELLED | EXPIRED` with an explicit legal-transition table; an illegal transition throws, journals, and raises a diagnostic alarm.
- **Idempotency:** unique `clientOrderId` per order; resubmission impossible by construction; adapter acks/fills deduped by (clientOrderId, event type, broker event id).
- **Timeout policy:** unacked after T ms → **cancel-and-verify** (never fire-and-forget); entry limit orders expire on intent TTL.
- **Throttle:** token bucket per adapter (rates from adapter config, e.g. typical Indian broker limits ~10 orders/s, per-minute and per-day caps) — enforced centrally so no component can violate broker limits.
- **Partial fills:** position tracks filled qty; Stop Engine sizes to actual filled qty; remainder cancelled per policy.
- **Reconciliation loop:** every N s and after every order event: diff internal orders/positions against `adapter.getOrders()/getPositions()`. Mismatch → amber; **position mismatch → kill-switch trip** (configurable). PaperBroker reconciles against its own book so the path is exercised daily.
- **Square-off scheduler:** entries blocked after cutoff (default 15:00 IST); hard flatten window (default 15:12) safely ahead of broker auto-square-off; both from the market profile.

### 5.1 Charges engine

Config-driven market profile; every trade stores gross P&L + itemized charges + net P&L. **All defaults must be re-verified against a current broker contract note at go-live** (rates drift).

`india-nse-options` (defaults as configured, per current schedule):
| Component | Basis | Default |
|---|---|---|
| STT | sell-side premium | 0.1% |
| Exchange txn charge (NSE) | premium, both sides | 0.03503% |
| SEBI turnover fee | premium, both sides | ₹10/crore |
| Stamp duty | buy-side premium | 0.003% |
| IPFT (NSE) | premium, both sides | per NSE schedule (config line) |
| GST | 18% on (brokerage + txn + SEBI) | 18% |
| Brokerage | per order | **0 (excluded per mandate; configurable)** |

Generic: adding a market = new profile file (e.g., US: SEC fee, ORF, OCC). Unit tests pin each component to hand-computed contract-note examples to the paisa.

## 6. Kill Switch

- **Manual:** UI button (click+hold), CLI command, keyboard chord.
- **Automatic trips:** feed staleness > X s while holding a position · order reject storm (≥N/min) · reconciliation position mismatch · session-stop breach escalation · repeated adapter errors · watchdog heartbeat missed · clock skew > threshold.
- **Action sequence (always the same, in order):** disarm strategies → cancel all open orders → flatten all positions via protection-limit ladder → market → **lock trading** (re-arm requires typed confirmation + reason, journaled) → notify (UI klaxon; webhook/Telegram optional).
- **Engineering:** the kill module imports nothing from strategy/marketdata; exit paths are pre-resolved at session start; **self-test at every preflight** fires the full sequence against the adapter (paper-fired in live mode against a dry-run flag).

## 7. Low Latency (honest scope)

At retail scale in India, broker/exchange RTT (~50–200 ms) dominates. Our commitment: make the internal slice negligible and **measure everything**.

- **Budget:** tick-in → order-out **< 5 ms p99** internal.
- **Hop timestamps** on every decision: `t_recv → t_features → t_signal → t_risk → t_sent → t_ack` → histograms in HUD + journal; CI benchmark fails on regression (03 §6).
- Techniques: no `await`/promises on the hot path; preresolved instrument lookup maps (arrays keyed by dense ids, not string maps); binary WS frame decode straight to typed structs (Dhan decoder already does this); allocation-light tick handling; gateway/journal writes async-buffered on separate queues; GC flags tuned (`--max-semi-space-size`); UI batching at 100 ms.

## 8. Paper Trading Mode

- `PaperBroker implements IBrokerAdapter` — the OMS cannot tell it from a live adapter.
- **Fill model:** marketable orders fill at touch (buy at ask, sell at bid) ∓ slippage haircut (ticks or % of spread, configurable); ack/fill latency drawn from a configured distribution (default 80–250 ms) so timing behavior matches live; knobs to inject partials and rejects for testing; simulates L0 resting stops.
- **Trade file (hard requirement):** every order event and completed trade appended to `journals/<date>/trades.jsonl` (human-greppable), mirrored to SQLite; **daily digest** (trades, hit rate, gross → charges → net waterfall, per-strategy attribution, latency stats, max adverse excursion) as markdown + optional xlsx.
- Mode is a **startup flag, not a runtime toggle**. Separate journal directories per mode. UI banner + distinct sounds.

## 9. Cross-Cutting

- **Config discipline:** all configs zod-validated and typed; session journal records the config hash; any param change is a journaled event. Config files: `config/market/india-nse-options.json`, `config/risk/<profile>.json`, `config/strategy/<id>.json`.
- **Market profile carries the exchange facts** (verify at go-live; they drift): session 09:15–15:30 IST, NIFTY lot size (65 as configured, verified against the live Dhan scrip master 2026-07-03), freeze quantity 1950 per NSE circular, weekly expiry day per current exchange calendar (config, currently Tuesday), tick size ₹0.05, square-off defaults.
- **Time discipline:** IST exchange time everywhere; NTP check at preflight; monotonic per-source event timestamps.
- **Data capture:** Recorder writes normalized compressed JSONL ticks every session → the replay/backtest corpus grows daily. (CODEX 1-min cash candles are research inputs; scalping validation needs our own tick capture.)
- **Persistence:** better-sqlite3 (WAL) for orders/trades/positions/sessions; JSONL for the event journal; crash recovery = journal replay + reconciliation at restart (tested, 03 §4).
- **Compliance (India, go-live checklist item — not a v1 blocker):** SEBI retail algo framework requires broker/exchange registration of automated strategies above order-rate thresholds, static IP for API access, algo tagging. Owned in `04-RUNBOOK.md §5`.
- **Python research sidecar:** `research/` venv reads journals/SQLite + recorded ticks; walk-forward and charge-sensitivity studies; outputs come back only as config/strategy changes through the validation gates. Zero runtime coupling.
