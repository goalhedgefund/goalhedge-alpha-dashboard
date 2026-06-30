# Multiscript Dashboard Testing Guide

## App Location

Standalone package:

```powershell
D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone
```

Replay candle data source:

```powershell
D:\CODEX\data\futures-eligible-cash-candles
```

## Launch

Open PowerShell:

```powershell
cd "D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone"
.\start.ps1 -NoInstall
```

Open browser:

```text
http://127.0.0.1:3001
```

## Replay Test Flow

1. Switch mode to `REPLAY`.
2. Select `Replay From` and `Replay To`.
3. Click `Apply Range`.
4. Confirm the range status below the button shows the applied range.
5. Click `Start`.
6. Watch LTP values move on all selected symbols.
7. At the end of the selected replay window, status should become `REPLAY_ENDED`.

Good test range:

```text
From: 2026-06-25 09:15
To:   2026-06-25 10:15
```

Short quick test range:

```text
From: 2026-06-25 09:15
To:   2026-06-25 09:25
```

## Expected Output

Replay cache files are created here:

```powershell
multiscript-standalone\data\replay-cache
```

Replay Excel trade logs are written here:

```powershell
multiscript-standalone\data\trade-logs\replay
```

Live Excel trade logs are written here:

```powershell
multiscript-standalone\data\trade-logs
```

## Current Fixes Completed

- `Apply Range` now captures the selected date/time before the UI refreshes.
- Range status now confirms what range was applied.
- Replay subscriptions now send symbol names, not only security IDs.
- Symbol cards now show LTP from enabled legs only, so disabled timeframes no longer overwrite the visible LTP with `0`.
- Replay completion now ends cleanly with `REPLAY_ENDED` and runner state `IDLE`.

## Verified

Latest checks passed:

```text
node --check client/app.js
node .\multiscript-standalone\scripts\selftest.js
10 passed, 0 failed
```

Replay test verified all cards moved for the 2026-06-25 replay window:

```text
AXISBANK
BHARTIARTL
HDFCBANK
ICICIBANK
INFY
ITC
LT
RELIANCE
SBIN
TCS
```

## Troubleshooting

If the app does not open:

1. Check if port is already occupied:

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
```

2. If needed, close the old app process and start again.

3. Start with:

```powershell
.\start.ps1 -NoInstall
```

If `Apply Range` appears not to work:

1. Check the visible status below `Apply Range`.
2. Refresh browser once.
3. Confirm saved range in:

```powershell
multiscript-standalone\data\symbol-configs.json
```

