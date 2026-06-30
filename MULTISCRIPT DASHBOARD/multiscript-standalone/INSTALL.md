# Multiscript Dashboard — Installation Guide

## Requirements

- **Windows 10/11**
- **Node.js 20 or later** — download from https://nodejs.org (LTS version)
- **Replay candle data** — copy the `futures-eligible-cash-candles` folder to your machine (provided separately, ~7 GB)

---

## Quick Start

1. **Extract** the zip to any folder, e.g. `D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone`

2. **Copy the replay candle data** folder to your machine, e.g. `D:\CODEX\data\futures-eligible-cash-candles`

3. **Configure `.env`** — open `.env` in Notepad and update these values:

   ```
   DHAN_CLIENT_ID=<your Dhan client ID>
   DHAN_ACCESS_TOKEN=<your Dhan access token>
   MULTISCRIPT_REPLAY_SOURCE_DIR=<full path to your futures-eligible-cash-candles folder>
   ```

   Example:
   ```
   MULTISCRIPT_REPLAY_SOURCE_DIR=D:\CODEX\data\futures-eligible-cash-candles
   ```

4. **Run the install script** — right-click PowerShell → Run as Administrator, then:

   ```powershell
   cd "D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone"
   .\install.ps1
   ```

5. **Open browser** and go to: `http://127.0.0.1:3001`

---

## Starting the App (after first install)

```powershell
cd "D:\CODEX\MULTISCRIPT DASHBOARD\multiscript-standalone"
.\start.ps1 -NoInstall
```

Or double-click `START.bat` (created by install.ps1).

---

## Directory Structure

```
multiscript-standalone\
  client\          — Frontend (HTML, CSS, JS)
  server\          — Backend (Node.js/Express)
  scripts\         — Utility scripts
  data\
    optimized\     — Pre-scored symbol configs per timeframe
    replay-cache\  — Auto-generated replay cache (safe to delete)
    trade-logs\    — Excel trade logs (written at runtime)
  node_modules\    — Bundled dependencies (no npm install needed)
  .env             — Your credentials and config (edit this)
  start.ps1        — Launch the app
  install.ps1      — First-time setup
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Port 3001 already in use" | `Get-NetTCPConnection -LocalPort 3001` → find PID → `Stop-Process -Id <PID>` |
| LTPs not updating in LIVE | Check `DHAN_ACCESS_TOKEN` in `.env` — token may have expired |
| Replay shows no data | Check `MULTISCRIPT_REPLAY_SOURCE_DIR` path in `.env` |
| "Cannot find module" error | Make sure `node_modules` folder was extracted correctly |
| Browser shows blank page | Wait 5 seconds and refresh — server may still be starting |
