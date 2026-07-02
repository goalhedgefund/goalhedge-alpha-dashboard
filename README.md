# scalper

Desk-grade, fully-automated intraday option scalping platform. Market-agnostic core; India/NSE (NIFTY weekly options) first; paper-trading first.

**Read the design package before touching code:** [`docs/00-OVERVIEW.md`](docs/00-OVERVIEW.md) → design, coding plan (M0–M11), testing plan, runbook.

## Quickstart

```bash
npm install
npm test         # core test suite (vitest + fast-check)
npm run typecheck
npm run lint
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
