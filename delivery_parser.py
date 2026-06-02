"""Parser for NSE full bhavcopy plus security deliverable data."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pandas as pd

from bhavcopy_parser import normalize_dataframe


def read_delivery_data(path: Path) -> pd.DataFrame:
    return pd.read_csv(path)


def process_delivery_file(raw_path: Path, output_path: Path, report_date: date) -> Path:
    df = read_delivery_data(raw_path)
    normalized = normalize_dataframe(df, "delivery_data", report_date)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    normalized.to_csv(output_path, index=False)
    return output_path
