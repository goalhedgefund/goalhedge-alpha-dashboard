# Multiscript Standalone

This is a standalone local web app for running multiscript strategies through Dhan live feed and timeframe-specific trade logging.

## Run

1. Copy `.env.example` to `.env` and fill in your Dhan credentials.
2. Start the app with:

```powershell
.\start.ps1
```

## Structure

- `client/` - browser UI
- `server/` - backend feed, runner, strategy, logging
- `data/` - optimized configs and trade logs
- `scripts/` - probe and test helpers

## Notes

- The app reads Dhan credentials only on the backend.
- Dhan WebSocket is used for live ticks.
- Timeframe logic is split into separate functions and modules so Futures and Options can be added later.
