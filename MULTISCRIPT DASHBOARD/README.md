# Multi-Script Dashboard Prototype

This folder is a standalone mockup only.

What it shows:
- The downloaded `Multiscript - Live Signal Board` UI as the active base.
- Filters, search, sort, pause/resume, market pulse, tape, cards, gauges, and trade levels.
- Offline browser simulation when the backend is not running.
- Staggered Dhan LTP polling when the existing app backend is running on `http://localhost:3001`.
- One-symbol-at-a-time Dhan polling every `900 ms` to avoid burst-style `429` failures.

Files:
- `index.html` - self-contained UI, styling, and feed wiring
- `probe-10.js` - optional parallel Dhan backtest probe using `../.env`
- `STAGGERED_RUNNER_PLAN.md` - proposed staggered runner design to avoid `429`

This folder does not modify the current app code.

To use Dhan mode:

1. Start the main backend from `D:\CODEX` with `npm start`.
2. Open `D:\CODEX\MULTISCRIPT DASHBOARD\index.html`.
3. The feed label should change from `SIMULATION` to `DHAN STAGGERED`.
