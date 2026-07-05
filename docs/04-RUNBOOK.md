# 04 — Operator Runbook & Governance

The platform is fully automated; the operator's job is **supervision, drills, and judgment calls the machine must not make**.

---

## 1. Daily session lifecycle

**T−15 min — Preflight (automated; any failure blocks ARM):**
instrument master refresh + weekly expiry roll check → feed connect + tick freshness vs NTP clock → charges profile hash matches approved version → risk profile loaded (limits displayed; operator must `ACK_PREFLIGHT`) → **kill-switch self-test** (full sequence, dry-run) → disk headroom for journals → config hash journaled.

**09:15 — Open:** strategies remain DISARMED until operator issues `ARM` (deliberate human step, every day).
**09:15–15:00 — Trading window:** entries allowed per eligibility filters; operator watches Health HUD + risk meters; **never edits configs mid-session** (params queue until flat by design).
**15:00 — Entry cutoff** (config). **15:12 — Hard square-off** (config; ahead of broker auto-square-off).
**Post-close (automated):** final reconciliation → daily digest (trades, hit rate, gross→charges→net waterfall, attribution, latency stats, MAE) written to `journals/<date>/digest.md` + `trades.csv` (`PaperHost.squareOffAndReport`) → journal archive + tick-recording verification (`Recorder` runs every session) → session state CLOSED. Internal tick→order latency is instrumented per decision (`latency.sample`) with a **p99 < 5 ms** CI budget (01-DESIGN §7); any red on the HUD latency line is pre-kill territory.

## 2. Operator decision rules

- **Any red on Health HUD while positioned → hit the kill switch. Do not debug while exposed.** Diagnose flat.
- Kill switch trips automatically → do **not** re-arm until root cause is written into the session log (typed reason is mandatory in the re-arm flow).
- Reconciliation amber twice in one session → disarm for the day, investigate offline.
- Strategy behaving "weirdly but profitably" → disarm anyway; profitable bugs are still bugs.
- Never raise a limit intraday. Limit changes happen post-close, journaled, effective next session.

## 3. Weekly drills (journaled)

Kill-switch drill during a live-data paper session (flatten time vs budget) · crash-recovery drill (kill −9, restart, verify state) · restore-from-archive drill monthly.

## 4. Risk profile — v1 defaults (edit in `config/risk/`, never in code)

| Limit | Default (paper) | Note |
|---|---|---|
| Per-trade risk | ≤ 0.25% of capital | enforced against stopPlan at the gate |
| Daily max loss | −1.0% of capital | latching halt |
| Give-back stop | 50% of day's peak P&L (once peak > +0.5%) | latching |
| Loss streak | 3 consecutive → 30 min cooldown | |
| Max trades/day | 15 | scalping ≠ overtrading |
| Max concurrent positions | 1 | v1 |
| Cost gate | min expected move 8%, reward/friction >= 1.5x | accounts for spread, slippage, and charges before entry |
| Position size | fixed-fractional, **never Kelly** | per prior in-house research (in-sample Kelly oversizes 5–9×) |

## 5. India compliance checklist (execute at live-broker selection; owner: operator)

1. SEBI retail algo framework: confirm current thresholds; register the strategy/algo via the broker + exchange if order-rate or framework requires it; obtain algo ID and tag orders accordingly.
2. Static IP provisioned and whitelisted with the broker API.
3. Broker API agreement, rate limits, and auto-square-off timings written into the adapter config (not assumed).
4. Verify current: lot size, freeze quantity, expiry calendar, STT/txn-charge rates against the broker's contract note — update `india-nse-options` profile and re-run the charges test suite.
5. Confirm margin treatment for long options (premium-only) and any broker-specific intraday policies.

## 6. Incident response

Any unexplained state → **kill first**, preserve journals, snapshot SQLite, then investigate via deterministic replay of the session journal. Every incident gets a short post-mortem in `docs/incidents/` with: timeline (from journal), root cause, fix, and the new regression test that pins it.

## 7. Change management

`main` is always releasable · every behavior change re-pins the golden-session hash in review (the determinism hash is computed over all journal events **except `latency.sample`**, which carry real measured microseconds and are legitimately non-deterministic) · config changes are PRs too (hash journaled at session start) · strategy changes must re-pass the 03 §10 strategy gate in paper before re-arming live · dependency updates get a full soak run (`runSoak`) before production use.
