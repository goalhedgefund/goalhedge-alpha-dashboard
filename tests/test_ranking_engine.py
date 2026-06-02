from datetime import date

import pandas as pd

from ranking_engine import (
    build_alpha_outputs,
    filter_stock_universe,
    near_52w_high_score,
    score_ranking,
)


def test_near_52w_high_score_rewards_closeness():
    scores = near_52w_high_score(
        pd.Series([100, 90, 50]),
        pd.Series([100, 100, 100]),
    )

    assert list(scores) == [100, 0, 0]


def test_score_ranking_outputs_alpha_score_between_zero_and_100(tmp_path):
    universe = pd.DataFrame(
        [
            {
                "trade_date": "2026-06-02",
                "symbol": "AAA",
                "series": "EQ",
                "close_price_num": 100,
                "adjusted_52_week_high_num": 101,
                "volume_num": 100000,
                "delivery_qty_num": 60000,
                "delivery_percent_num": 60,
                "turnover_lacs_num": 1000,
                "volume_expansion_ratio": pd.NA,
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "BBB",
                "series": "EQ",
                "close_price_num": 50,
                "adjusted_52_week_high_num": 100,
                "volume_num": 1000,
                "delivery_qty_num": 200,
                "delivery_percent_num": 10,
                "turnover_lacs_num": 10,
                "volume_expansion_ratio": pd.NA,
            },
        ]
    )

    result = score_ranking(universe, tmp_path)

    assert result["alpha_score"].between(0, 100).all()
    assert result.iloc[0]["symbol"] == "AAA"


def test_filter_stock_universe_removes_etfs_and_special_symbols():
    delivery = pd.DataFrame(
        [
            {"symbol": "AAA", "series": "EQ"},
            {"symbol": "LIQUIDIETF", "series": "EQ"},
            {"symbol": "1STCUS$", "series": "EQ"},
            {"symbol": "BBB", "series": "BE"},
        ]
    )

    result = filter_stock_universe(delivery)

    assert list(result["symbol"]) == ["AAA"]


def test_build_alpha_outputs_writes_expected_tables(tmp_path):
    processed_dir = tmp_path / "processed"
    config_dir = tmp_path / "config"
    processed_dir.mkdir()
    config_dir.mkdir()

    pd.DataFrame(
        [
            {
                "trade_date": "2026-06-02",
                "symbol": "AAA",
                "series": "EQ",
                "prev_close": 98,
                "close_price": 100,
                "ttl_trd_qnty": 100000,
                "turnover_lacs": 1000,
                "deliv_qty": 60000,
                "deliv_per": 60,
            },
            {
                "trade_date": "2026-06-02",
                "symbol": "BBB",
                "series": "EQ",
                "prev_close": 50,
                "close_price": 51,
                "ttl_trd_qnty": 5000,
                "turnover_lacs": 200,
                "deliv_qty": 2000,
                "deliv_per": 30,
            },
        ]
    ).to_csv(processed_dir / "delivery_data_20260602.csv", index=False)

    pd.DataFrame(
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
                "adjusted_52_week_high": 100,
                "52_week_high_date": "01-May-2026",
                "adjusted_52_week_low": 40,
                "52_week_low_dt": "01-Jan-2026",
            },
        ]
    ).to_csv(processed_dir / "week_52_high_low_20260602.csv", index=False)

    outputs = build_alpha_outputs(processed_dir, config_dir, date(2026, 6, 2))

    assert set(outputs) == {"daily_ranking", "top_20_for_tomorrow", "sector_leaders"}
    assert list(outputs["daily_ranking"]["symbol"]) == ["AAA", "BBB"]
    assert len(outputs["top_20_for_tomorrow"]) == 2
