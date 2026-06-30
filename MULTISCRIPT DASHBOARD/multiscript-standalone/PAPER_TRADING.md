# Paper-Trading the Recommended System

This wires the **backtested realistic-path system** into this dashboard for
**forward / paper testing** — validate in REPLAY first, then run live-paper.

## ⚠️ Why this is needed (important)

The dashboard's default `signal.engine.js` uses an **SMA/slope/RSI** score. The
system that was actually backtested uses a different **8-indicator score**
(RSI, MACD, Stochastic, CCI, Williams %R, EMA9>EMA21, Bollinger %B, ADX) — the
same engine as the optimizer in `D:\CODEX\server\lib`. **Running the dashboard
unchanged would paper-trade a different strategy than the one validated.**

So a faithful port was added: `server/engines/signal.scalper.js` (verified to
reproduce the backtest signal bar-for-bar) + `server/engines/regime.filter.js`
(NIFTY trend + high-vol-day gate). They activate behind a flag — default OFF.

## What was added (all non-destructive)

| File | Purpose |
|---|---|
| `server/engines/signal.scalper.js` | Backtested 8-indicator signal (drop-in for scoreSeries) |
| `server/engines/regime.filter.js` | NIFTY trend + high-vol-day gate (reads `data/regime/nifty-regime.json`) |
| `server/engines/strategy.engine.js` | **modified**: uses scalper + regime gate **only when `SCALPER_ENGINE=1`** |
| `data/optimized/symbol-configs.recommended.json` | 15-name basket overrides (15m, sl 2.5, tp 12.5, RR 5, minScore 6) |
| `data/watchlist.recommended.json` | the 15-name basket, 15m enabled |
| `data/regime/nifty-regime.json` | NIFTY trend map + high-vol days (snapshot — see Live note) |

Regenerate the three data files anytime from the backtest project:
`node scripts/backtest/recommended.js --write && node scripts/backtest/export-to-dashboard.js`

## The recommended system (recap)

15m · 2.5× ATR stops · 5:1 RR · score ≥ 6 · NIFTY trend filter · skip NIFTY
high-vol days (5d range > 1.2%) · **−5R daily loss limit** · stock futures ·
**fixed 0.10–0.15% risk/trade (NOT Kelly)**.

Out-of-sample (2025-07→2026-06): +442R, 10/12 +months, worst −19R, recovery 7.0.
**Treat magnitude as optimistic** (one holdout year, several knobs tuned on it).

## Step 1 — Validate in REPLAY (do this before anything else)

1. Activate the basket (back up first):
   ```
   copy data\watchlist.json data\watchlist.backup.json
   copy data\optimized\symbol-configs.json data\optimized\symbol-configs.backup.json
   copy data\watchlist.recommended.json data\watchlist.json
   ```
   Merge the override keys from `symbol-configs.recommended.json` into
   `data/optimized/symbol-configs.json` (keep its existing `_runtime` block).
2. Start with the scalper engine on:
   ```
   set SCALPER_ENGINE=1
   .\start.ps1 -NoInstall
   ```
3. In the UI switch to **REPLAY**, set the range to **2025-07-01 → 2026-06-30**,
   run it, and compare the trade log to the backtest expectation
   (~10/12 positive months, recovery ≈ 7, worst month ≈ −19R at unit risk).
   Material divergence ⇒ stop and reconcile before risking anything.

## Step 2 — Live paper trading

1. Keep `SCALPER_ENGINE=1`. Use **futures** instruments and your broker's
   **paper/sandbox** (or smallest size). Never use Kelly — set fixed risk
   **0.10–0.15%** of capital per trade.
2. Enforce the **−5R daily loss limit** (the backtest's key drawdown control):
   stop taking new entries once the day is −5R. If the runner has no built-in
   daily cap, apply it manually / add it in `runner.engine.js`.
3. **Regenerate `data/regime/nifty-regime.json` daily** before the session — the
   committed snapshot is for replay; live needs fresh NIFTY trend + 5d-range.
4. Forward-test **2–3 months** and compare realised stats to backtest before any
   real capital.

## Revert

Unset the flag (`set SCALPER_ENGINE=`) and restore the `*.backup.json` files.
The legacy signal engine is untouched.

## Caveats

- Single OOS year + knobs tuned on it ⇒ expect roughly half the backtested edge live.
- Cost ≤ ~0.025% all-in is required — liquid futures, limit entries.
- Options are **not** validated (no options/IV history) — futures only.
- Cash candles were used as the futures proxy in the backtest (basis ignored).
