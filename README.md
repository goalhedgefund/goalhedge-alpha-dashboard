# goalhedge-alpha-dashboard

GoalHedge Alpha Dashboard data automation.

## NSE EOD Data Pipeline

This repository downloads and processes NSE end-of-day files from the official NSE All Reports pages:

- CM UDiFF bhavcopy
- Full bhavcopy and security deliverable data
- F&O UDiFF bhavcopy
- 52 week high/low report

Raw files are saved under `data/raw/YYYYMMDD/`. After a successful run, older raw folders and older processed files are removed so the repository workspace only keeps the latest completed report date plus the previous trading day. Existing non-empty raw files are reused, so rerunning the same date does not download the same NSE files again. Google Sheets preserves historical dashboard rows separately.

## Local Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Run the Pipeline

Run for today in IST:

```bash
python nse_downloader.py
```

Run for a specific NSE report date:

```bash
python nse_downloader.py --date 2026-05-22
```

By default, the downloader only processes the requested date. If you intentionally want fallback during local investigation, use `--lookback-days`:

```bash
python nse_downloader.py --date 2026-05-25 --lookback-days 7
```

## Tests

```bash
pytest
```

## GitHub Actions

The workflow `.github/workflows/daily_nse_download.yml` runs Monday to Friday at `17:15 UTC` / `22:45 IST`, which gives NSE end-of-day files more time to publish after market close. It can also be run manually from the GitHub Actions tab with an optional `YYYY-MM-DD` date.

The workflow:

1. Installs Python dependencies.
2. Runs parser unit tests.
3. Downloads the raw NSE files.
4. Generates processed CSVs.
5. Updates the GoalHedge Alpha Dashboard Google Sheet when Google credentials are configured.
6. Uploads `data/raw/` and `data/processed/` as workflow artifacts.

## Google Sheets Dashboard

The dashboard updater writes daily snapshots to these tabs:

- `Market Pulse`
- `52W High Scan`
- `Breakouts`
- `Delivery Leaders`
- `F&O Long Build-up`
- `Top 20 Stocks for Tomorrow`
- `Sector Leaders`

Historical rows are preserved. If the same report date is run again, rows for that date are replaced so the dashboard does not duplicate the day.

Create a Google Cloud service account with Google Sheets API access, share the `GoalHedge Alpha Dashboard` sheet with the service account email as an editor, then configure GitHub authentication.

Recommended keyless GitHub Actions authentication uses Workload Identity Federation. Add these GitHub repository secrets:

- `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`: provider resource name, for example `projects/162548456743/locations/global/workloadIdentityPools/github-actions/providers/goalhedge-github`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: service account email shared on the Google Sheet
- `GOOGLE_SHEET_ID`: optional; defaults to `1-8pJRIEiKZpaJyXoeK9sjQC9EIgcuyVhtAUp8xEBylA`

JSON-key authentication is also supported for environments that allow service account keys:

- `GOOGLE_SERVICE_ACCOUNT_JSON`: the full service account JSON content

Run locally after the NSE pipeline:

```bash
export GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account", ...}'
python google_sheets_updater.py --date 2026-06-02
```

On Windows PowerShell:

```powershell
$env:GOOGLE_SERVICE_ACCOUNT_JSON = '{"type":"service_account", ...}'
python google_sheets_updater.py --date 2026-06-02
```

## Alpha Ranking Engine

The ranking engine creates an `alpha_score` from 0 to 100 using these weights:

- Near 52W High: 20
- Volume Expansion: 15
- Delivery Strength: 15
- Earnings Growth: 20
- ROCE: 10
- Sector Leadership: 10
- Commentary Score: 10

Run locally after the NSE pipeline:

```bash
python ranking_engine.py --date 2026-06-02
```

Outputs are written to `data/processed/`:

- `alpha_rankings_YYYYMMDD.csv`
- `top_20_for_tomorrow_YYYYMMDD.csv`
- `sector_leaders_YYYYMMDD.csv`

Optional enrichment files live in `config/`:

- `fundamentals.csv`: `symbol,earnings_growth_pct,roce_pct`
- `sector_mapping.csv`: `symbol,sector`
- `commentary_scores.csv`: `symbol,commentary_score`

When optional enrichment is missing for a stock, the engine uses a neutral score for that component so the cloud workflow can still run every day.

## Notes

NSE report availability may lag after market close or be absent on holidays. The pipeline logs each attempted report date and fails clearly if it cannot download a complete daily bundle.
