"""Parsers for NSE bhavcopy-style CSV and ZIP files."""

from __future__ import annotations

import re
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd


def normalize_column_name(value: object) -> str:
    text = str(value).strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def normalize_dataframe(df: pd.DataFrame, source_report: str, report_date: date) -> pd.DataFrame:
    normalized = df.copy()
    normalized.columns = [normalize_column_name(column) for column in normalized.columns]
    normalized.insert(0, "trade_date", report_date.isoformat())
    normalized.insert(1, "source_report", source_report)
    normalized = normalized.dropna(how="all")
    return normalized


def read_csv_from_path(path: Path) -> pd.DataFrame:
    try:
        return pd.read_csv(path)
    except pd.errors.ParserError:
        with path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle):
                header_probe = line.upper()
                if "SYMBOL" in header_probe and "SERIES" in header_probe:
                    return pd.read_csv(path, skiprows=line_number)
        raise


def read_csv_from_zip(path: Path) -> pd.DataFrame:
    with zipfile.ZipFile(path) as archive:
        csv_members = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if not csv_members:
            raise ValueError(f"No CSV file found inside {path}")
        with archive.open(csv_members[0]) as csv_file:
            return pd.read_csv(csv_file)


def read_bhavcopy(path: Path) -> pd.DataFrame:
    if path.suffix.lower() == ".zip":
        return read_csv_from_zip(path)
    return read_csv_from_path(path)


def process_bhavcopy_file(raw_path: Path, output_path: Path, source_report: str, report_date: date) -> Path:
    df = read_bhavcopy(raw_path)
    normalized = normalize_dataframe(df, source_report, report_date)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    normalized.to_csv(output_path, index=False)
    return output_path


def process_csv_file(raw_path: Path, output_path: Path, source_report: str, report_date: date) -> Path:
    df = read_csv_from_path(raw_path)
    normalized = normalize_dataframe(df, source_report, report_date)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    normalized.to_csv(output_path, index=False)
    return output_path
