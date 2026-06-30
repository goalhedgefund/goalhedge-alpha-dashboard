# Optimization Analysis Handoff

This document summarizes the current optimization/backtesting work in the local
AI trading dashboard project. It is intended to be fed into another AI for
further analysis or improvement planning.

## Project Location

Primary working folder:

```text
D:\CODEX
```

Original/source copy:

```text
D:\Claude\CLAUDE
```

All active analysis and generated optimizer outputs referenced below are in
`D:\CODEX`.

## Generated Optimized Config Files

### 3:1 Reward/Risk

```text
D:\CODEX\data\symbol-configs.json
```

Notes:

- Main full-data optimized config.
- Contains approximately 213 instruments.
- Contains 5 timeframes per symbol:
  - `1m`
  - `5m`
  - `15m`
  - `60m`
  - `1D`
- Total expected configs: `213 x 5 = 1065`.
- Trading cost has been applied.
- This is the file used for the 3:1 filtered basket analysis.

### 2:1 Reward/Risk

```text
D:\CODEX\data\symbol-configs-3mo-rr2.json
```

Notes:

- Last-3-month optimized config.
- Contains 2:1 reward/risk optimized results.
- Contains timeframes:
  - `1m`
  - `5m`
  - `15m`
  - `60m`
- Daily timeframe was not included in this 3-month run because there were not
  enough daily bars for robust optimization.
- Trading cost has been applied.

### 1:1 Reward/Risk

```text
D:\CODEX\data\symbol-configs-3mo-rr1.json
```

Notes:

- Last-3-month optimized config.
- Contains 1:1 reward/risk optimized results.
- Contains timeframes:
  - `1m`
  - `5m`
  - `15m`
  - `60m`
- Daily timeframe was not included in this 3-month run because there were not
  enough daily bars for robust optimization.
- Trading cost has been applied.

## Historical 1-Minute Candle Data

Historical 1-minute cash-market candle data is stored here:

```text
D:\CODEX\data\futures-eligible-cash-candles
```

Folder structure:

```text
D:\CODEX\data\futures-eligible-cash-candles\<SYMBOL>\<SYMBOL>_1m.json
```

Example:

```text
D:\CODEX\data\futures-eligible-cash-candles\RELIANCE\RELIANCE_1m.json
```

Current verified count:

```text
213 symbol folders
```

Important note:

- The downloaded candle data is cash-market data.
- Symbols were selected based on whether they are traded in the NSE futures
  market, but the candle data itself is NSE cash/equity data.

## Main Scripts

### Bulk Download, Backtest, and Optimization Script

```text
D:\CODEX\scripts\futures-bulk-optimize.js
```

Purpose:

- Select futures-eligible NSE cash symbols.
- Optionally download historical 1-minute candles.
- Aggregate 1-minute candles into higher timeframes.
- Run backtests.
- Run optimization.
- Save optimized parameter configs into JSON files.

Important supported options:

```text
--universe FUTSTK
--use-cache
--timeframes 1,5,15,60,D
--target-rr 3
--config-file D:\CODEX\data\symbol-configs.json
--months 3
--write-config
--delay-ms 2000
```

### Trading Cost Post-Processing Script

```text
D:\CODEX\scripts\apply-trading-cost-to-configs.js
```

Purpose:

- Re-simulate saved optimized configs on local candles.
- Apply trading costs.
- Replace each config's `summary` with net-of-cost metrics.
- Preserve pre-cost metrics as `grossSummary`.
- Add `tradingCost` metadata to each config.

Cost rules used:

```text
1m, 5m, 15m: intraday cost = 0.03521% of turnover
60m, 1D: delivery/daily-style cost = 0.2222% of turnover
```

## Current Backtest Execution Model

The optimizer/backtest execution assumptions were updated to be more realistic.

For all optimized runs:

- Signal is detected on candle `i` after candle close.
- Entry is taken at the open of candle `i + 1`.
- Stop-loss and target checks happen intrabar using OHLC high/low.
- If both stop-loss and target are touched inside the same candle, the model
  assumes stop-loss was hit first.

For intraday timeframes:

```text
Intraday timeframes: 1m, 5m, 15m
No fresh entry after: 15:15 IST
Force square-off at/from: 15:25 IST
Carry-forward allowed: false
```

For higher timeframes:

```text
60m and 1D carry positions until stop-loss or target based on current model.
```

## What Was Done Recently

The last optimization-analysis work focused on finding a practical reward/risk
and timeframe combination from locally available data.

Completed work:

- Built and tested the bulk optimizer workflow.
- Downloaded/cached 1-minute historical cash-market candles for futures-eligible
  NSE cash symbols.
- Fixed symbol-name handling for symbols with special characters, such as:
  - `NAM-INDIA`
  - `M&MFIN`
- Added dynamic selection support for:
  - universe
  - custom symbol file
  - configurable timeframes
  - configurable reward/risk
  - configurable number of months
  - configurable output config file
- Added support for NIFTY and BANKNIFTY data handling.
- Ran optimization across:
  - `1m`
  - `5m`
  - `15m`
  - `60m`
  - `1D`
- Generated separate config outputs for:
  - `3:1`
  - `2:1`
  - `1:1`
- Applied trading-cost adjustment to generated configs.
- Compared win-rate distributions across reward/risk and timeframe variants.
- Found that trading all 213 symbols was noisy and cost-heavy.
- Shifted analysis toward filtered baskets.

## Reward/Risk Comparison Summary

Broad findings from the available backtest data:

- `1:1` produced higher win rates, especially on short timeframes.
- `2:1` improved return profile compared with `1:1` in selected cases.
- `3:1` on `15m`, when filtered to selected stronger symbols, produced the
  strongest return profile among the combinations tested.
- Trading all 213 symbols was not ideal due to excessive turnover and costs.
- A filtered basket was materially better than a broad all-symbol approach.

## Selected Working Combination

The current preferred working combination from this analysis is:

```text
Reward/Risk: 3:1
Timeframe: 15m
Trading cost: intraday cost included
Entry model: next candle open after signal candle close
Square-off: intraday positions closed by 15:25 IST
Risk model tested: fixed R per trade
```

## Selected 10-Stock Basket

The current practical 10-stock basket used for deeper analysis:

```text
CDSL
FORCEMOT
BSE
SUZLON
WAAREEENER
IREDA
KAYNES
DIXON
BHEL
COCHINSHIP
```

This basket was selected from the stronger 3:1 / 15m candidates while trying to
avoid some symbols with very high drawdown or weaker practical behavior.

## Top 20 Candidates From 3:1 / 15m Full-Data Config

The following were identified from the cost-adjusted 3:1 / 15m config:

```text
SUZLON
PAYTM
FORCEMOT
CDSL
BSE
TMPV
MAZDOCK
WAAREEENER
ANGELONE
MOTILALOFS
DIXON
NBCC
IREDA
KAYNES
SOLARINDS
BHEL
360ONE
COCHINSHIP
UNITDSPR
IRFC
```

Practical caution was raised around some high-drawdown symbols such as:

```text
PAYTM
TMPV
NBCC
UNITDSPR
```

## Six-Month Basket Result Snapshot

For the selected 10-stock basket using:

```text
3:1 RR
15m timeframe
Intraday trading cost included
January 2026 to June 2026
```

Approximate monthly net results in R:

```text
2026-01: +50.90R
2026-02: +37.12R
2026-03: +37.21R
2026-04: +34.75R
2026-05: +38.45R
2026-06: +30.52R
```

Summary:

```text
Total: +228.95R
Average month: +38.16R
Worst month: +30.52R
Positive months: 6 / 6
```

At fixed `0.10%` risk per trade, this translated roughly to:

```text
Average monthly return: about 3.82%
Worst monthly return: about 3.05%
```

## Three-Year Basket Result Snapshot

For the selected 10-stock basket over the available local 3-year data:

```text
Period: approximately 2023-06-28 to 2026-06-25
Trades: 5547
Net R: +757.90R
Positive months: 25
Negative months: 12
Average monthly R: +20.48R
Median monthly R: +18.05R
Worst monthly R: -36.27R
Best monthly R: +102.78R
Max drawdown: about 93.92R
Max concurrent open trades observed: 9
```

Risk sizing interpretation:

```text
0.10% risk/trade:
  Average monthly return: about 2.05%
  Max drawdown: about 9.39%

0.15% risk/trade:
  Average monthly return: about 3.07%
  Max drawdown: about 14.09%

0.25% risk/trade:
  Average monthly return: about 5.12%
  Max drawdown: about 23.48%

1.00% risk/trade:
  Average monthly return looks very high, but drawdown risk is extremely high.
```

Practical conclusion:

- `0.10%` risk per trade is more conservative but may miss a 2.5% monthly target.
- `0.15%` risk per trade looked closer to the 2.5% monthly target while keeping
  drawdown more reasonable than aggressive settings.
- `1%` risk per trade was found to be highly aggressive, with very large
  monthly and intramonth drawdowns.

## Example 1% Risk Per Trade Analysis

For the selected 10-stock basket:

```text
Capital: Rs 10,00,000
Risk per trade: 1%
Risk per R: Rs 10,000
Reward/Risk: 3:1
Timeframe: 15m
Trading cost: included
```

Three-year fixed-risk result:

```text
Net R: +757.90R
Approx return: +757.90%
Ending capital, fixed R model: about Rs 85.79 lakh
```

Important caveat:

- This is a fixed-risk backtest projection, not a guarantee.
- At 1% risk per trade, drawdowns were very large.
- Some months had intramonth drawdowns above 30%.
- One month showed intramonth drawdown above 60%.

## Known Caveats For Further AI Analysis

The next AI should pay special attention to:

- Survivorship bias in the selected symbol universe.
- Possible stale symbol list or corporate action impact.
- Slippage not currently modeled separately from exchange charges.
- Brokerage, STT, GST, stamp duty, and other taxes may not be fully modeled.
- Dhan candle quality and historical availability should be validated.
- The optimizer may overfit because it searches many parameter combinations.
- Walk-forward validation should be added.
- Out-of-sample testing should be added.
- Capital constraints and simultaneous trade exposure should be modeled.
- Position sizing should account for max concurrent trades.
- Liquidity and actual executable quantity should be checked per symbol.
- Same-candle stop-loss/target assumption is conservative but still synthetic.
- The current return model uses R-multiple scaling, not full portfolio-level
  cash compounding with margin, lot size, slippage, and live fill behavior.

## Suggested Next Improvements

For future optimizer improvement, consider:

- Add walk-forward optimization.
- Split data into train/validation/test windows.
- Penalize strategies with excessive turnover.
- Penalize high drawdown and unstable month-to-month behavior.
- Add slippage modeling.
- Add full Indian market transaction cost model.
- Add portfolio-level simulator with capital allocation.
- Add max simultaneous positions rule.
- Add per-symbol liquidity filter.
- Add regime filters using NIFTY/BANKNIFTY trend or volatility.
- Add monthly robustness scoring.
- Add ranking based on:
  - net R
  - profit factor
  - drawdown
  - consistency
  - number of trades
  - average cost per trade
  - month-level stability

## Most Important Files For Another AI To Inspect

```text
D:\CODEX\scripts\futures-bulk-optimize.js
D:\CODEX\scripts\apply-trading-cost-to-configs.js
D:\CODEX\data\symbol-configs.json
D:\CODEX\data\symbol-configs-3mo-rr2.json
D:\CODEX\data\symbol-configs-3mo-rr1.json
D:\CODEX\data\futures-eligible-cash-candles
```

## Bottom-Line Current Finding

Based on the current local data and assumptions, the most promising tested
combination was:

```text
3:1 Reward/Risk
15-minute candles
Filtered stock basket, not all 213 symbols
Intraday trading cost included
Entry at next candle open
No intraday carry-forward
```

The best practical basket tested so far:

```text
CDSL
FORCEMOT
BSE
SUZLON
WAAREEENER
IREDA
KAYNES
DIXON
BHEL
COCHINSHIP
```

Risk sizing should be conservative. The analysis suggested that `0.10%` to
`0.15%` risk per trade may be more practical than `1%` risk per trade, because
`1%` created very large drawdowns even though headline return looked high.
