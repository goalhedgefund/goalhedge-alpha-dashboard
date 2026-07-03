# M8b Work Order — React Mission-Control Console + Playwright

Self-contained brief for a fresh session. Context: M0–M7 + M8a complete (tags
`m0`…`m8a`, 195 tests green). The gateway (`core/src/gateway/`) is done and
test-pinned: per-client snapshot/delta seq protocol, journaled command
channel, `applyChanges` exported. Read `01-DESIGN.md §1.1 + §3` for panel
specs; this file pins the implementation decisions so nothing is re-litigated.

## Locked decisions

1. **Stack:** Vite + React 18 + TypeScript strict in `ui/`. No state library —
   one `useGatewayClient` hook + `useReducer` over `GatewayState`.
2. **⚠ Import boundary (bundle-breaker):** the UI imports ONLY from
   `core/src/gateway/protocol.ts` (types + `applyChanges`; type-only domain
   imports — browser-safe). NEVER from `core/src/index.ts` — that pulls
   better-sqlite3/ws/pino into the browser bundle. Enforce via a Vite alias
   `@proto` → `../core/src/gateway/protocol.ts` and use only that alias.
3. **Client protocol rules** (mirror gateway tests): snapshot replaces state;
   delta must arrive at `lastSeq+1` else send `{kind:'resnapshot'}`; hb with
   `seq !== lastSeq` also forces resnapshot; hb gap > 6s → STALE overlay.
   Commands: `commandId = cmd-<n>` counter; track pending → resolve on ack;
   surface rejected acks in the UI (KILL/REARM are UNKNOWN_COMMAND until M9 —
   show the rejection, that is correct behavior, not a bug).
4. **Panels (all ten, minimal but real
   ):** mode banner (mode+phase+lifecycle, paper=blue/live=red), health HUD
   (feed status, last-tick age ticking locally, ws state, seq), KILL SWITCH
   (two-step: click → 1s hold → send KILL; show ack/rejection + reason),
   risk meters (bars: daily loss vs limit, trades used, streak), positions +
   stop ladder (from position + latest stop.moved event), chain strip
   (state.chain rows, highlight tracked instrument), underlying panel (see 5),
   blotter (orders + trades tabs, net P&L column), event stream (state.events
   ring, newest first, reason codes bold), algo panel (params readonly,
   lastNoTradeReason = "why not trading now" line, ARM/DISARM buttons).
5. **Chart:** add a `bars: Bar[]` slice to `GatewayState` (small core edit:
   protocol type + gateway `ingestJournal` case for `md.bar` keeping last 390
   1m bars + one gateway test). UI renders `lightweight-charts` candlesticks
   from it. If lightweight-charts fights the clock, ship an SVG sparkline
   fallback and leave a TODO — do not burn the session on chart cosmetics.
6. **Demo driver (for dev + Playwright):** `core/src/demo/demo-gateway.ts` —
   compiled by the existing `npm run build -w core`, run with
   `node core/dist/demo/demo-gateway.js`. It wires the M7 e2e harness pieces
   (TestViewProvider-style scripted scenario → runner/OMS/paper → gateway on
   port 8787 with journal sink → `gateway.ingestJournal`) and loops the trail
   scenario at ~2 ticks/sec with wall clock. Reuse `test/strategy.e2e.test.ts`
   as the reference for wiring; keep the scripted numbers (entry 15000,
   trail to 16500, exit 16390) so the UI shows a full trade lifecycle every
   ~40s.
7. **launch.json:** two entries — `demo-gateway` (node dist, port 8787) and
   `ui` (vite dev server, port 5173, proxies nothing; ws URL via
   `VITE_GATEWAY_URL=ws://127.0.0.1:8787`).
8. **Playwright** (`ui/e2e/`, `@playwright/test`, chromium only):
   `webServer: [demo-gateway, vite preview]`. Specs: (a) console renders live
   state from the demo (a position appears, then a trade lands in blotter);
   (b) refresh mid-session reconstructs state (no blank panels, seq restarts
   at 1); (c) seq-gap → resnapshot: client exposes `window.__gw.skipSeq()`
   test hook that bumps lastSeq artificially → next delta triggers
   resnapshot (assert via `window.__gw.stats.resnapshots`); (d) command round
   trip: ARM button → ack accepted → banner shows ARMED; (e) kill two-step:
   single click does NOT send; click+hold sends and shows the rejected
   UNKNOWN_COMMAND ack.
9. **ui/package.json:** real scripts replace the M0 placeholder (`dev`,
   `build`, `preview`, `test` = vitest for the hook unit tests, `e2e` =
   playwright). Root `npm test` must stay green (hook unit tests: snapshot →
   deltas → reconstruction, gap → resnapshot request, using a mock ws).
10. **Acceptance = 02-CODING-PLAN M8 items** not covered by M8a: Playwright
    specs above green + manual demo via launch.json. Commit tagged `m8b`.

## Order of work (commit at each green step)
1. Core edit: `bars` slice + md.bar ingestion + test → green.
2. Demo driver + launch.json → manually verified once via websocat/node probe.
3. Vite scaffold + `useGatewayClient` + hook unit tests → green.
4. Panels + CSS (dark, dense, CSS grid; no component library).
5. Playwright setup + 5 specs → green; tag `m8b`.
