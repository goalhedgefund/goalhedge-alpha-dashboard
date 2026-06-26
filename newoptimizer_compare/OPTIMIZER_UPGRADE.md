# Optimizer upgrade — algorithmic changes, patches & integration

This rewrites the tuning stage so it stops maximising the luckiest fit to the
past and starts selecting configs that **generalise**. Drop the three new modules
into `server/lib/`, apply the small patches to `simulate.js`, `index.js` and
`excel-export.js`, and the public API shape stays the same for your existing UI.

New files (complete, runnable, dependency-free):

| File | Role |
|---|---|
| `server/lib/optimizer.js` | **Rewritten.** Multi-stage search + robustness gauntlet. `optimize(closes, targetRR, opts)` is unchanged. |
| `server/lib/metrics.js` | **New.** Statistical primitives: Wilson bound, bootstrap, Deflated Sharpe, PBO/CSCV, drawdown, t-stat. |
| `server/lib/economics.js` | **New.** Single source of truth for turnover/cost/gross/net, shared by simulate + optimizer + index + excel. |
| `server/lib/selftest.js` | **New (dev only).** `node server/lib/selftest.js` — synthetic proof the machinery works. Safe to omit from prod. |

---

## 1. What changed algorithmically (the concise version)

**Old:** one big grid, keep the single highest in-sample score. That maximises
exactly the quantity you don't want — in-sample luck.

**New:** a three-stage search feeding a robustness gauntlet, ranked by an
out-of-sample, multiple-testing-aware score rather than the raw peak.

**Stage 1 — coarse exploration.** A wide deterministic grid over SL multiplier,
TP (as a band around your `targetRR`), `minScore`, and indicator period. Each
candidate is scored with a fast in-sample objective to locate promising regions.

**Stage 2 — local refinement.** The top-N coarse hits are refined with a finer
grid (midpoints inserted on each axis) so the optimizer hill-climbs into the
best neighbourhood without paying for a fine grid everywhere.

**Stage 3 — robustness gauntlet** (only the top finalists, because it's the
expensive part):

- **Walk-forward k-fold out-of-sample.** The config is *evaluated* on each
  time fold it never "chose" on. A config that only worked in one regime
  (classic overfit) shows a low out-of-sample hit-rate and is gated out.
- **Parameter-plateau stability.** Neighbouring parameter variants are scored;
  a config sitting on a plateau (neighbours also good) beats a lone spike. This
  is the "score consistency across nearby variants" metric you asked for.
- **Bootstrap lower bound on the edge.** Per-trade returns are resampled (seeded,
  deterministic); a robust edge keeps a positive lower bound, a 2-lucky-trades
  edge does not.
- **Deflated Sharpe Ratio** (Bailey & López de Prado, 2014). The in-sample
  Sharpe is haircut by *how many configs you tried* and *how dispersed their
  Sharpes were*, plus skew/fat-tails. Output is the probability the edge is real
  after the multiple-testing penalty.
- **Probability of Backtest Overfitting (PBO)** via CSCV (Bailey, Borwein,
  López de Prado, 2017) across the finalist set — a single diagnostic of how
  overfit the *selection process itself* is. Reported in metadata.

**Final ranking driver:** `robustScore = oosMedian × plateauFactor × oosHitRate ×
deflationProb × bootstrapGuard`, with hard gates (min trades, max drawdown,
positive bootstrap LB, OOS not collapsing, positive **net** expectancy when costs
are on). Qualified configs always rank above unqualified ones. The raw in-sample
score is reported but **never** drives the ranking.

**The upgraded objective** (`scoreObjective`) is a penalised (net) expectancy —
it multiplies the per-trade edge by quality factors in (0,1]:
- rewards: expectancy, Wilson-shrunk win rate, profit factor, sample size,
  t-stat significance, and net P&L when costs are enabled;
- penalises: drawdown, statistically-insignificant edges, thin post-cost
  margins, and small samples (Wilson lower bound + saturating sample term).
Multiplicative form means any single catastrophic dimension collapses the score.

**Cost-awareness.** When `costEnabled`, every objective uses **net** returns
after the exchange charge (intraday `0.03521%` / daily `0.2222%` of round-trip
turnover) from `economics.js`. A config that only looks good pre-cost cannot win.

### Verified behaviour (from `selftest.js`)
On a synthetic series with a genuine robust plateau plus a deliberate overfit
spike (an edge that only exists in a calm early regime), the spike has the
**higher in-sample expectancy (0.49R)** — it would have won the old optimizer —
but the new optimizer measures its out-of-sample hit-rate at 0.33, **rejects it**
(`oosHitRate<0.5`), and crowns the robust plateau config. Turning costs on
tightens qualification and lowers the Deflated-Sharpe survival probability, as
expected. Full run (~120 configs + full validation) completes in ~250 ms.

---

## 2. Patch-style summary of changed files & functions

```
server/lib/optimizer.js   REWRITE
  + optimize(closes, targetRR, opts)      multi-stage orchestrator (same signature)
  + scoreObjective(m, targetRR, opts)     penalised net-expectancy objective (replaces weak formula)
  + makeSpace / expandGrid / toConfig     overridable search space (SL, TP-band, minScore, period)
  + refineAround / neighbours             stage-2 refinement + stability neighbourhood
  + makeFolds                             walk-forward k-fold slicing
  + evaluate / canonical / pickReturn     SIMULATE ADAPTER — single coupling point to simulate()
  + stabilityFrom / snapshot              finalist metrics

server/lib/metrics.js     NEW
  + wilsonLowerBound, bootstrapMeanLB, deflatedSharpe,
    probabilityOfBacktestOverfitting (CSCV), maxDrawdown, tStat, sharpe,
    profitFactor, normalCdf/normalInv, mulberry32, moments

server/lib/economics.js   NEW
  + makeCostConfig, tradeEconomics, enrichTrades, summarizeEconomics,
    turnoverOf, deriveQty, EXCHANGE_RATES

server/lib/simulate.js    PATCH (3-4 lines) — emit trade economics + gross/net summary
server/index.js           PATCH — build costConfig once, pass to optimize & simulate; response unchanged in shape
server/lib/excel-export.js PATCH — add qty/turnover/gross/cost/net columns + gross-vs-net summary
```

---

## 3. The one coupling point you may need to touch

The optimizer reads `simulate()`'s output in exactly **one** function —
`evaluate()` in `optimizer.js`, marked `SIMULATE ADAPTER`. It expects either:

```js
simulate(closes, config) // → { summary, trades }   (preferred)
// or a flat object with a `.trades` array
```

and each trade ideally carrying: `entryPrice`, `exitPrice`, `side` (`'long'`/
`'short'`), and **either** `qty` **or** (`riskAmt` + `stopPrice`). If your field
names differ, edit `pickReturn`/`rOf`/`canonical` in that one block — nothing
else downstream needs to change. If trades lack economics, the optimizer calls
`economics.enrichTrades` itself, so it degrades gracefully (R-multiple mode) even
before you patch `simulate.js`.

---

## 4. `simulate.js` patch

Goal: every trade object carries `riskAmt`, `qty`, `turnover`, `grossCashPnl`,
`exchangeCost`, `netCashPnl`, and the summary exposes gross **and** net totals —
so backtest, optimizer, trade log and Excel all share identical economics.

At the top:
```js
const Econ = require('./economics');
```

Where you currently finalise a trade on exit, make sure it has the raw fields
(you almost certainly already compute these):
```js
trades.push({
  // ...your existing fields (bar indices, prices, etc.)...
  entryPrice, exitPrice,
  side,                      // 'long' | 'short'
  riskAmt,                   // cash you risked (from your Kelly/SL sizing)
  stopPrice,                 // entry ± SL, used to derive qty if qty absent
  qty,                       // optional; derived from riskAmt/stop distance if omitted
});
```

Just before `return`, enrich once and attach net/gross to the summary:
```js
const costConfig = Econ.makeCostConfig({
  enabled: !!config.costEnabled,
  mode: config.costMode || 'intraday',   // scalping default
});
const enriched = Econ.enrichTrades(trades, costConfig);
const econ = Econ.summarizeEconomics(enriched);

return {
  summary: {
    ...summary,                 // keep everything you already return
    grossCashPnl: econ.grossCashPnl,
    netCashPnl: econ.netCashPnl,
    exchangeCost: econ.exchangeCost,
    turnover: econ.turnover,
    costEnabled: costConfig.enabled,
  },
  trades: enriched,
};
```
This keeps the engine fast and deterministic — it's pure arithmetic per trade,
no new control flow in the entry/exit logic.

---

## 5. `index.js` patch

Build the cost config once from the UI flag and thread it through both
endpoints. The response keeps all existing keys; it only **adds** `validation`
and gross/net fields, so the current UI keeps working untouched.

```js
const Econ = require('./lib/economics');           // near your other requires
const { optimize } = require('./lib/optimizer');

// helper used by both /api/backtest and /api/optimize
function costFromReq(body) {
  return {
    enabled: body.tradingCostEnabled ?? body.costEnabled ?? false,
    mode: body.costMode || 'intraday',
  };
}
```

`/api/backtest` (baseline + optional `autoOptimize`):
```js
const cost = costFromReq(req.body);

// baseline backtest — pass cost flags into the config so simulate() nets it out
const baseConfig = { ...userConfig, costEnabled: cost.enabled, costMode: cost.mode };
const baseline = simulate(closes, baseConfig);

let optimization = null;
if (req.body.autoOptimize) {
  optimization = optimize(closes, targetRR, {
    costEnabled: cost.enabled,
    costMode: cost.mode,
    // optional tuning knobs, all have sane defaults:
    // minTrades: 20, ddCapR: 8, folds: 6, topRefine: 12, topFinalists: 8,
  });
}

res.json({
  baseline,                 // unchanged shape (now also has gross/net in summary)
  optimization,             // { best, leaderboard, searched, qualified, stages, validation, costConfig }
  // ...whatever else you already return...
});
```

`/api/optimize` (on cached candles): identical `optimize(...)` call with
`costFromReq(req.body)`. When you re-simulate the winning config to recover its
trade list for the chart/export, pass the same `costEnabled`/`costMode` so the
trade log matches the ranking that produced it:
```js
const winner = optimization.best.config;
const winnerRun = simulate(closes, { ...winner, costEnabled: cost.enabled, costMode: cost.mode });
```

That last point is the key consistency guarantee: **backtest, optimizer ranking,
trade log and Excel all run through the same `economics.js`, so gross/net never
diverge.**

---

## 6. `excel-export.js` patch

Add the per-trade economics columns and a gross-vs-net summary block. Because
`simulate.js` now attaches these fields, the export just reads them.

Trade-log columns (add to your `columns` definition):
```js
{ header: 'Qty',           key: 'qty',          width: 10 },
{ header: 'Turnover',      key: 'turnover',     width: 14 },
{ header: 'Gross P&L',     key: 'grossCashPnl', width: 14 },
{ header: 'Exchange Cost', key: 'exchangeCost', width: 14 },
{ header: 'Net P&L',       key: 'netCashPnl',   width: 14 },
```
Round when writing rows, e.g. `turnover: round2(t.turnover)`, etc.

Summary sheet — show both totals when available:
```js
const Econ = require('./economics');
const tot = Econ.summarizeEconomics(trades);   // trades already enriched by simulate()
summarySheet.addRows([
  ['Gross P&L',     round2(tot.grossCashPnl)],
  ['Exchange Cost', round2(tot.exchangeCost)],
  ['Net P&L',       round2(tot.netCashPnl)],
  ['Turnover',      round2(tot.turnover)],
]);
```
Keep currency/number formatting consistent with your existing cells.

---

## 7. Verify on your machine (matches your `node -e` workflow)

```powershell
cd D:\Claude\CLAUDE
node --check server\lib\optimizer.js
node --check server\lib\metrics.js
node --check server\lib\economics.js
node server\lib\selftest.js      # expect "27 passed, 0 failed"
```

Then a real boot test against cached candles through `/api/optimize` with
`tradingCostEnabled: true` and confirm `optimization.validation.pbo` and the
`leaderboard[].qualified` flags appear in the response. No UI changes are
required for it to keep functioning; the new fields are additive.

## 8. Tuning knobs (all optional, sane defaults)

Pass any of these in `opts` to `optimize()`:
`minTrades` (20), `ddCapR` (8), `folds` (6), `topRefine` (12), `topFinalists`
(8), `slGrid`, `rrBand`, `minScoreGrid`, `periodGrid`, or a full `space` override.
`sampleK` (30), `tMid` (1.5) tune the objective's sample/significance curves.
