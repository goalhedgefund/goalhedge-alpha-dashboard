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
```

Run:

```bash
npm run paper:live-data:dhan
```

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
