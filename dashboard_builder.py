"""Build GoalHedge dashboard tables from processed NSE CSV files."""

from __future__ import annotations

import argparse
import logging
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd


LOGGER = logging.getLogger("dashboard_builder")
ROOT_DIR = Path(__file__).resolve().parent
PROCESSED_DIR = ROOT_DIR / "data" / "processed"


TAB_NAMES = (
    "Market Pulse",
    "52W High Scan",
    "Breakouts",
    "Delivery Leaders",
    "F&O Long Build-up",
)


def parse_run_date(value: str | None) -> date:
    if value:
        return datetime.strptime(value, "%Y-%m-%d").date()
    ist = timezone(timedelta(hours=5, minutes=30))
    return datetime.now(ist).date()


def read_processed_csv(processed_dir: Path, key: str, report_date: date) -> pd.DataFrame:
    path = processed_dir / f"{key}_{report_date.strftime('%Y%m%d')}.csv"
    if not path.exists():
        raise FileNotFoundError(f"Missing processed file: {path}")
    return pd.read_csv(path)


def to_number(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series.astype(str).str.strip().replace({"-": "", "": None}), errors="coerce")


def parse_nse_date_series(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series.astype(str).str.strip(), format="%d-%b-%Y", errors="coerce").dt.date


def normalize_symbol_series(df: pd.DataFrame) -> pd.DataFrame:
    normalized = df.copy()
    for column in ("symbol", "series"):
        if column in normalized.columns:
            normalized[column] = normalized[column].astype(str).str.strip()
    return normalized


def clean_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    clean_df = df.copy()
    clean_df = clean_df.replace({pd.NA: None})
    clean_df = clean_df.where(pd.notna(clean_df), None)
    return clean_df.to_dict(orient="records")


def build_market_pulse(delivery: pd.DataFrame, week_52: pd.DataFrame, report_date: date) -> pd.DataFrame:
    delivery = normalize_symbol_series(delivery)
    week_52 = normalize_symbol_series(week_52)
    delivery["close_price_num"] = to_number(delivery["close_price"])
    delivery["prev_close_num"] = to_number(delivery["prev_close"])
    delivery["turnover_lacs_num"] = to_number(delivery["turnover_lacs"])
    delivery["deliv_per_num"] = to_number(delivery["deliv_per"])
    delivery["deliv_qty_num"] = to_number(delivery["deliv_qty"])

    high_dates = parse_nse_date_series(week_52["52_week_high_date"])
    low_dates = parse_nse_date_series(week_52["52_week_low_dt"])

    advances = int((delivery["close_price_num"] > delivery["prev_close_num"]).sum())
    declines = int((delivery["close_price_num"] < delivery["prev_close_num"]).sum())
    unchanged = int((delivery["close_price_num"] == delivery["prev_close_num"]).sum())

    return pd.DataFrame(
        [
            {
                "trade_date": report_date.isoformat(),
                "symbols_traded": int(delivery["symbol"].nunique()),
                "advances": advances,
                "declines": declines,
                "unchanged": unchanged,
                "advance_decline_ratio": round(advances / declines, 2) if declines else advances,
                "total_turnover_lacs": round(float(delivery["turnover_lacs_num"].sum()), 2),
                "total_delivery_qty": int(delivery["deliv_qty_num"].sum()),
                "avg_delivery_percent": round(float(delivery["deliv_per_num"].mean()), 2),
                "new_52w_high_count": int((high_dates == report_date).sum()),
                "new_52w_low_count": int((low_dates == report_date).sum()),
            }
        ]
    )


def build_52w_high_scan(week_52: pd.DataFrame, report_date: date) -> pd.DataFrame:
    scan = normalize_symbol_series(week_52)
    scan["high_date"] = parse_nse_date_series(scan["52_week_high_date"])
    scan["adjusted_52_week_high_num"] = to_number(scan["adjusted_52_week_high"])
    scan = scan[scan["high_date"] == report_date]
    scan = scan.sort_values(["series", "symbol"]).head(500)
    return scan[
        [
            "trade_date",
            "symbol",
            "series",
            "adjusted_52_week_high_num",
            "52_week_high_date",
            "adjusted_52_week_low",
            "52_week_low_dt",
        ]
    ].rename(columns={"adjusted_52_week_high_num": "adjusted_52_week_high"})


def build_breakouts(delivery: pd.DataFrame, week_52: pd.DataFrame, report_date: date) -> pd.DataFrame:
    delivery = normalize_symbol_series(delivery)
    week_52 = normalize_symbol_series(week_52)
    delivery["close_price_num"] = to_number(delivery["close_price"])
    delivery["prev_close_num"] = to_number(delivery["prev_close"])
    delivery["turnover_lacs_num"] = to_number(delivery["turnover_lacs"])
    delivery["deliv_per_num"] = to_number(delivery["deliv_per"])
    week_52["adjusted_52_week_high_num"] = to_number(week_52["adjusted_52_week_high"])

    merged = delivery.merge(
        week_52[["symbol", "series", "adjusted_52_week_high_num", "52_week_high_date"]],
        on=["symbol", "series"],
        how="inner",
    )
    merged = merged[(merged["adjusted_52_week_high_num"] > 0) & (merged["close_price_num"] > 0)]
    merged["distance_from_52w_high_pct"] = (
        (merged["adjusted_52_week_high_num"] - merged["close_price_num"])
        / merged["adjusted_52_week_high_num"]
        * 100
    )
    merged["close_change_pct"] = (
        (merged["close_price_num"] - merged["prev_close_num"]) / merged["prev_close_num"] * 100
    )
    breakouts = merged[merged["distance_from_52w_high_pct"] <= 2.0]
    breakouts = breakouts.sort_values(
        ["distance_from_52w_high_pct", "turnover_lacs_num"],
        ascending=[True, False],
    ).head(200)
    return breakouts[
        [
            "trade_date",
            "symbol",
            "series",
            "close_price_num",
            "adjusted_52_week_high_num",
            "distance_from_52w_high_pct",
            "close_change_pct",
            "turnover_lacs_num",
            "deliv_per_num",
            "52_week_high_date",
        ]
    ].rename(
        columns={
            "close_price_num": "close_price",
            "adjusted_52_week_high_num": "adjusted_52_week_high",
            "turnover_lacs_num": "turnover_lacs",
            "deliv_per_num": "delivery_percent",
        }
    )


def build_delivery_leaders(delivery: pd.DataFrame) -> pd.DataFrame:
    leaders = normalize_symbol_series(delivery)
    leaders["deliv_qty_num"] = to_number(leaders["deliv_qty"])
    leaders["deliv_per_num"] = to_number(leaders["deliv_per"])
    leaders["turnover_lacs_num"] = to_number(leaders["turnover_lacs"])
    leaders["close_price_num"] = to_number(leaders["close_price"])
    leaders = leaders[leaders["deliv_qty_num"] > 0]
    leaders = leaders.sort_values(["deliv_qty_num", "deliv_per_num"], ascending=[False, False]).head(100)
    return leaders[
        [
            "trade_date",
            "symbol",
            "series",
            "close_price_num",
            "deliv_qty_num",
            "deliv_per_num",
            "turnover_lacs_num",
        ]
    ].rename(
        columns={
            "close_price_num": "close_price",
            "deliv_qty_num": "delivery_qty",
            "deliv_per_num": "delivery_percent",
            "turnover_lacs_num": "turnover_lacs",
        }
    )


def build_fo_long_buildup(fo: pd.DataFrame) -> pd.DataFrame:
    futures = fo[fo["fininstrmtp"].isin(["STF", "IDF"])].copy()
    futures["close_price_num"] = to_number(futures["clspric"])
    futures["prev_close_num"] = to_number(futures["prvsclsgpric"])
    futures["oi_num"] = to_number(futures["opnintrst"])
    futures["oi_change_num"] = to_number(futures["chnginopnintrst"])
    futures["volume_num"] = to_number(futures["ttltradgvol"])
    futures["price_change_pct"] = (
        (futures["close_price_num"] - futures["prev_close_num"]) / futures["prev_close_num"] * 100
    )
    futures["oi_change_pct"] = futures["oi_change_num"] / (futures["oi_num"] - futures["oi_change_num"]) * 100
    long_buildup = futures[(futures["price_change_pct"] > 0) & (futures["oi_change_num"] > 0)]
    long_buildup = long_buildup.sort_values(["oi_change_num", "volume_num"], ascending=[False, False]).head(100)
    return long_buildup[
        [
            "trade_date",
            "tckrsymb",
            "fininstrmnm",
            "xprydt",
            "close_price_num",
            "price_change_pct",
            "oi_num",
            "oi_change_num",
            "oi_change_pct",
            "volume_num",
        ]
    ].rename(
        columns={
            "tckrsymb": "symbol",
            "fininstrmnm": "instrument",
            "xprydt": "expiry",
            "close_price_num": "close_price",
            "oi_num": "open_interest",
            "oi_change_num": "oi_change",
            "volume_num": "volume",
        }
    )


def build_dashboard_tables(processed_dir: Path, report_date: date) -> dict[str, pd.DataFrame]:
    delivery = read_processed_csv(processed_dir, "delivery_data", report_date)
    week_52 = read_processed_csv(processed_dir, "week_52_high_low", report_date)
    fo = read_processed_csv(processed_dir, "fo_bhavcopy", report_date)

    return {
        "Market Pulse": build_market_pulse(delivery, week_52, report_date),
        "52W High Scan": build_52w_high_scan(week_52, report_date),
        "Breakouts": build_breakouts(delivery, week_52, report_date),
        "Delivery Leaders": build_delivery_leaders(delivery),
        "F&O Long Build-up": build_fo_long_buildup(fo),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build dashboard tables from processed NSE files.")
    parser.add_argument("--date", help="Report date in YYYY-MM-DD format. Defaults to today in IST.")
    parser.add_argument("--processed-dir", type=Path, default=PROCESSED_DIR)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    report_date = parse_run_date(args.date)
    tables = build_dashboard_tables(args.processed_dir, report_date)
    for name, table in tables.items():
        LOGGER.info("%s: %d rows", name, len(table))


if __name__ == "__main__":
    main()
