from datetime import date
from pathlib import Path
import zipfile

import pandas as pd

from bhavcopy_parser import normalize_column_name, process_bhavcopy_file, process_csv_file
from delivery_parser import process_delivery_file


def test_normalize_column_name_removes_spaces_and_symbols():
    assert normalize_column_name("Tot Trd Val (Lacs)") == "tot_trd_val_lacs"


def test_process_bhavcopy_file_reads_zip_and_writes_normalized_csv(tmp_path: Path):
    csv_text = "SYMBOL,SERIES,OPEN_PRICE,CLOSE_PRICE\nSBIN,EQ,800.10,805.25\n"
    zip_path = tmp_path / "bhavcopy.zip"
    output_path = tmp_path / "processed.csv"

    with zipfile.ZipFile(zip_path, "w") as archive:
        archive.writestr("BhavCopy_NSE_CM.csv", csv_text)

    process_bhavcopy_file(zip_path, output_path, "cm_bhavcopy", date(2026, 5, 22))

    result = pd.read_csv(output_path)
    assert list(result.columns) == [
        "trade_date",
        "source_report",
        "symbol",
        "series",
        "open_price",
        "close_price",
    ]
    assert result.loc[0, "trade_date"] == "2026-05-22"
    assert result.loc[0, "source_report"] == "cm_bhavcopy"


def test_process_delivery_file_writes_normalized_csv(tmp_path: Path):
    raw_path = tmp_path / "delivery.csv"
    output_path = tmp_path / "delivery_processed.csv"
    raw_path.write_text(
        "SYMBOL, SERIES, DELIV_QTY, DELIV_PER\nSBIN, EQ, 1000, 52.5\n",
        encoding="utf-8",
    )

    process_delivery_file(raw_path, output_path, date(2026, 5, 22))

    result = pd.read_csv(output_path)
    assert "deliv_qty" in result.columns
    assert result.loc[0, "source_report"] == "delivery_data"


def test_process_csv_file_handles_nse_preamble_rows(tmp_path: Path):
    raw_path = tmp_path / "high_low.csv"
    output_path = tmp_path / "high_low_processed.csv"
    raw_path.write_text(
        '"Disclaimer row with comma, and another comma"\n'
        '"Effective for 01-Jun-2026"\n'
        '"SYMBOL","SERIES","Adjusted_52_Week_High","52_Week_High_Date"\n'
        '"SBIN","EQ","900.00","01-JUN-2026"\n',
        encoding="utf-8",
    )

    process_csv_file(raw_path, output_path, "week_52_high_low", date(2026, 6, 1))

    result = pd.read_csv(output_path)
    assert "adjusted_52_week_high" in result.columns
    assert result.loc[0, "symbol"] == "SBIN"


def test_process_csv_file_outputs_empty_52w_file_for_malformed_nse_response(tmp_path: Path):
    raw_path = tmp_path / "malformed_high_low.csv"
    output_path = tmp_path / "high_low_processed.csv"
    raw_path.write_text(
        "temporary response\n"
        "line two\n"
        "line,with,two,extra,fields\n",
        encoding="utf-8",
    )

    process_csv_file(raw_path, output_path, "week_52_high_low", date(2026, 6, 5))

    result = pd.read_csv(output_path)
    assert list(result.columns) == [
        "trade_date",
        "source_report",
        "symbol",
        "series",
        "adjusted_52_week_high",
        "52_week_high_date",
        "adjusted_52_week_low",
        "52_week_low_dt",
    ]
    assert result.empty
