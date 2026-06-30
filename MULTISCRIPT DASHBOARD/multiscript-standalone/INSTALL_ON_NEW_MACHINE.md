# Multiscript Standalone Install

## Requirements

- Windows PowerShell
- Node.js 20 or newer installed and available in `PATH`
- Dhan API credentials for live mode
- Replay candle data copied separately if replay/backtest mode is needed

## Install

1. Extract the package.
2. Open PowerShell in the extracted `multiscript-standalone` folder.
3. Create `.env` from `.env.example`:

```powershell
Copy-Item .env.example .env
```

4. Edit `.env` and set:

```text
DHAN_CLIENT_ID=
DHAN_ACCESS_TOKEN=
MULTISCRIPT_REPLAY_SOURCE_DIR=
```

Example replay data path:

```text
MULTISCRIPT_REPLAY_SOURCE_DIR=D:\CODEX\data\futures-eligible-cash-candles
```

5. Start the app:

```powershell
.\start.ps1 -NoInstall
```

6. Open:

```text
http://127.0.0.1:3001
```

## Notes

- `node_modules` is included in the portable package.
- `.env` is intentionally not included because it contains credentials.
- Replay/backtest candle files are intentionally not included because they are large and machine-specific.
- Live trade logs are written to `data\trade-logs`.
- Replay trade logs are written to `data\trade-logs\replay`.

