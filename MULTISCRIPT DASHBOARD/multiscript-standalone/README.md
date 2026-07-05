# Multiscript Dashboard Live Package

Standalone local dashboard for the validated 15-minute Multiscript scalper setup.

## Validated Live-Paper Setup

- Symbols: 15 selected NSE symbols from `data/watchlist.json`
- Timeframe: 15m only
- Engine: scalper, enabled by `SCALPER_ENGINE=1`
- Risk/reward: RR 5:1, ATR SL 2.5, ATR target 12.5
- Signal threshold: `minScore=6`
- Regime filter: NIFTY 15m EMA20/EMA50 with high-volatility block
- Execution: paper trade logging only; no live broker orders are placed

## Run

1. Keep Dhan credentials in `D:\DHAN_LOGIN\.env`.
2. Copy `.env.example` to `.env` for app settings.
3. Confirm these settings remain unchanged:

```text
SCALPER_ENGINE=1
MULTISCRIPT_DEFAULT_MODE=LIVE
MULTISCRIPT_RISK_PER_TRADE=0.0015
```

4. Refresh NIFTY regime:

```powershell
.\refresh-regime.ps1
```

5. Start the app:

```powershell
.\start.ps1 -NoInstall
```

6. Open:

```text
http://127.0.0.1:3001
```

## Expected Dashboard State

- Mode should be `LIVE`.
- Runner starts as `IDLE` until you start it from the UI.
- Active legs should show only 15m entries.
- Trade logs are written under `data\trade-logs`.

## Structure

- `client/` - browser UI
- `server/` - backend feed, runner, strategy, logging
- `data/watchlist.json` - active 15-symbol universe
- `data/optimized/symbol-configs.json` - active 15m scalper overrides
- `data/regime/nifty-regime.json` - NIFTY regime snapshot
- `data/nifty-candles/` - local NIFTY 1m candle cache used to refresh regime
- `scripts/` - self-test and diagnostics

## Refresh NIFTY Regime

Run this before each live-paper day after adding Dhan credentials:

```powershell
.\refresh-regime.ps1
```

It first checks `data\nifty-candles\NIFTY\NIFTY_1m.json`, fetches only missing
dates from Dhan, merges them into the local cache, and rebuilds
`data\regime\nifty-regime.json`.
