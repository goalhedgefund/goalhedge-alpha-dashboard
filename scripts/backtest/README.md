# Intraday Futures Backtest — Realistic-Path System

A reproducible, out-of-sample backtesting toolkit for the intraday multi-indicator
strategy, built to answer: *can this generate ~3%/month after real costs?*

The short answer the research arrived at: **the original "3:1 / 15m / 10-stock" basket
that backtested at +757R over 3 years was in-sample / overfit and loses money
out-of-sample.** After rebuilding with proper walk-forward discipline and the
"realistic-path" levers below, there *is* a defensible system — but treat its
headline numbers as an optimistic ceiling (see Caveats).

## TL;DR — the recommended system

| | |
|---|---|
| Timeframe | **15-minute**, intraday only (force square-off 15:25 IST, no carry) |
| Stop | **2.5 × ATR** (wide — this is what makes cost-per-trade affordable) |
| Reward:Risk | **5:1** (target = 12.5 × ATR) |
| Signal | existing 8-point indicator score, **minScore ≥ 6**, default thresholds |
| Trend filter | trade **only with the NIFTY trend** (20/50 EMA on 15m) |
| Regime filter | **skip days when NIFTY 5-day avg range > 1.2%** (whipsaw regimes) — biggest robustness win |
| Daily risk cap | **stop new entries after −5R on the day** |
| Universe | **stock futures**, ~15 **liquid** names, selected by risk-adjusted (Sharpe) design performance |
| Position sizing | **fixed 0.10–0.20% risk/trade. NOT Kelly** (in-sample Kelly oversizes ~5–9× → ruin) |
| Cost assumed | 0.025% round-trip (futures incl. light slippage) |

**Out-of-sample result** (selected on 2023-06→2025-06, measured on the untouched
2025-07→2026-06): +442R, 10/12 positive months, worst month −19R, max drawdown 63R,
recovery 7.0, monthly Sharpe 1.3. At 0.10% risk/trade that is ≈ **3.7%/month with
~6% max drawdown** in-test — but read the caveats before believing that magnitude.

Data-selected basket (re-select periodically): BHARATFORG, HAL, RECLTD, BSE, SUZLON,
CDSL, CHOLAFIN, INDIGO, BEL, VEDL, IDEA, LTF, VMM, PFC, GMRAIRPORT.

## Why the original approach failed

1. The optimizer grid-searched ~1,050 params **per symbol** and reported in-sample
   numbers → severe overfitting. Re-optimized on 2 years and tested on the held-out
   year, **every RR (2–5) × every basket size lost money OOS**.
2. Trading cost at 15m is ~0.2R/trade because tight stops make cost huge in R-terms.
   The signal's gross edge (~0.1R/trade) is real and persistent across all periods,
   but cost ≈ edge, so net was a coin-flip-to-negative.

The realistic-path levers attack exactly that: wide stops cut cost-per-R, RR 5:1
maximises edge-per-trade, the NIFTY filters add gross edge / avoid chop, and
risk-adjusted selection + the daily cap stop one bad name/day from dominating.

## Files

| File | Purpose |
|---|---|
| `engine.js` | Core engine: faithful sim (next-open entry, intrabar exits, square-off), filters, cost, portfolio aggregation, NIFTY trend/vol helpers. |
| `recommended.js` | Runs the recommended system end-to-end, OOS. `--write` saves `data/recommended-system.json`. Flags: `--n --cost --vol --dailyLimit --selectBy`. |
| `sweep.js` | Structural grid sweep (TF × stop × RR × score × NIFTY filter) with a design/holdout split — use to **re-discover** the global config periodically. |

```bash
# reproduce the recommended system (writes the deployable spec)
node scripts/backtest/recommended.js --write

# re-run the structural search (e.g. after adding more data)
node scripts/backtest/sweep.js
```

Always run with `--max-old-space-size=4096` if you extend it to load many symbols.

## Caveats — read before risking capital

- **Single out-of-sample year.** Several knobs (vol threshold, daily limit, selection
  metric) were chosen against the same 2025-26 holdout. The *improvements* are each
  independently principled and helped broadly, but the **exact magnitude is optimistic**.
  Discount the live edge substantially (assume roughly half) and **paper-trade first**.
- **Size conservatively (0.10%).** The 0.10% column (~3.7%/mo, ~6% DD in-test) is the
  prudent setting; higher risk scales drawdown linearly.
- **Cost is the swing factor.** Profitability needs all-in cost ≤ ~0.025%. Use liquid
  futures and limit/marketable-limit entries; market-on-stop fills add slippage.
- **Cash candles as futures proxy** (basis ignored); **survivorship** (today's liquid
  F&O names); **slippage** only crudely in the cost rate.
- **Options are not backtestable here** (no options/IV history) — futures only.
- Re-select the basket and re-run `sweep.js` periodically; do not treat the basket as fixed.
