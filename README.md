# AITrader

AITrader is a local, paper-only NSE equity scalping system scaffold.

## Current Scope

- Uses Dhan for market data.
- Stores 1-minute candles and paper trades in SQLite.
- Generates trades only from deterministic rules.
- Uses the AI scoring layer only as a filter.
- Does not place live broker orders.

## Watchlist

| Symbol | Dhan NSE Security ID |
| --- | --- |
| RELIANCE | 2885 |
| HDFCBANK | 1333 |
| ICICIBANK | 4963 |
| SBIN | 3045 |
| INFY | 1594 |
| TCS | 11536 |

## Setup

Runtime files are stored under `C:\NSE Monitor`.
The app reads Dhan credentials from `C:\NSE Monitor\config.py` first, then falls back to environment variables.

Expected names inside that file:

- `CLIENT_ID`
- `ACCESS_TOKEN`
- `API_KEY` optional

```powershell
pip install -r requirements.txt
```

## Run Paper Trading

```powershell
python -m AITrader.live_feed
```

## Run Dashboard

```powershell
streamlit run AITrader/dashboard.py
```

Dashboard workflow:

- click `Refresh 200DMA Candidates` to pull the near-200DMA scan from the imported universe list
- select the symbols you want to scalp
- click `Save Active Symbols`

Universe source:

- `security_id_list.csv` in the project root

## Run Backtest

```powershell
python -m AITrader.backtester --days 10
```

## Strategy Rules

Long-only entry:

- Price above VWAP
- EMA 9 above EMA 20
- RSI 14 above 55
- Close breaks previous candle high

Exit:

- Target: +0.30%
- Stop loss: -0.15%

## Important Safety Rule

The rule-based engine generates trades. The AI layer only scores or filters signals. It must not directly create buy or sell orders.
