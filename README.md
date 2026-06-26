# CLAUDE — NSE Equity Scalping System

> Dhan API · 12 Indicators · Kelly Criterion · 2:1 R:R · Candlestick Charts · Backtesting

---

## Quick start (3 commands)

```bash
cd CLAUDE
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

---

## Project structure

```
CLAUDE/
├── server/
│   └── index.js          ← Express server, Dhan API proxy, backtest engine
├── public/
│   ├── index.html         ← Main dashboard
│   ├── css/styles.css     ← Dark-mode UI
│   └── js/
│       ├── indicators.js  ← 12 technical indicators (RSI, MACD, ATR, CCI…)
│       ├── chart.js       ← Candlestick renderer (raw canvas, no lib needed)
│       ├── dhan.js        ← Dhan API client (LTP, historical, search)
│       └── app.js         ← Signal engine, Kelly, state, UI
├── data/
│   ├── seed-securities.json   ← ~130 NSE stocks (fallback)
│   └── api-scrip-master.csv  ← Full Dhan master (auto-downloaded on first run)
├── backtest/              ← Backtest output CSVs
├── package.json
└── README.md
```

---

## Connecting to Dhan

1. Log in to [Dhan](https://dhan.co) → **My Profile → API Access**
2. Copy your **Client ID** and generate an **Access Token**
3. In the dashboard: paste both in the left sidebar → click **Connect**
4. Search and select any NSE stock in the symbol search box
5. Live prices start flowing immediately

> **Security note:** Your token is only sent to `http://localhost:3000/dhan/*` (your own machine). It never leaves your network.

---

## Securities master

On startup, the server automatically downloads the full Dhan security master from:
```
https://images.dhan.co/api-data/api-scrip-master.csv
```
This gives you **all NSE + BSE instruments** in the symbol search dropdown (5,000+ equities, F&O, indices).

If the download fails (e.g. first run without internet), it falls back to the 130-stock seed file in `data/seed-securities.json`.

To force a refresh:
```bash
curl -X POST http://localhost:3000/api/securities/refresh
```

---

## Signal logic (2:1 R:R enforced)

A trade fires when **6 or more of 8 primary indicators** agree:

| Indicator | Bull condition | Bear condition |
|-----------|---------------|----------------|
| RSI (14) | 52–70 | 30–48 |
| MACD | Line > 0 | Line < 0 |
| Stochastic %K | 55–85 | 15–45 |
| CCI (20) | > +50 | < −50 |
| Williams %R | > −45 | < −55 |
| EMA 9/21 cross | EMA9 > EMA21 | EMA9 < EMA21 |
| Bollinger %B | 0.5–0.9 | 0.1–0.5 |
| ADX (14) | > 22 | > 22 |

Stop loss = **1 × ATR × 1.2** from entry.  
Take profit = **2 × ATR × 1.2** from entry (always 2R).

---

## Kelly criterion

Formula: `f* = (b·p − (1−p)) / b`  where `b = 2.0` (your R:R ratio).

- Activates after **3 completed trades**
- Capped at your configured **max risk %**
- Choose Full / Half / Quarter Kelly in the sidebar

---

## Backtesting

1. Connect to Dhan
2. Select a symbol
3. Set date range in the Backtest panel (right sidebar)
4. Click **Run Backtest**

The server fetches historical candles from Dhan's `/v2/charts/historical` endpoint and runs the same signal engine server-side. Results show total trades, win rate, P&L in R, and expectancy.

---

## Requirements

- Node.js 18+
- npm 8+
- Dhan account with API access enabled
- Internet access (for Dhan API)

---

## Development mode (auto-restart)

```bash
npm run dev
```

---

## ⚠ Disclaimer

This software is for **educational and research purposes only**. It does not constitute financial advice. Paper-trade and backtest thoroughly before using real capital. Past performance of any signal system does not guarantee future results.
