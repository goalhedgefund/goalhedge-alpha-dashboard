# Multiscript Dashboard — Plan & Feature Reference

## Original Goal

Track 8–10 watchlist symbols without firing all Dhan requests at once and triggering `429 Too Many Requests`.

---

## Operating Model

- Keep one active state object per symbol.
- Use a central queue instead of `Promise.all` bursts.
- Run with `concurrency = 1` by default.
- Space requests by `800 ms` to `1200 ms`.
- Cache the last successful candle/LTP payload per symbol.
- If a symbol fails, keep showing its last known data and mark it `STALE`.

---

## Staggered Cycle (Original Design)

| Offset | Symbol | Request |
| --- | --- | --- |
| T+0.0s | SBIN | Fetch / simulate |
| T+0.8s | BANDHANBNK | Fetch / simulate |
| T+1.6s | DELHIVERY | Fetch / simulate |
| T+2.4s | RELIANCE | Fetch / simulate |
| T+3.2s | HDFCBANK | Fetch / simulate |
| T+4.0s | ICICIBANK | Fetch / simulate |
| T+4.8s | AXISBANK | Fetch / simulate |
| T+5.6s | TCS | Fetch / simulate |
| T+6.4s | INFY | Fetch / simulate |
| T+7.2s | TITAN | Fetch / simulate |

Then wait for the next cycle.

---

## Backoff Rules

- On `429`, pause that symbol for `30 seconds`.
- If the same symbol hits `429` again, pause it for `60 seconds`.
- If the third attempt fails, pause it for `120 seconds` and mark it `RATE LIMITED`.
- Other symbols continue running.
- Never retry all symbols together after a rate-limit event.

---

## UI States

- `RUNNING` — fresh data inside the expected cycle.
- `STALE` — using previous data because the current cycle failed.
- `RATE LIMITED` — Dhan returned `429`; symbol is cooling down.
- `PAUSED` — user paused the script or all scripts.
- `TRIGGERED` — strategy condition fired for that symbol.

---

## Why This Avoids 429s

The earlier parallel probe launched all 10 scripts together. Dhan allowed only part of that burst and returned `429` for the rest. A staggered queue reduces request pressure, isolates failures per symbol, and avoids retry storms.

---

---

# What Has Been Built

The sections below document the features that are now live in `multiscript-standalone`.

---

## API Endpoints (`/api/multiscript/*`)

### Runner Control
| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/multiscript/start` | Start the runner (accepts `activeFrames`, `tradeMode`) |
| `POST` | `/api/multiscript/pause` | Pause runner (preserves feed position in replay) |
| `POST` | `/api/multiscript/reset` | Reset to IDLE and rebuild legs |
| `GET` | `/api/multiscript/status` | Snapshot of runner state, legs, symbols, PnL |
| `GET` | `/api/multiscript/events` | SSE stream for real-time status updates |

### Mode & Range
| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/multiscript/mode` | Toggle between LIVE and REPLAY |
| `POST` | `/api/multiscript/range` | Set replay date/time range (ISO from/to) |

### Selection & Logs
| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/multiscript/selection` | Enable/disable timeframes per symbol |
| `GET` | `/api/multiscript/trades` | Fetch trades filtered by date range and timeframe |
| `GET` | `/api/multiscript/export` | Download trade workbook for a specific timeframe |

### Health
| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health/` | Returns runner state and connection state |

---

## Trading Modes

### LIVE Mode
- Connects to Dhan WebSocket for real-time price feed.
- REST API calls to Dhan for historical candles.
- EOD position closure at 15:30–16:00 IST (INTRADAY) or trade persistence (CARRY_FORWARD).
- Excel trade logging per timeframe.

### REPLAY Mode
- Uses historical candle repository with configurable speed multiplier.
- Pause/resume preserves playback position.
- Date/time range selectable from the UI.
- SSE updates fire on every tick (no separate snapshot timer).

---

## Trade Modes

| Mode | Behaviour |
| --- | --- |
| `INTRADAY` | All open positions closed automatically at EOD (15:30–16:00 IST) |
| `CARRY_FORWARD` | Open positions persisted to `active-trades.json` and restored next session |

---

## Runner & Leg System

- Supports up to N symbols × 5 timeframes (`1m`, `5m`, `15m`, `60m`, `1D`).
- Each leg has independent enabled/disabled state and configuration.
- One **primary timeframe** per symbol drives the aggregated card display.
- Candle refresh loop checks due legs based on per-frame refresh intervals.
- Merges live LTP into forming candles for display — trade decisions made only on **closed** candles.

---

## Signal & Risk Engine

### Technical Indicators
- Simple Moving Averages (fast/slow, customisable periods)
- RSI (14-period default)
- Slope analysis (5-period)
- Range position (hi/lo normalisation)
- Volume analysis (multi-period comparisons)

### Signal Scoring
- 8-point bull/bear scoring with configurable minimum score (default 6).
- Outputs: `LONG` (bull ≥ minScore), `SHORT` (bear ≥ minScore), `WAIT`.
- Trend classification: `up` / `down` / `flat`.

### Risk Management
- **Kelly Fraction** — computed from win rate × RR ratio, capped at 25%.
- **Position Sizing** — risk-based quantity with Kelly upper bound.
- **Trade Plan** — entry, stop, and target via ATR-based placement.
- Default risk per trade: 1% of capital.
- Default risk/reward ratio: 3:1 (configurable per leg).

### Trade Rolling / Flipping
- LONG → SHORT (or reverse) closes the first position at the new entry price.
- Both legs logged separately to Excel.

---

## EOD & Scheduling

- EOD timer fires every 60 seconds between 15:28–16:00 IST.
- INTRADAY: closes all open positions.
- CARRY_FORWARD: persists positions, skips closure.
- Excel workbooks auto-reset on new trading day unless carry-forward trades are pending.

---

## Data Storage

| Store | Location | Purpose |
| --- | --- | --- |
| Excel workbooks | `data/logs/` | One workbook per timeframe, "Trades" sheet |
| Active trades | `active-trades.json` | Carry-forward position persistence |
| Watchlist | `watchlist.json` | Saved symbol selection |
| Symbol overrides | `symbol-configs.json` | Per-symbol parameter customisation |
| Candle cache | In-memory | Avoids redundant API calls per symbol/timeframe |
| Replay range | Runtime config | Persisted for replay mode |

### Trade Log Columns
`TradeId`, `Symbol`, `Timeframe`, `Side`, `EntryTime`, `ExitTime`, `EntryPrice`, `ExitPrice`, `Quantity`, `GrossPnL`, `Costs`, `NetPnL`, `Outcome`, `Signal`, `RR`, `KellyFraction`, `Notes`

---

## UI Features

### Header & Status Bar
- Mode indicator (LIVE / REPLAY)
- Feed connection state (DISCONNECTED, CONNECTED, REPLAYING, …)
- Active leg count
- Runner state (IDLE, RUNNING, PAUSED)

### Toolbar
- **Search** — filter symbols by name/ticker (case-insensitive)
- **Mode Toggle** — animated LIVE ↔ REPLAY switch
- **Trade Mode** — radio buttons for INTRADAY / CARRY_FORWARD
- **Timeframe Filter** — checkboxes for `1m`, `5m`, `15m`, `60m`, `1D`
- **Start / Pause / Reset** buttons

### Replay Panel (REPLAY mode only)
- "Replay From" and "Replay To" datetime inputs
- "Apply Range" button
- Status message confirming applied range or showing errors

### Summary Grid
| Card | Notes |
| --- | --- |
| Active Legs | Count of currently running legs |
| Long Signals | Count of LONG legs |
| Short Signals | Count of SHORT legs |
| Waiting | Count of WAIT legs |
| Realized PnL | Toggle between ALL and INTRADAY mode |
| Unrealized PnL | Calculated from live prices × open trades |

Positive PnL → green. Negative PnL → red.

### Symbol Watchlist Cards
- Symbol ticker + company name
- LTP per symbol
- Primary timeframe indicator
- Leg pills per timeframe with enable/disable checkboxes
- Visual state: active (cyan), LONG trade (green), SHORT trade (red)
- Footer: active timeframes and risk/reward ratio
- Sorted: active legs first, then alphabetically

### Trade Log Section
- Collapsible header (expand/collapse toggle)
- **Filters:** Entry Time From, Entry Time To (pre-filled today 09:00 IST), Timeframe dropdown, Load button
- **Table columns:** all trade log fields (see Data Storage above)
- **Row colouring:** OPEN trades → warn colour; winning → green; losing → red
- Trade count display

### Client-Side Performance
- `requestAnimationFrame` batching — DOM updates deferred to one rAF per SSE batch (~60 fps max).
- SSE stream replaces polling.
- Debounced search on symbol watchlist.
- UI disabled during async operations (mode switch, range apply, runner controls).

---

## Scripts & Utilities

| Script | Purpose |
| --- | --- |
| `scripts/selftest.js` | Automated tests: Kelly capping, trade plans, signal scoring, candle normalisation, Dhan packet decoding, selection service, frame config, env check |
| `scripts/probe.js` | Diagnostic: root path, Dhan credentials, WebSocket URL, data dirs, timeframe file counts, trade log config count |
| `scripts/export-verify.js` | Tests export service by retrieving file path for a given timeframe |

---

## Configuration

### Environment Variables (`.env`)
- `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN` — Dhan API credentials
- `DHAN_WS_URL` — WebSocket endpoint
- `PORT`, `HOST` — server binding
- `DATA_DIR`, `REPLAY_SOURCE_DIR`, `REPLAY_CACHE_DIR`, `LOG_OUTPUT_DIR`
- `CAPITAL` — total capital for position sizing
- `CANDLE_REFRESH_MS`, `LIVE_REFRESH_MS` — refresh intervals
- `REPLAY_LOOKBACK_DAYS`, `REPLAY_SPEED` — replay parameters
- `AUTO_START` — start runner automatically on server boot

### Timeframe Config
| Key | Interval | Workbook |
| --- | --- | --- |
| `1m` | 1 minute | trades-1m.xlsx |
| `5m` | 5 minutes | trades-5m.xlsx |
| `15m` | 15 minutes | trades-15m.xlsx |
| `60m` | 60 minutes | trades-60m.xlsx |
| `1D` | 1 day | trades-1D.xlsx |

### Risk Defaults
- Kelly cap: 25%
- Risk per trade: 1% of capital
- Risk/reward ratio: 3:1
- Min Kelly fraction: configurable

---

## Starting the App

```powershell
cd "D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone"
.\start.ps1 -NoInstall
```

Then open: `http://127.0.0.1:3001`

Use `-NoInstall` to skip `setup.ps1` when `node_modules` is already present.
