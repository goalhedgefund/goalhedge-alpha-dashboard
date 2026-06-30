# NSE Futures-Eligible Cash Bulk Download + Optimize Utility

This utility is intentionally standalone. It does not change the dashboard/server flow unless you run it with `--write-config`.

## Script

`D:\CODEX\scripts\futures-bulk-optimize.js`

## What It Does

1. Reads `D:\CODEX\data\api-scrip-master.csv`.
2. Filters current NSE stock futures contracts to build the eligible stock universe:
   - `SEM_EXM_EXCH_ID = NSE`
   - `SEM_SEGMENT = D`
   - `SEM_INSTRUMENT_NAME = FUTSTK`
   - `SEM_EXCH_INSTRUMENT_TYPE = FUT`
3. Maps each eligible underlying back to its NSE cash/equity security id.
4. Downloads 1-minute NSE cash candles from Dhan `/v2/charts/intraday`.
5. Saves candles into `D:\CODEX\data\futures-eligible-cash-candles\<UNDERLYING>\`.
6. Aggregates/uses the downloaded 1-minute candles for:
   - `1`
   - `5`
   - `15`
   - `60`
   - `D`
7. Runs the existing local backtest engine from `server/lib/simulate.js`.
8. Runs the existing local optimizer from `server/lib/optimizer.js`.
9. Optionally writes optimized entries into `D:\CODEX\data\symbol-configs.json`.

## Safety Defaults

The script will not run the full universe unless you pass `--all`.

The script will not update `symbol-configs.json` unless you pass `--write-config`.

## Execution Model

The optimizer uses the same signal criteria as the dashboard simulator, but the bulk script applies a more realistic execution model:

```text
Signal candle: candle i
Entry: open of candle i+1
Target/stop exit: intrabar high/low touch
If stop and target both touch in the same candle: assume stop-loss first
```

For intraday timeframes:

```text
1m, 5m, 15m
No fresh entry after 15:15 IST
Force square-off from 15:25 IST onward
No overnight carry-forward
```

For non-intraday timeframes:

```text
60m and 1D can carry until target or stop is hit.
```

## Test One Symbol

```powershell
cd D:\CODEX
node scripts\futures-bulk-optimize.js --symbol RELIANCE --from 2026-06-24 --to 2026-06-26
```

## Test Multiple Symbols

```powershell
cd D:\CODEX
node scripts\futures-bulk-optimize.js --symbols RELIANCE,SBIN,TCS --from 2026-06-24 --to 2026-06-26
```

If a symbol contains `&`, quote the argument in PowerShell:

```powershell
node scripts\futures-bulk-optimize.js --symbols "NAM-INDIA,M&MFIN"
```

## Run From A Symbol File

The file can be `.txt`, `.csv`, or `.json`.

Text example:

```text
RELIANCE
SBIN
TCS
```

CSV example:

```csv
SYMBOL
RELIANCE
SBIN
TCS
```

JSON example:

```json
["RELIANCE", "SBIN", "TCS"]
```

Command:

```powershell
cd D:\CODEX
node scripts\futures-bulk-optimize.js --file D:\CODEX\data\my-symbols.csv --write-config
```

## Run A Named Universe

For NIFTY500 or any custom universe, place a local file here:

```text
D:\CODEX\data\universes\NIFTY500.csv
```

Then run:

```powershell
cd D:\CODEX
node scripts\futures-bulk-optimize.js --universe NIFTY500 --write-config
```

Built-in universe modes:

```powershell
node scripts\futures-bulk-optimize.js --universe FUTSTK --write-config
node scripts\futures-bulk-optimize.js --universe ALL_EQ --write-config
```

`--universe FUTSTK` also includes these NSE indexes automatically:

```text
NIFTY
BANKNIFTY
```

You can test indexes directly:

```powershell
node scripts\futures-bulk-optimize.js --symbols NIFTY,BANKNIFTY --from 2026-06-24 --to 2026-06-24
```

Preview a broad universe safely:

```powershell
node scripts\futures-bulk-optimize.js --universe FUTSTK --limit 3 --from 2026-06-24 --to 2026-06-24
```

The FUTSTK universe excludes Dhan/NSE test symbols and ignores far-future contracts by default:

```powershell
--max-fut-expiry-days 120
```

## Run One Symbol And Save Config

```powershell
cd D:\CODEX
node scripts\futures-bulk-optimize.js --symbol RELIANCE --write-config
```

## Run All NSE Stock Futures Later

```powershell
cd D:\CODEX
node scripts\futures-bulk-optimize.js --all --write-config
```

`--all` is the same as `--universe FUTSTK`.

## Useful Options

```powershell
node scripts\futures-bulk-optimize.js --symbol RELIANCE --years 3 --delay-ms 1500 --write-config
node scripts\futures-bulk-optimize.js --all --years 3 --delay-ms 2000 --write-config
```

For long Dhan runs, keep retries enabled or increase them:

```powershell
node scripts\futures-bulk-optimize.js --universe FUTSTK --write-config --delay-ms 2000 --retries 4
```

To re-run optimization from already downloaded 1-minute candle files without calling Dhan:

```powershell
node scripts\futures-bulk-optimize.js --universe FUTSTK --use-cache --write-config
```

To optimize only selected timeframes from cache:

```powershell
node scripts\futures-bulk-optimize.js --universe FUTSTK --use-cache --timeframes 1,5 --write-config
```

To save a different reward:risk optimization into a separate config file:

```powershell
node scripts\futures-bulk-optimize.js --universe FUTSTK --use-cache --target-rr 2 --config-file D:\CODEX\data\symbol-configs-rr2.json --write-config
node scripts\futures-bulk-optimize.js --universe FUTSTK --use-cache --target-rr 1 --config-file D:\CODEX\data\symbol-configs-rr1.json --write-config
```

To run only the last 3 months and selected timeframes:

```powershell
node scripts\futures-bulk-optimize.js --universe FUTSTK --use-cache --months 3 --timeframes 1,5,15 --target-rr 2 --config-file D:\CODEX\data\symbol-configs-3mo-rr2.json --write-config
```

## Output Files

Candles:

```text
D:\CODEX\data\futures-eligible-cash-candles\<UNDERLYING>\<TRADING_SYMBOL>_1m.json
```

Optimized configs:

```text
D:\CODEX\data\symbol-configs.json
```

Config keys are written as:

```text
NSE_EQ:<cashSecurityId>:1
NSE_EQ:<cashSecurityId>:5
NSE_EQ:<cashSecurityId>:15
NSE_EQ:<cashSecurityId>:60
NSE_EQ:<cashSecurityId>:D
```

This keeps timeframe-specific optimized settings separate from the existing single-symbol dashboard config.

## Important Caveats

This script uses NSE futures only as the eligibility list. The downloaded candle data is NSE cash/equity data.

Example: RELIANCE is included because it has active `FUTSTK` contracts, but the candle request uses RELIANCE cash security id `2885`, `NSE_EQ`, and `EQUITY`.

If you later want actual futures contract candles, we should create a separate utility because futures contracts are expiry-specific and would need contract stitching for a clean three-year series.

The dashboard will not automatically consume `NSE_EQ:<cashSecurityId>:timeframe` entries unless future futures/multiscript code is wired to read those keys.
