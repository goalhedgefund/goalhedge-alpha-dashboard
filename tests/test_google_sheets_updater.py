from datetime import date
import json

import pandas as pd
import pytest

from google_sheets_updater import (
    ALPHA_TAB_NAMES,
    dataframe_to_rows,
    merge_historical_rows,
    sanitize_cell,
    validate_json_safe_rows,
)


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
                "finite": 10.23455,
                "nan_value": float("nan"),
                "inf_value": float("inf"),
            }
        ]
    )

    assert dataframe_to_rows(df) == [
        ["trade_date", "symbol", "finite", "nan_value", "inf_value"],
        ["2026-06-05", "AAA", 10.23, "", ""],
    ]
    json.dumps(dataframe_to_rows(df), allow_nan=False)


def test_merge_historical_rows_outputs_json_safe_values():
    existing_rows = [
        ["trade_date", "symbol", "bad_value"],
        ["2026-06-04", "OLD", float("inf")],
        ["2026-06-05", "REPLACED", float("nan")],
    ]
    new_rows = [
        ["trade_date", "symbol", "bad_value"],
        ["2026-06-05", "NEW", float("-inf")],
    ]

    merged_rows = merge_historical_rows(existing_rows, new_rows, date(2026, 6, 5))

    assert merged_rows == [
        ["trade_date", "symbol", "bad_value"],
        ["2026-06-04", "OLD", ""],
        ["2026-06-05", "NEW", ""],
    ]
    json.dumps(merged_rows, allow_nan=False)


def test_sanitize_cell_recurses_through_nested_values():
    nested = {
        "items": [1, float("inf"), {"inner": float("-inf")}],
        "label": "ok",
    }

    assert sanitize_cell(nested) == {
        "items": [1, "", {"inner": ""}],
        "label": "ok",
    }


def test_validate_json_safe_rows_rejects_non_json_numbers():
    with pytest.raises(ValueError):
        validate_json_safe_rows([["header"], [float("inf")]])


def test_daily_ranking_tab_is_not_written():
    assert "Daily Ranking" not in ALPHA_TAB_NAMES
