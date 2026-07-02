# OPTION SCALPER — Platform Overview

> Desk-grade, fully-automated intraday option scalping platform.
> Market-agnostic core · India/NSE first · NIFTY weekly options v1 · Paper-first.

This is the master index of the design package:

| Doc | Contents |
|---|---|
| **00-OVERVIEW.md** (this) | Vision, locked decisions, architecture, module map, reuse map |
| **01-DESIGN.md** | Detailed subsystem design (UI, brain, risk/stops, OMS, kill switch, latency, paper mode, wiring) |
| **02-CODING-PLAN.md** | AI-ready stepwise build plan (M0–M11, each milestone a self-contained work order) |
| **03-TESTING-PLAN.md** | End-to-end testing plan (unit → property → chaos → soak → acceptance gates) |
| **04-RUNBOOK.md** | Operator runbook, session lifecycle, go-live gates, India compliance checklist |

---

## 1. Vision

A single platform that can scalp options in any market, where:

- **Risk is defined before entry, enforced in layers, and can never silently widen.**
- **Every P&L number shown anywhere is net of all applicable charges** (statutory charges modeled to the paisa; brokerage configurable, default 0 per mandate).
- **Paper and live share one code path** — the only difference is which adapter sits at the end of the wire. In paper mode every order event and trade flows to a human-readable file.
- **Everything is an event, everything is replayable.** The journal is the backtester, the debugger, and the audit trail.
- **Honesty over hope**: no strategy reaches live capital without passing pre-registered out-of-sample and paper acceptance gates. (Prior in-house research showed intraday cost ≈ edge — the platform must measure this truthfully, not hide it.)

## 2. Locked Decisions (v1)

| Decision | Choice | Consequence |
|---|---|---|
| Live broker | **Undecided — adapter interface, paper first** | `IBrokerAdapter` contract + conformance test suite; PaperBroker is the only order adapter in v1. Dhan is the *data* front-runner (working WS client already exists in D:\CODEX). |
| Control model | **Fully automated** | UI = mission control (observe / arm / disarm / kill). No manual order entry. |
| Stack | **Node.js + TypeScript core; Python research sidecar** | One language front-to-back on the hot path; Python only reads journals offline. |
| v1 instruments | **NIFTY weekly options, long-only CE/PE buying** | Max loss per trade = premium paid. No short-option margin complexity. Deepest liquidity in India. |
| Project root | `D:\Claude\scalper\` | New repo, git-init at M0. D:\CODEX and D:\Claude\CLAUDE are left untouched. |

## 3. Architecture

```
                        ┌────────────────────────────────────────────────┐
                        │              TRADING CORE (Node/TS)            │
 Broker WS/REST ──────► │ FeedAdapter → MarketData → Strategy Engine     │
 Replay files  ──────►  │   (chain, IV/greeks,          │ OrderIntents   │
 Synth feed    ──────►  │    features, regime)          ▼                │
                        │                        RISK GATE (every intent)│
                        │                               │ approved       │
                        │                               ▼                │
                        │   Stop Engine ◄──► OMS ◄──► Broker Adapter ────┼──► Live broker (later)
                        │        │            │             └ PaperBroker┼──► journals/<date>/trades.jsonl
                        │        ▼            ▼                          │
                        │   KILL SWITCH   Event Journal (JSONL) + SQLite │
                        └───────────────┬────────────────────────────────┘
                                        │ WS: snapshot + sequenced deltas
                                        │ commands: commandId + ack
                        ┌───────────────▼───────────────┐   ┌───────────────────┐
                        │  Gateway (ws) + REST          │   │ research/ (Python) │
                        │  React Mission-Control UI     │   │ reads journals/DB, │
                        └───────────────────────────────┘   │ offline only       │
                                                            └───────────────────┘
```

Principles:

1. **Single-process hot path.** Feed → features → strategy → risk → OMS → adapter with no network hop and no `await` inside the decision loop. Gateway/UI fan-out runs on a separate queue; rendering can never back-pressure trading.
2. **Risk Gate is unavoidable.** Strategies emit *intents*; only the Risk Gate can promote an intent to an order. There is no code path from strategy to OMS.
3. **Generic by config.** A *market profile* carries exchange calendar, session times, tick size, lot size, freeze quantity, charge formulas, square-off times. `india-nse-options` is the first profile; adding a market = adding a profile + a feed/broker adapter.
4. **Append-only truth.** Every tick-decision, signal, intent, risk verdict, order event, stop movement, and kill event is journaled. Replay of a journal is deterministic (CI-enforced).

## 4. Repository Layout

```
scalper/
  core/                    # trading engine — no UI dependencies
    src/domain/            # Instrument, Tick, Quote, OptionChain, OrderIntent, Order, Position, Trade, events
    src/feed/              # IFeedAdapter, ReplayFeed, SynthFeed, Recorder, DhanFeed (port)
    src/marketdata/        # instrument master, chain state, ATM tracker, IV/greeks (Black-76), feature library
    src/strategy/          # IStrategy, regime/eligibility filters, strategies/ (S1 momentum, S2 vwap-fade)
    src/risk/              # RiskGate: pre-trade checks, session risk state, limits
    src/stops/             # Stop Engine: per-position stop state machine (L0–L4)
    src/oms/               # order state machine, throttle, reconciliation, square-off scheduler
    src/exec/              # IBrokerAdapter, PaperBroker + fill model, adapter conformance suite
    src/charges/           # charges engine + market profiles
    src/killswitch/        # manual + auto trips, flatten ladder, lock/re-arm
    src/journal/           # JSONL journal writer/reader, SQLite persistence, replay
    src/session/           # lifecycle: preflight → open → trading → square-off → post-close
    src/gateway/           # ws server, snapshot/delta protocol, command channel
  ui/                      # React + Vite mission-control console (lightweight-charts)
  research/                # Python venv; notebooks; walk-forward tooling; reads journals only
  config/                  # market profiles, risk profiles, strategy params (zod-validated, hashed)
  data/                    # recorded ticks, replay fixtures, instrument master cache
  journals/                # per-session: events.jsonl, trades.jsonl, scalper.db (SQLite)
  docs/                    # this package
```

## 5. Reuse Map (audited from D:\CODEX)

| Existing asset (D:\CODEX) | Verdict | How we use it |
|---|---|---|
| `…\multiscript-standalone\server\adapters\dhan\dhan.ws.client.js` + `dhan.packet.decoder.js` | **Port** | First real `IFeedAdapter` — live NSE tick feed (binary decode already solved). Used for recording NIFTY option ticks + live-data paper trading. |
| `dhan.rest.client.js` + securities-master CSV loader | **Port** | Instrument master bootstrap (NSE_FNO strikes/expiries come from the same master). |
| `server\engines\signal.scalper.js` (8-indicator score, backtest-validated) | **Port** | One signal source inside the strategy feature library (adapted to option-scalping context). |
| `server\engines\regime.filter.js` + `data\regime\nifty-regime.json` + refresh script | **Port concept** | Regime/eligibility filter layer (NIFTY trend gate, high-vol-day block). |
| `runner.engine.js` square-off + cooldown patterns | **Inform** | Session/OMS defaults (square-off windows, post-exit cooldown). |
| Excel trade logger, vanilla-HTML dashboards | **Replace** | JSONL + SQLite journals; React mission-control UI. (Daily digest can still export xlsx.) |
| Option chain / IV / greeks / tick data / OMS / order placement | **Does not exist** | Built new (M4, M5). No order-placement code exists anywhere in CODEX — clean slate as desired. |

`D:\Claude\CLAUDE` (minimal "claude-scalping-system" Dhan equity scratch) and `D:\Claude\server` are earlier experiments — superseded, left untouched.

## 6. Roadmap at a Glance

```
M0  Scaffold ─ M1 Domain+Journal ─ M2 Charges ─ M3 Feed+Recorder ─ M4 Chain+Greeks
                                                                        │
M8 Gateway+UI ─ M7 Strategies ─ M6 Risk+Stops ─────── M5 OMS+PaperBroker┘
      │
M9 KillSwitch+Session+Recon ─ M10 Hardening+Paper go-live ─ M11 Live broker adapter (post-decision)
```

Detailed work orders: **02-CODING-PLAN.md**. Test strategy: **03-TESTING-PLAN.md**. Operations: **04-RUNBOOK.md**.
