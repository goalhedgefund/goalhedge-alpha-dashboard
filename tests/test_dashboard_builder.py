from datetime import date

import pandas as pd

from dashboard_builder import (
    build_52w_high_scan,
    build_breakouts,
    build_delivery_leaders,
    build_fo_long_buildup,
    build_market_pulse,
)


def sample_delivery():
    return pd.DataFrame(
        [
            {
                "trade_date": "2026-06-02",
                "symbol": "AAA",
                "series": "EQ",
                "prev_close": 98,
                "close_price": 100,
                "turnover_lacs": 500,
                "deliv_qty": 10000,
                "deliv_per": 70,
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "BBB",
                "series": "EQ",
                "prev_close": 200,
                "close_price": 190,
                "turnover_lacs": 300,
                "deliv_qty": 5000,
                "deliv_per": 55,
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "LOWTURN",
                "series": "EQ",
                "prev_close": 48,
                "close_price": 50,
                "turnover_lacs": 99,
                "deliv_qty": 3000,
                "deliv_per": 95,
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "ABOVEHIGH",
                "series": "EQ",
                "prev_close": 99,
                "close_price": 110,
                "turnover_lacs": 250,
                "deliv_qty": 4000,
                "deliv_per": 80,
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "BEONLY",
                "series": "BE",
                "prev_close": 99,
                "close_price": 100,
                "turnover_lacs": 250,
                "deliv_qty": 7000,
                "deliv_per": 99,
            },
        ]
    )


def sample_week_52():
    return pd.DataFrame(
        [
            {
                "trade_date": "2026-06-02",
                "symbol": "AAA",
                "series": "EQ",
                "adjusted_52_week_high": 101,
                "52_week_high_date": "02-Jun-2026",
                "adjusted_52_week_low": 50,
                "52_week_low_dt": "01-Jan-2026",
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "BBB",
                "series": "EQ",
                "adjusted_52_week_high": 250,
                "52_week_high_date": "01-May-2026",
                "adjusted_52_week_low": 180,
                "52_week_low_dt": "02-Jun-2026",
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "LOWTURN",
                "series": "EQ",
                "adjusted_52_week_high": 50,
                "52_week_high_date": "02-Jun-2026",
                "adjusted_52_week_low": 25,
                "52_week_low_dt": "01-Jan-2026",
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "ABOVEHIGH",
                "series": "EQ",
                "adjusted_52_week_high": 100,
                "52_week_high_date": "02-Jun-2026",
                "adjusted_52_week_low": 50,
                "52_week_low_dt": "01-Jan-2026",
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "BEONLY",
                "series": "BE",
                "adjusted_52_week_high": 101,
                "52_week_high_date": "02-Jun-2026",
                "adjusted_52_week_low": 50,
                "52_week_low_dt": "01-Jan-2026",
            },
        ]
    )


def test_market_pulse_builds_daily_summary():
    result = build_market_pulse(sample_delivery(), sample_week_52(), date(2026, 6, 2))

    assert result.loc[0, "trade_date"] == "2026-06-02"
    assert result.loc[0, "advances"] == 4
    assert result.loc[0, "declines"] == 1
    assert result.loc[0, "new_52w_high_count"] == 4


def test_52w_high_scan_filters_current_highs():
    result = build_52w_high_scan(sample_week_52(), date(2026, 6, 2))

    assert list(result["symbol"]) == ["BEONLY", "AAA", "ABOVEHIGH", "LOWTURN"]


def test_breakouts_finds_symbols_near_52w_high():
    result = build_breakouts(sample_delivery(), sample_week_52(), date(2026, 6, 2))

    assert list(result["symbol"]) == ["AAA"]
    assert result.loc[0, "distance_from_52w_high_pct"] < 2
    assert "LOWTURN" not in set(result["symbol"])
    assert "ABOVEHIGH" not in set(result["symbol"])
    assert "BEONLY" not in set(result["symbol"])


def test_delivery_leaders_sort_by_delivery_percent():
    result = build_delivery_leaders(sample_delivery())

    assert list(result["symbol"]) == ["LOWTURN", "ABOVEHIGH", "AAA", "BBB"]


def test_fo_long_buildup_filters_futures_with_price_and_oi_gain():
    fo = pd.DataFrame(
        [
            {
                "trade_date": "2026-06-02",
                "fininstrmtp": "STF",
                "tckrsymb": "AAA",
                "fininstrmnm": "AAA26JUNFUT",
                "xprydt": "2026-06-30",
                "clspric": 105,
                "prvsclsgpric": 100,
                "opnintrst": 1200,
                "chnginopnintrst": 200,
                "ttltradgvol": 50,
            }
        ]
    )

    result = build_fo_long_buildup(fo)

    assert list(result["symbol"]) == ["AAA"]
    assert result.loc[0, "oi_change"] == 200


