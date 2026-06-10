"""Update GoalHedge Alpha Dashboard tabs in Google Sheets."""

from __future__ import annotations

import argparse
import json
import logging
import math
import numbers
import os
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, TypeVar

import gspread
import google.auth
import pandas as pd
from gspread.exceptions import APIError, WorksheetNotFound
from google.oauth2.service_account import Credentials

from dashboard_builder import PROCESSED_DIR, TAB_NAMES, build_dashboard_tables, parse_run_date
from ranking_engine import CONFIG_DIR, build_alpha_outputs


LOGGER = logging.getLogger("google_sheets_updater")
DEFAULT_SPREADSHEET_ID = "1-8pJRIEiKZpaJyXoeK9sjQC9EIgcuyVhtAUp8xEBylA"
SCOPES = ("https://www.googleapis.com/auth/spreadsheets",)
F = TypeVar("F", bound=Callable[..., Any])
ALPHA_TAB_NAMES = {
    "Top 20 Stocks for Tomorrow": "top_20_for_tomorrow",
    "Sector Leaders": "sector_leaders",
}
OBSOLETE_TAB_NAMES = ("Daily Ranking",)


def retry(operation: F, attempts: int = 3, delay_seconds: float = 2.0) -> F:
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                return operation(*args, **kwargs)
            except (APIError, TimeoutError, ConnectionError) as exc:
                last_error = exc
                if attempt == attempts:
                    break
                sleep_for = delay_seconds * attempt
                LOGGER.warning("%s failed on attempt %d/%d: %s", operation.__name__, attempt, attempts, exc)
                time.sleep(sleep_for)
        raise RuntimeError(f"{operation.__name__} failed after {attempts} attempts") from last_error

    return wrapped  # type: ignore[return-value]


def load_credentials() -> Credentials:
    raw_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    credentials_path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")

    if raw_json:
        info = json.loads(raw_json)
        return Credentials.from_service_account_info(info, scopes=SCOPES)
    if credentials_path:
        return Credentials.from_service_account_file(credentials_path, scopes=SCOPES)

    credentials, _ = google.auth.default(scopes=SCOPES)
    return credentials


def get_or_create_worksheet(spreadsheet: Any, title: str, rows: int = 1000, cols: int = 20) -> Any:
    try:
        return spreadsheet.worksheet(title)
    except WorksheetNotFound:
        LOGGER.info("Creating worksheet: %s", title)
        return spreadsheet.add_worksheet(title=title, rows=rows, cols=cols)


def clear_all_worksheets(spreadsheet: Any) -> None:
    for worksheet in retry(spreadsheet.worksheets)():
        LOGGER.info("Clearing worksheet: %s", worksheet.title)
        retry(worksheet.clear)()


def sanitize_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return value
    if isinstance(value, (str, int)):
        return value
    if hasattr(value, "item"):
        try:
            return sanitize_cell(value.item())
        except ValueError:
            pass
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, numbers.Real):
        numeric_value = float(value)
        if not math.isfinite(numeric_value):
            return ""
        return int(numeric_value) if numeric_value.is_integer() else round(numeric_value, 2)
    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass
    if isinstance(value, (list, tuple)):
        return [sanitize_cell(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitize_cell(item) for key, item in value.items()}
    return value


def dataframe_to_rows(df: pd.DataFrame) -> list[list[Any]]:
    rows = [[str(column) for column in df.columns]]
    rows.extend([[sanitize_cell(value) for value in row] for row in df.itertuples(index=False, name=None)])
    return rows


def sanitize_rows(rows: list[list[Any]]) -> list[list[Any]]:
    return [[sanitize_cell(value) for value in row] for row in rows]


def validate_json_safe_rows(rows: list[list[Any]]) -> None:
    json.dumps(rows, allow_nan=False)


def update_worksheet(worksheet: Any, table: pd.DataFrame, report_date: date) -> None:
    rows = sanitize_rows(dataframe_to_rows(table))
    validate_json_safe_rows(rows)
    retry(worksheet.clear)()
    if rows:
        retry(worksheet.update)(range_name="A1", values=rows, value_input_option="USER_ENTERED")


def update_google_sheet(processed_dir: Path, report_date: date, spreadsheet_id: str, config_dir: Path = CONFIG_DIR) -> None:
    credentials = load_credentials()
    client = gspread.authorize(credentials)
    spreadsheet = retry(client.open_by_key)(spreadsheet_id)
    clear_all_worksheets(spreadsheet)
    tables = build_dashboard_tables(processed_dir, report_date)
    alpha_outputs = build_alpha_outputs(processed_dir, config_dir, report_date)

    for tab_name in OBSOLETE_TAB_NAMES:
        try:
            worksheet = spreadsheet.worksheet(tab_name)
        except WorksheetNotFound:
            continue
        LOGGER.info("Deleting obsolete worksheet: %s", tab_name)
        retry(spreadsheet.del_worksheet)(worksheet)

    for tab_name in TAB_NAMES:
        table = tables[tab_name]
        worksheet = get_or_create_worksheet(
            spreadsheet,
            tab_name,
            rows=max(len(table) + 250, 1000),
            cols=max(len(table.columns) + 5, 20),
        )
        LOGGER.info("Updating %s with %d rows for %s", tab_name, len(table), report_date.isoformat())
        update_worksheet(worksheet, table, report_date)

    for tab_name, output_key in ALPHA_TAB_NAMES.items():
        table = alpha_outputs[output_key]
        worksheet = get_or_create_worksheet(
            spreadsheet,
            tab_name,
            rows=max(len(table) + 250, 1000),
            cols=max(len(table.columns) + 5, 20),
        )
        LOGGER.info("Updating %s with %d rows for %s", tab_name, len(table), report_date.isoformat())
        update_worksheet(worksheet, table, report_date)


def main() -> None:
    parser = argparse.ArgumentParser(description="Update GoalHedge Alpha Dashboard in Google Sheets.")
    parser.add_argument("--date", help="Report date in YYYY-MM-DD format. Defaults to today in IST.")
    parser.add_argument("--processed-dir", type=Path, default=PROCESSED_DIR)
    parser.add_argument("--config-dir", type=Path, default=CONFIG_DIR)
    parser.add_argument(
        "--spreadsheet-id",
        default=os.environ.get("GOOGLE_SHEET_ID", DEFAULT_SPREADSHEET_ID),
        help="Google Sheet ID. Defaults to GoalHedge Alpha Dashboard.",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    update_google_sheet(args.processed_dir, parse_run_date(args.date), args.spreadsheet_id, args.config_dir)


if __name__ == "__main__":
    main()
