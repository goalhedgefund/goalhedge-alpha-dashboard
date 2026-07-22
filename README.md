# scalper

Desk-grade, fully-automated intraday option scalping platform. Market-agnostic core; India/NSE (NIFTY weekly options) first; paper-trading first.

**Read the design package before touching code:** [`docs/00-OVERVIEW.md`](docs/00-OVERVIEW.md) → design, coding plan (M0–M11), testing plan, runbook.

## Quickstart

```bash
npm install
npx playwright install chromium   # one-time: browser for the UI e2e suite
npm test         # core test suite (vitest + fast-check)
npm run typecheck
npm run lint
npm run e2e      # UI Playwright suite (needs the chromium install above)
```

## Dhan live-data paper runner

The Dhan live-data paper runner reads credentials from `D:\DHAN_LOGIN\.env` by default and uses live Dhan market data with the in-repo `PaperBroker`; it does not place live orders.

Required before market start:

```bash
DHAN_CLIENT_ID=...
DHAN_ACCESS_TOKEN=...
DHAN_WS_URL=wss://api-feed.dhan.co
DHAN_SCRIP_MASTER_PATH=D:\path\to\api-scrip-master.csv
```

Useful optional knobs:

```bash
DHAN_AUTO_ARM=false
DHAN_GATEWAY_PORT=8787
DHAN_SPOT_SECURITY_ID=13
DHAN_SPOT_EXCHANGE_SEGMENT=IDX_I
DHAN_OPTION_EXCHANGE_SEGMENT=NSE_FNO
DHAN_INITIAL_SPOT_RUPEES=24500
DHAN_STRATEGY_ID=s1-momentum-burst
DHAN_PAPER_SLIPPAGE_TICKS=1
DHAN_PAPER_ACK_LATENCY_MS=80
DHAN_PAPER_FILL_LATENCY_MS=120
DHAN_REGIME_TREND_RET30_PCT=0.0015
DHAN_REGIME_TREND_VWAP_PCT=0.0005
DHAN_REGIME_HIGH_VOL_RET30_PCT=0.006
DHAN_REGIME_HIGH_VOL_ATR_PCT=0.006
```

Run:

```bash
npm run paper:live-data:dhan
```

## OP(-) weekly ATM±4 backtest data

Use `core/scripts/fetch_dhan_atm4_history.py` to download one trading day of
Dhan research data for the weekly scalp expiry. It fetches both CE and PE at
ATM−4 through ATM+4 and writes compressed synthetic ticks suitable for the
OP(-) backtest corpus. Hedge-expiry downloads are intentionally excluded.

Example:

```bash
python core/scripts/fetch_dhan_atm4_history.py \
  --date 2026-07-22 \
  --out core/data/dhan/ticks-op-minus-atm-short/2026-07-22
```

For a backfill, run the command once per trading day, changing `--date` and
the matching output directory. The script reads `DHAN_CLIENT_ID`,
`DHAN_ACCESS_TOKEN`, and `DHAN_SCRIP_MASTER_PATH` from the configured Dhan
env file (`DHAN_ENV_PATH` can override its location). It skips no-data days
by returning a non-zero exit code, so callers should continue across market
holidays.

## Layout

- `core/` — trading engine (TypeScript, strict; no UI dependencies)
- `ui/` — mission-control console (placeholder until milestone M8)
- `config/` — market / risk / strategy profiles (zod-validated, content-hashed)
- `docs/` — full design package
- `journals/`, `data/` — runtime output & recorded ticks (git-ignored)

## Conventions

- All money is **integer paise** — floating-point rupees never exist in the domain.
- All times are IST exchange time, epoch-ms.
- Every behavior change lands with its tests in the same commit; milestones end with a tagged commit (`m0`, `m1`, …).
