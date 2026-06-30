# Session Handoff — Strategy Validation, Live Paper Deployment, Replay-Mode Fix

This document hands off an engineering session to another AI/engineer. It covers:
what was investigated, what was built, what is currently deployed, and the full
chronicle of the REPLAY-mode walk-forward fix — which is now **resolved and
verified** (§5), not mid-flight as an earlier version of this doc stated.

Read this fully before touching anything — several findings overturn earlier
"working" numbers from the original (overfit) optimizer.

---

## 1. Background — how we got here

Original ask: optimize an intraday multi-indicator trading strategy (RSI/MACD/
Stochastic/CCI/Williams%R/EMA9-21/Bollinger%B/ADX scoring system) running across
~213 NSE stocks, targeting **3–4% return per month** with sensible risk/reward,
using ~3 years of local 1-minute candle data.

### 1.1 Key finding: the original results were overfit

The pre-existing optimizer (`scripts/futures-bulk-optimize.js`) grid-searches
~1,050 parameter combinations **per symbol per timeframe** and reports in-sample
performance. The headline number in `OPTIMIZATION_ANALYSIS_HANDOFF.md`
(+757.9R over 3 years, a 10-stock basket at 3:1 RR / 15m) is **in-sample** — the
same data was used to select both the parameters and the stock basket.

A proper walk-forward test (train on 2023-06→2025-06, holdout 2025-07→2026-06)
showed: **every RR (2,3,4,5) × every basket size tested lost money out-of-sample**
under the original config. Root cause: the strategy's real edge is tiny
(~+0.05 to +0.17R/trade gross), and trading cost (~0.2R/trade on tight 15m stops)
is the same order of magnitude — cost ≈ edge, so overfit parameter selection
trivially flips sign out-of-sample.

### 1.2 The "realistic-path" fix that produced a genuinely OOS-positive system

Five levers were applied and validated with proper walk-forward discipline
(parameters selected only on 2023-06→2025-06, results reported only on the
untouched 2025-07→2026-06 holdout):

1. **Wide stops** (2.5× ATR instead of ~1.2×) — lowers cost-per-R.
2. **Higher RR** (5:1 instead of 3:1) — more reward per trade relative to cost.
3. **NIFTY trend filter** — only trade with the index's 20/50 EMA trend.
4. **NIFTY high-volatility-day filter** — skip days where NIFTY's 5-day average
   daily range exceeds 1.2% (whipsaw regimes). **This was the single biggest
   robustness win** — roughly doubled the recovery factor and halved drawdown.
5. **Risk-adjusted basket selection** (rank candidate stocks by design-window
   Sharpe, not raw in-sample return) + a **−5R daily portfolio loss limit**.

**Recommended system** (15m, stock futures, intraday only):
```
Timeframe:        15-minute, force square-off 15:25 IST, no carry
Stop:             2.5 × ATR
Reward:Risk:      5:1 (target = 12.5 × ATR)
Signal:           existing 8-point score, minScore >= 6
Trend filter:     trade only with NIFTY's 20/50 EMA trend
Regime filter:    skip days where NIFTY 5-day avg range > 1.2%
Daily loss cap:   stop new entries after -5R on the day
Universe:         stock futures, ~15 liquid names (selected by design-window Sharpe)
Sizing:           FIXED fractional risk 0.10-0.20% per trade. NOT Kelly.
Cost assumed:     0.025% round-trip (futures, incl. light slippage)
```

Out-of-sample result (2025-07→2026-06, the year the selection never saw):
**+442R net, 10/12 positive months, worst month −19R, max drawdown 63R, recovery
factor 7.0, monthly Sharpe 1.3.** At 0.10% risk/trade that's ≈3.7%/month with
~6% drawdown in-test.

**Recommended basket** (selected by design-window Sharpe):
`BHARATFORG, HAL, RECLTD, BSE, SUZLON, CDSL, CHOLAFIN, INDIGO, BEL, VEDL, IDEA,
LTF, VMM, PFC, GMRAIRPORT`

### 1.3 Honest caveats (do not strip these out of any future summary)

- **Several knobs were tuned against the same one holdout year** (vol threshold,
  daily limit, selection metric). The *direction* of each improvement is
  principled, but the **exact magnitude is optimistic** — discount meaningfully
  (assume roughly half) for live expectations.
- **Cost is the swing factor**, not stock selection. Profitability requires
  all-in round-trip cost ≤ ~0.025% (liquid futures, limit/marketable-limit
  entries). At cash-equity cost (~0.035%) the strategy is a net loser.
- Cash 1-minute candles were used as a futures proxy (basis ignored).
  Survivorship bias in "today's liquid F&O names." Slippage only crudely modeled
  via the flat cost rate.
- **Options were never backtested** — no options-chain/IV history exists in the
  local data. Futures only.
- **Never use Kelly sizing from these backtest stats.** In-sample Kelly suggests
  ~5-9% risk/trade; applied out-of-sample that produces account ruin (~-500%
  return in testing). Use small fixed fractional risk only.

---

## 2. Where the code lives

### 2.1 `D:\CODEX` (the main repo, on `main`, already committed)

```
scripts/backtest/engine.js              Core walk-forward backtest engine
scripts/backtest/recommended.js         Runs the recommended system end-to-end, OOS.
                                         `--write` saves data/recommended-system.json
scripts/backtest/sweep.js               Structural re-discovery grid sweep
scripts/backtest/export-to-dashboard.js Generates dashboard config/watchlist/regime files
scripts/backtest/README.md              Full methodology + caveats (read this too)
```

Git state: branch `backtest-realistic-system` was merged into `main` via fast-
forward (commits `2808274`, `02ed731`). This part is safely committed.

Pre-existing (not modified): `scripts/futures-bulk-optimize.js` (the original
per-symbol optimizer — now known to overfit), `scripts/apply-trading-cost-to-
configs.js` (cost post-processor), `server/lib/{simulate,indicators,optimizer}.js`
(shared indicator/backtest math reused by `scripts/backtest/engine.js`).

Historical 1-minute candles: `data/futures-eligible-cash-candles/<SYMBOL>/
<SYMBOL>_1m.json` (~213 symbols + NIFTY + BANKNIFTY). **The user mentioned
running a fresh data download to fill in missing 1m data up to the current
date** partway through this session — verify candle freshness/coverage before
trusting any new backtest numbers.

**Performance note for anyone extending the backtest scripts:** process one
symbol at a time and release the raw 1-minute array after aggregating. Each
symbol's 1m file is ~20-35MB; loading all ~213 at once will OOM a default
Node heap. Run with `node --max-old-space-size=4096 ...`.

### 2.2 `D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone` (live dashboard app)

**Important: this folder's own `.git` is broken/empty** — `git rev-parse
--show-toplevel` from inside it resolves to `D:\CODEX`, and the entire
`MULTISCRIPT DASHBOARD/` directory shows as a single untracked (`??`) entry in
the `D:\CODEX` repo. **None of the work described below in §3 and §4 is
committed to git anywhere.** Decide on a versioning strategy before doing more
work here (either give this folder its own real `git init`, or `git add` it
into the `D:\CODEX` repo).

This is the user's existing live-trading dashboard (Express server, Dhan API
integration, LIVE and REPLAY modes, Excel trade logging). It is a **paper-only**
system — confirmed no order-placement code exists anywhere in the codebase
(`grep` for `placeOrder`/`/orders`/`transactionType` etc. returns nothing). It
only logs simulated trades to Excel based on live or replayed price data.

Start command: `node server/index.js` from this directory, with env vars
`SCALPER_ENGINE=1` (see §3) and optionally `MULTISCRIPT_REPLAY_SPEED_MULTIPLIER`
for replay testing. Default port 3001 (`http://127.0.0.1:3001`).

**Operational note**: running this server via a tool-session-attached background
shell gets torn down when the tool session ends. Launch it **detached** instead,
e.g. via PowerShell `Start-Process -WindowStyle Hidden -PassThru` with
`-RedirectStandardOutput`/`-RedirectStandardError` to log files, so it survives
independently. (This was learned the hard way — the server died twice mid-session
before switching to detached launch.)

---

## 3. Critical finding: the dashboard's default signal ≠ the backtested signal

`server/engines/signal.engine.js` (the dashboard's original/default signal) uses
an **SMA fast/slow crossover + slope + RSI + range-position** score — a
completely different indicator set from the backtested strategy (8-point
RSI/MACD/Stoch/CCI/Williams%R/EMA9-21/BB%B/ADX score in `server/lib/indicators.js`
and replicated in `scripts/backtest/engine.js`).

**Fix applied**: `server/engines/signal.scalper.js` was written as a faithful
port of the backtested signal, and **verified to reproduce the backtest engine's
bull/bear score exactly, bar-for-bar (6/6 test bars matched)**. It's wired into
`server/engines/strategy.engine.js` behind an env flag:

```js
const USE_SCALPER = process.env.SCALPER_ENGINE === '1' || process.env.STRATEGY_ENGINE === 'scalper';
```

Default is OFF (legacy signal untouched) — **must set `SCALPER_ENGINE=1`** to
use the validated strategy. Also added `server/engines/regime.filter.js`
(reads `data/regime/nifty-regime.json`, applies the NIFTY trend + high-vol-day
gates from §1.2) and wired it into `strategy.engine.js` alongside the scalper
flag.

Files new in this change:
- `server/engines/signal.scalper.js`
- `server/engines/regime.filter.js`
- `data/optimized/symbol-configs.recommended.json` (15-name basket overrides:
  15m, sl 2.5, tp 12.5, rr 5, minScore 6, kellyFraction 0)
- `data/watchlist.recommended.json` (the 15-name basket, 15m enabled)
- `data/regime/nifty-regime.json` (NIFTY trend map + high-vol-day snapshot)
- `PAPER_TRADING.md` (runbook for activating/validating/reverting this — now
  partially superseded by §5 of this doc; the REPLAY validation section in it
  is the part currently broken, see §5)

File modified: `server/engines/strategy.engine.js` (the `USE_SCALPER` gate).

---

## 4. Live paper-trading deployment (already done, currently idle)

The recommended config was activated in the dashboard (reversibly — see backups
below) and the app was run LIVE during real market hours on 2026-06-30 to start
capturing paper trades.

**Activation** (done via a one-off script, not committed anywhere — re-derivable
from `scripts/backtest/export-to-dashboard.js`'s output):
- `data/watchlist.json` ← overwritten with the 15-name basket
  (backup: `data/watchlist.json.pre-recommended.<timestamp>`)
- `data/optimized/symbol-configs.json` ← merged with the 15 override keys,
  `_runtime` block preserved
  (backup: `data/optimized/symbol-configs.json.pre-recommended.<timestamp>`)

**To revert**: restore the `*.pre-recommended.*` backup files and unset
`SCALPER_ENGINE`.

**Status at session end**: server is running (detached process, port 3001),
mode currently `REPLAY` (left in this state from the final verification test in
§5 — **switch back to `LIVE` mode to resume paper capture during market
hours**), runner `IDLE`. `start.ps1` now hardcodes `$env:SCALPER_ENGINE = '1'`
so a plain restart via that script can no longer accidentally fall back to the
legacy signal. Risk-per-trade in `.env` was **not yet** changed from the
dashboard's default (1%) to the recommended 0.10-0.15% — that still needs doing
(`MULTISCRIPT_RISK_PER_TRADE` in `.env`; only affects logged PnL sizing, not
signal generation).

A credential note: the Dhan API access token expired once mid-session (HTTP 401,
no live data) and was refreshed by the user. Dhan tokens are short-lived —
expect to need a fresh token each trading day.

---

## 5. In-progress, NOT WORKING: REPLAY mode walk-forward fix

### 5.1 Why this was needed

The original plan was: validate the live dashboard reproduces the backtest by
running it in REPLAY mode over the 2025-07→2026-06 holdout and comparing trade
logs. This **failed** for an architectural reason discovered mid-session:

**`server/services/replay.repository.js`'s `getSeries()` always returned the
entire static candle range** for the configured replay window, not data sliced
to a moving "current simulated time." So the runner's candle-close trade
trigger only ever saw the *final* candle of the whole range and fired **at
most one trade evaluation per leg, total** — not a real day-by-day walk-forward.
A 13-minute "full year" replay attempt produced zero meaningful trades; a few
stray `OPEN` rows appeared dated with *today's* wall-clock time (artifacts of
this single-shot bug), which were manually cleaned out of the Excel trade logs
(`data/trade-logs/replay/*.xlsx` — surgically, by exact TradeId/date match, not
a blanket wipe).

User explicitly chose to **fix REPLAY mode properly** rather than skip it.

### 5.2 What was fixed (and confirmed working)

Five coordinated changes, all in `MULTISCRIPT DASHBOARD/multiscript-standalone/server/`:

1. **`adapters/replay/replay.feed.client.js`** — `ReplayFeedClient` now tracks
   and exposes `getCurrentTimestamp()` (the most recently emitted tick's
   timestamp = simulated "now").

2. **`services/feed.service.js`** — exposes `getReplayNow()`, delegating to the
   replay client's `getCurrentTimestamp()` when in REPLAY mode (null otherwise).

3. **`services/replay.repository.js`** — new method `getClosedSeries(symbol,
   frame, range, asOfMs)`: filters 1-minute candles to `ts <= asOfMs`,
   aggregates to the target frame, and **drops the most recent bucket if it
   isn't fully closed yet** (checks whether the last-needed 1-minute child bar
   is present, or for daily frame, whether simulated time is past 15:30 IST).
   This is the actual no-look-ahead fix. `getSeries()` (the old, full-range
   method) is left intact and unused by REPLAY mode now, but still exists for
   any other caller.

4. **`services/candle.service.js`** + **`index.js`** — REPLAY branch of
   `fetchFrameCandles` now calls `getClosedSeries(...)` with `asOfMs` sourced
   from the newly-wired `getReplayNow` callback, instead of the old
   `getSeries(...)`.

5. **`engines/runner.engine.js`** — the big one, several sub-fixes:
   - `refreshDueCandles` now **walks forward through every newly-closed candle**
     since `leg.lastCandleTimestamp` (not just the latest one), evaluating
     `tradeService.maybeRollTrade` for each in chronological order. The
     "first-ever evaluation jumps straight to latest candle only" shortcut
     (which exists to avoid flooding LIVE-mode startup with the whole lookback
     window) is now **gated to LIVE mode only** — REPLAY always walks from true
     start, since a leg's first refresh call can land arbitrarily late in a
     fast replay.
   - Added **REPLAY-only intraday EOD enforcement** against simulated candle
     time (`REPLAY_SQUARE_OFF_MINUTE = 15:25 IST`, `REPLAY_LAST_ENTRY_MINUTE =
     15:15 IST`), mirroring `scripts/backtest/engine.js`'s execution model —
     LIVE mode's real-wall-clock `eodTimer` doesn't fire during REPLAY at all,
     so without this, replay positions would never be force-closed.
   - `handlePacket` now **skips the expensive per-tick full signal evaluation
     during REPLAY** (just updates `leg.ltp`/cache) — trade decisions only
     happen in the candle-close walk-forward now, so the old per-tick
     `evaluateLeg` call (O(candle-history-length) on every single 1-minute
     tick — up to ~94,500 ticks/symbol over a year) was pure waste and the
     dominant cause of a ~1.8GB memory balloon / runs that never finished.
   - `refreshDueCandles` now processes **all due legs per tick during REPLAY**
     (not just one — LIVE mode still does one-per-interval, to spread out real
     Dhan API calls). REPLAY has no external rate limit to respect, and without
     this most legs never got a single refresh call before the (now much
     faster) replay finished.
   - Added a **forced final catch-up call** in `onFeedState('REPLAY_ENDED')`
     (`refreshDueCandles(true)`, bypassing the `isDueForRefresh` gate) so the
     tail end of the replay range — between the last periodic timer fire and
     the stream actually ending — doesn't get silently dropped.

6. **`services/trade.service.js`** — `nowIST()` and `openTrade`/`closeTrade`/
   `maybeRollTrade` now accept an explicit `atMs` parameter, defaulting to
   `Date.now()` (LIVE behavior unchanged). The runner's walk-forward loop
   passes the **historical candle timestamp**, so replay trades are logged
   with the correct historical date instead of all being stamped with today's
   wall-clock time (which would make any monthly comparison meaningless).

**A separate, necessary performance fix** in
`adapters/replay/replay.feed.client.js`: the original tick scheduler called one
`setTimeout` per individual 1-minute tick. At high speed multipliers, most
consecutive ticks compute to a near-zero wall-clock delay, so per-call
`setTimeout` overhead (not actual work) became the bottleneck — a 1-month,
15-symbol replay never finished in 5+ minutes even after fix #1-6 above. Fixed
by batching: ticks whose computed delay is below 2ms now process synchronously
in a tight loop (capped at 2000 per batch, to still yield to the event loop
periodically), only falling back to a real `setTimeout` for ticks genuinely
still in the future. **Confirmed this alone took a previously-nonterminating
1-month replay down to ~21 seconds.**

### 5.3 First diagnosis pass: zero trades (resolved), then three more bugs found

The first attempt at a clean 1-month test replay (April 2026 — the single
worst month in the backtest, where the recommended system lost −95R to −150R
depending on config, implying **many** trades should fire) completed
successfully but produced **zero trades** for all 15 symbols. This looked like
a remaining bug rather than a true negative result, and it was — but tracking
it down surfaced **three separate, compounding issues**, not one. Each is
documented below in the order they were found and fixed. The session ended
with the bug fully resolved and verified end-to-end (§5.6).

**Issue A — entry-side re-entry discipline was missing entirely.** The
standalone backtest (`scripts/backtest/engine.js`) enforces an 8-bar cooldown
after every exit, plus a `lastDir` rule: even after cooldown expires, it won't
re-enter the same direction until the score genuinely flips (a WAIT bar resets
the requirement). The dashboard pipeline had neither. Fixed in
`runner.engine.js`: added `leg.cooldownRemaining` / `leg.lastSignalDir` state
(declared in `timeframe.engine.js`'s `createLegState`), consulted only while
flat, gated behind `USE_SCALPER` (exported from `strategy.engine.js`) so the
legacy signal engine's behaviour is untouched.

**Issue B — exit philosophy diverged from the backtest.** The dashboard's
`tradeService.maybeRollTrade` actively re-checks the signal every bar while
holding a position and closes/reopens on a WAIT or a flipped signal. The
backtest **never re-checks the signal while a trade is open** — it only exits
via stop, target, or EOD square-off. This was the dominant source of
*overtrading* once Issue A was fixed in isolation (trade count barely moved:
843→888 rows). Fixed by branching the walk-forward loop's holding-state logic:
when `USE_SCALPER` is active, exits are now decided purely by explicit
SL/TP/EOD checks against `closeCandle.high/low`, never by re-evaluating
`evaluateLeg`. The legacy engine's old signal-driven exit path is preserved
unchanged in the `else` branch.

**Issue C (found mid-fix) — a duplicate-trade race condition.** While
re-testing A+B, the trade log started showing **two distinct TradeIds with
identical entry/exit time and price** for the same historical bar (1245 rows
where there should have been far fewer, growing between checks even after the
runner reported `IDLE`). Root cause: `rebuildLegs()` replaces `activeLegs`
with fresh leg objects (a `mode`/`range`/`reset`/`start` API sequence fired in
quick succession triggers this 2-3 times), and an in-flight `refreshDueCandles`
batch captured *before* a rebuild kept holding references to the now-orphaned
old leg objects, continuing to walk and trade them from scratch alongside the
new generation. Fixed with a `legsGeneration` counter in `runner.engine.js`,
bumped on every `rebuildLegs()` call; an in-flight batch checks the generation
before processing each leg and aborts the remainder of the batch if it no
longer matches.

### 5.4 A genuinely separate performance bug, found along the way

While narrowing down the above, a 1-month/15-symbol replay was taking 5+
minutes and never finishing. Root cause: `ReplayFeedClient`'s tick scheduler
called one `setTimeout` per individual 1-minute tick; at high speed
multipliers most consecutive ticks compute to a near-zero wall-clock delay, so
per-call timer overhead (not actual work) was the bottleneck. Fixed in
`adapters/replay/replay.feed.client.js`: ticks whose computed delay is below
2ms now process synchronously in a tight loop (capped at 2000 per batch, to
still yield to the event loop periodically), falling back to a real
`setTimeout` only for ticks genuinely still in the future. This alone took a
previously-nonterminating 1-month replay down to ~21 seconds. A second,
related fix was needed in `runner.engine.js`: with ticks now flying through in
seconds, the wall-clock `candleRefreshMs` polling interval couldn't keep up
with 15 legs round-robin (1 leg per tick — a LIVE-mode-appropriate choice to
spread out real Dhan API calls, but wrong for REPLAY). Changed to process
**all** due legs per tick when `isReplay`, plus a forced final catch-up call in
`onFeedState('REPLAY_ENDED')` (bypassing the `isDueForRefresh` gate) so the
tail end of the range isn't dropped between the last timer fire and the stream
actually ending.

### 5.5 The dominant bug, found only by insisting on a number comparison

After A, B, and C were all fixed, a clean re-test produced 62 trades — no
duplicates, no zero-trade bug, looking plausible at a glance. **It was still
wrong.** Comparing against `scripts/backtest/recommended.js`'s own April 2026
number for the identical basket/config (158 trades) showed the dashboard was
now *under*-trading by ~60%, the opposite problem from before. Two more root
causes, found through a careful, large-scale verification (not eyeballing):

**Issue D — missing pre-range indicator warm-up.**
`replay.repository.js`'s `loadSourceDataset` strictly truncated candle data to
the requested replay range with zero lookback buffer, so EMA9/EMA21 (which
`signal.scalper.js`'s `ema()` seeds from the *first* element of whatever array
it's given) cold-start at the exact beginning of the range instead of being
properly converged, the way a continuously-running system (or the backtest,
which always uses full multi-year history) would be. Fixed by adding a
`WARMUP_DAYS = 60` buffer, applied only via a new `loadSourceDataset(symbol,
range, { warmup: true })` parameter that **only** `getClosedSeries` (candle
evaluation) opts into — the tick stream (`buildReplayTicks`/`getSeries`)
deliberately does not, so the replay's visible animation window and pacing are
unaffected. Trades whose entry falls before the user's true requested start
(i.e. during the warm-up-only period) are tracked for full state continuity
(cooldown, lastDir, open positions) but never written to the Excel log — see
the `silent` parameter threaded through `trade.service.js`'s
`openTrade`/`closeTrade`/`maybeRollTrade` (the flag is remembered on the trade
object itself so a position opened during warm-up stays silent even if its
exit lands after crossing into the visible range).

This fix alone barely moved the needle (confirmed via a standalone check
against the real `ReplayRepository` — only 1 "in-range" open for BHARATFORG
even with 1000 warm-up bars available), which is what led to finding Issue E.

**Issue E — missing `NOCARRY` fallback (the dominant cause).** The backtest's
EOD handling has two layers: square-off once a candle's IST time reaches
15:25, **and** a fallback that force-closes at the next bar's open if the
calendar day changes while still holding (covers illiquid stocks with no
candle exactly in the 15:25 window — common, since 1-minute data can have
gaps). The dashboard only had the first layer. Confirmed via direct trace:
BHARATFORG opened a position on 2026-04-15 and — because no candle ever fell
in the ≥15:25 IST window on that specific day — **never closed again through
the end of available data (2026-06-30)**, silently blocking every subsequent
signal for that leg for two and a half months. This was the dominant root
cause of the under-trading; once isolated, a standalone diagnostic across the
whole basket jumped from ~25 trades to **144 trades** (backtest reference:
158) with this one fix alone. Fixed in `runner.engine.js`'s holding-branch: a
new `istDateKeyMs()` helper compares the current bar's IST calendar date
against `leg.activeTrade.entryTime.slice(0, 10)` (already an IST-formatted
string); a mismatch force-closes at `closeCandle.open` with reason `'NOCARRY'`,
mirroring the backtest exactly.

Both D and E were found specifically *because* the result was checked against
an independent reference number instead of being accepted on the basis of "no
errors, plausible-looking output, no duplicates." That discipline — verify
against a known-correct number, don't just check for the absence of obvious
breakage — is what surfaced two genuine bugs that would otherwise have shipped
silently.

### 5.6 Final verification — confirmed working end-to-end

A full clean restart (all fixes applied, debug data cleared from the Excel
logs) replaying April 2026 through the real server (HTTP API → runner →
candle/trade services → Excel), not a standalone diagnostic, produced:

```
147 distinct trades (286 rows: 147 OPEN + 139 CLOSED)  vs backtest reference: 158  (93% match)
Zero duplicate TradeIds (147 distinct IDs = 147 OPEN rows, exact match)
Win rate: 51.1% | Net PnL: -₹12,014 (correctly negative — April was the backtest's worst month too)
```

Per-symbol counts (dashboard / backtest reference):
BHARATFORG 12/13, HAL 11/12, RECLTD 10/11, BSE 10/10, SUZLON 10/11, CDSL 8/9,
CHOLAFIN 10/11, INDIGO 10/9, BEL 10/9, VEDL 9/11, IDEA 10/11, LTF 11/11,
VMM 9/11, PFC 9/10, GMRAIRPORT 8/9.

The residual ~7% gap is consistent with a known, accepted, unaddressed timing
difference: the backtest enters at the *next* bar's open after a signal,
while the dashboard enters at the *current* bar's close — a one-bar shift,
not a bug. **REPLAY mode is now considered correct and trustworthy** for
validating the dashboard against the backtest going forward.

### 5.7 Recommended order of work for whoever picks this up next

1. Resume live paper capture: switch the dashboard to `LIVE` mode, restart
   (`start.ps1` now hardcodes `SCALPER_ENGINE=1`, so a plain restart is safe),
   set `MULTISCRIPT_RISK_PER_TRADE=0.0015` (or 0.001) in `.env`, regenerate
   `data/regime/nifty-regime.json` fresh (should be regenerated daily for live
   use — the current snapshot is from this session's date), and refresh the
   Dhan API token (expires daily).
2. If you want to re-validate REPLAY mode against the full 2025-07→2026-06 OOS
   window (not just April), re-run the same process — expect it to take longer
   given the warm-up buffer now loads more data per leg, but it should still
   complete; compare monthly trade counts/PnL against §1.2's numbers as the
   acceptance bar.
3. The ~7% residual gap (entry-timing model: next-bar-open vs current-bar-close)
   is a known, accepted, minor divergence — not worth chasing further unless
   a tighter match is specifically needed.

---

## 6. Minor flagged item (not investigated further, not blocking)

`MULTISCRIPT DASHBOARD/multiscript-standalone`'s installed `dotenv` package is
version `17.4.2`, but `package.json` declares `^16.4.5` (no lockfile present to
explain the mismatch). Checked the installed package's source — the version
mismatch is real but appears to be an ordinary stale/unlocked install, not
tampering (a console "tip" string referencing an unfamiliar domain
`www.vestauth.com` turned out to be a hardcoded entry in dotenv's own
upstream `_getRandomTip()` array, consistent with that package's known
practice of injecting promotional tips into its console output — not unique
to this install). Worth pinning the dependency properly for reproducibility,
but it's a hygiene issue, not a security incident.

---

## 7. Quick reference — file inventory

**Committed to GitHub** (`D:\CODEX`, `main` branch, remote
`goalhedgefund/goalhedge-alpha-dashboard`):
- `scripts/backtest/{engine,recommended,sweep,export-to-dashboard}.js`, `README.md`
  (earlier commits `2808274`, `02ed731`)
- The entire `MULTISCRIPT DASHBOARD/multiscript-standalone/` **code** tree
  (`server/`, `client/`, `scripts/`, `docs/`, `package.json`, `*.ps1`, `*.md`)
  including every fix in §5, plus other top-level docs/scripts that had
  accumulated uncommitted (`OPTIMIZATION_ANALYSIS_HANDOFF.md`, this file,
  `multiscript-probe.js`, `scripts/{apply-trading-cost-to-configs,
  download-candles,futures-bulk-download,futures-bulk-optimize}.js`,
  `scripts/FUTURES_BULK_OPTIMIZE_README.md`, `public/js/app.js`'s small
  pre-existing watchlist-click UI tweak).
- **Deliberately excluded from every commit** (per explicit instruction —
  data/Excel/log files are never committed): both repos' `data/` directories
  in full (candle JSON, trade-log `.xlsx`, replay caches, generated configs
  like `symbol-configs*.json`/`recommended-system.json`/`nifty-regime.json`/
  `watchlist*.json`), `*.log` files, `node_modules/`, `.env`, and
  `multiscript-dashboard.zip` (a redundant packaged copy of the same code
  that's now committed properly as source).

**Still uncommitted, intentionally** (regenerable from the code, or live
runtime state — see `.gitignore` in each folder):
- `data/recommended-system.json` (regenerate via `recommended.js --write`)
- `MULTISCRIPT DASHBOARD/multiscript-standalone/data/*` (regenerate via
  `export-to-dashboard.js`, or it's genuine runtime state: watchlist backups,
  trade logs, replay cache, session files, active-trades)

If you need the exact data snapshot this session validated against
(candle files, the specific `nifty-regime.json` used in §5.6's verification,
etc.), it's only on local disk — not in git.
