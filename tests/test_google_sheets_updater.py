from datetime import date

import pandas as pd

from google_sheets_updater import dataframe_to_rows, sanitize_cell


def test_sanitize_cell_converts_non_json_numbers_to_blank():
    assert sanitize_cell(float("nan")) == ""
    assert sanitize_cell(float("inf")) == ""
    assert sanitize_cell(float("-inf")) == ""
    assert sanitize_cell(pd.NA) == ""


def test_dataframe_to_rows_outputs_json_safe_values():
    df = pd.DataFrame(
        [
            {
                "trade_date": date(2026, 6, 5),
                "symbol": "AAA",
                "finite": 10.5,
                "nan_value": float("nan"),
                "inf_value": float("inf"),
            }
        ]
    )

    assert dataframe_to_rows(df) == [
        ["trade_date", "symbol", "finite", "nan_value", "inf_value"],
        ["2026-06-05", "AAA", 10.5, "", ""],
    ]
