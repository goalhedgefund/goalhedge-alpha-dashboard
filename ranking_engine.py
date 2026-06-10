"""GoalHedge Alpha ranking engine."""

from __future__ import annotations

import argparse
import logging
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from dashboard_builder import parse_nse_date_series, read_processed_csv, to_number


LOGGER = logging.getLogger("ranking_engine")
ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
PROCESSED_DIR = DATA_DIR / "processed"
CONFIG_DIR = ROOT_DIR / "config"

WEIGHTS = {
    "near_52w_high": 20,
    "volume_expansion": 15,
    "delivery_strength": 15,
    "earnings_growth": 20,
    "roce": 10,
    "sector_leadership": 10,
    "commentary_score": 10,
}

OPTIONAL_INPUTS = {
    "fundamentals": CONFIG_DIR / "fundamentals.csv",
    "sector_mapping": CONFIG_DIR / "sector_mapping.csv",
    "commentary": CONFIG_DIR / "commentary_scores.csv",
}
EXCLUDED_SYMBOL_PATTERNS = (
    "ETF",
    "BEES",
    "LIQUID",
    "GOLD",
    "SILVER",
    "NIFTY",
    "BANKNIFTY",
    "SENSEX",
    "TOP50",
    "MON100",
    "MONQ50",
)


def parse_run_date(value: str | None) -> date:
    if value:
        return datetime.strptime(value, "%Y-%m-%d").date()
    ist = timezone(timedelta(hours=5, minutes=30))
    return datetime.now(ist).date()


def percentile_score(series: pd.Series, higher_is_better: bool = True) -> pd.Series:
    numeric = to_number(series).fillna(0)
    if numeric.nunique(dropna=True) <= 1:
        return pd.Series(50.0, index=series.index)
    score = numeric.rank(pct=True) * 100
    if not higher_is_better:
        score = 100 - score
    return score.clip(0, 100)


def near_52w_high_score(close_price: pd.Series, high_52w: pd.Series) -> pd.Series:
    close_num = to_number(close_price)
    high_num = to_number(high_52w)
    distance_pct = ((high_num - close_num) / high_num * 100).clip(lower=0)
    return (100 - (distance_pct * 10)).clip(0, 100).fillna(0)


def normalize_symbol_column(df: pd.DataFrame) -> pd.DataFrame:
    normalized = df.copy()
    if "symbol" in normalized.columns:
        normalized["symbol"] = normalized["symbol"].astype(str).str.strip()
    if "series" in normalized.columns:
        normalized["series"] = normalized["series"].astype(str).str.strip()
    return normalized


def filter_stock_universe(delivery: pd.DataFrame) -> pd.DataFrame:
    stocks = delivery[delivery["series"].eq("EQ")].copy()
    symbols = stocks["symbol"].astype(str).str.upper()
    is_excluded = symbols.str.contains("|".join(EXCLUDED_SYMBOL_PATTERNS), regex=True)
    has_special_suffix = symbols.str.contains(r"[$-]", regex=True)
    starts_with_digit = symbols.str.match(r"^\d")
    return stocks[~is_excluded & ~has_special_suffix & ~starts_with_digit].copy()


def read_optional_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        LOGGER.info("Optional ranking input missing, using neutral defaults: %s", path)
        return pd.DataFrame()
    return pd.read_csv(path)


def load_previous_delivery(processed_dir: Path, report_date: date) -> pd.DataFrame:
    candidates = sorted(processed_dir.glob("delivery_data_*.csv"), reverse=True)
    current_name = f"delivery_data_{report_date.strftime('%Y%m%d')}.csv"
    for path in candidates:
        if path.name != current_name:
            return pd.read_csv(path)
    return pd.DataFrame()


def apply_optional_inputs(ranking: pd.DataFrame, config_dir: Path) -> pd.DataFrame:
    result = ranking.copy()

    fundamentals = normalize_symbol_column(read_optional_csv(config_dir / "fundamentals.csv"))
    if not fundamentals.empty:
        keep_cols = [col for col in ("symbol", "earnings_growth_pct", "roce_pct") if col in fundamentals.columns]
        result = result.merge(fundamentals[keep_cols], on="symbol", how="left")
    else:
        result["earnings_growth_pct"] = pd.NA
        result["roce_pct"] = pd.NA

    sector_mapping = normalize_symbol_column(read_optional_csv(config_dir / "sector_mapping.csv"))
    if not sector_mapping.empty and {"symbol", "sector"}.issubset(sector_mapping.columns):
        result = result.merge(sector_mapping[["symbol", "sector"]], on="symbol", how="left")
    else:
        result["sector"] = "Unclassified"

    commentary = normalize_symbol_column(read_optional_csv(config_dir / "commentary_scores.csv"))
    if not commentary.empty and {"symbol", "commentary_score"}.issubset(commentary.columns):
        result = result.merge(commentary[["symbol", "commentary_score"]], on="symbol", how="left")
    else:
        result["commentary_score"] = pd.NA

    return result


def build_base_universe(processed_dir: Path, report_date: date) -> pd.DataFrame:
    delivery = normalize_symbol_column(read_processed_csv(processed_dir, "delivery_data", report_date))
    week_52 = normalize_symbol_column(read_processed_csv(processed_dir, "week_52_high_low", report_date))
    previous_delivery = normalize_symbol_column(load_previous_delivery(processed_dir, report_date))

    delivery = filter_stock_universe(delivery)
    delivery["close_price_num"] = to_number(delivery["close_price"])
    delivery["volume_num"] = to_number(delivery["ttl_trd_qnty"])
    delivery["delivery_qty_num"] = to_number(delivery["deliv_qty"])
    delivery["delivery_percent_num"] = to_number(delivery["deliv_per"])
    delivery["turnover_lacs_num"] = to_number(delivery["turnover_lacs"])

    week_52["adjusted_52_week_high_num"] = to_number(week_52["adjusted_52_week_high"])
    week_52["high_date"] = parse_nse_date_series(week_52["52_week_high_date"])

    universe = delivery.merge(
        week_52[
            [
                "symbol",
                "series",
                "adjusted_52_week_high_num",
                "52_week_high_date",
                "adjusted_52_week_low",
                "52_week_low_dt",
            ]
        ],
        on=["symbol", "series"],
        how="left",
    )

    if not previous_delivery.empty and {"symbol", "series", "ttl_trd_qnty"}.issubset(previous_delivery.columns):
        previous = previous_delivery[previous_delivery["series"].eq("EQ")].copy()
        previous["previous_volume_num"] = to_number(previous["ttl_trd_qnty"])
        universe = universe.merge(
            previous[["symbol", "series", "previous_volume_num"]],
            on=["symbol", "series"],
            how="left",
        )
        universe["volume_expansion_ratio"] = universe["volume_num"] / universe["previous_volume_num"]
    else:
        universe["previous_volume_num"] = pd.NA
        universe["volume_expansion_ratio"] = pd.NA

    return universe


def score_ranking(universe: pd.DataFrame, config_dir: Path) -> pd.DataFrame:
    ranking = apply_optional_inputs(universe, config_dir)

    ranking["near_52w_high_score"] = near_52w_high_score(
        ranking["close_price_num"],
        ranking["adjusted_52_week_high_num"],
    )
    ranking["distance_from_52w_high_pct"] = (
        (ranking["adjusted_52_week_high_num"] - ranking["close_price_num"])
        / ranking["adjusted_52_week_high_num"]
        * 100
    ).clip(lower=0)
    if ranking["volume_expansion_ratio"].notna().any():
        ranking["volume_expansion_score"] = percentile_score(ranking["volume_expansion_ratio"])
    else:
        ranking["volume_expansion_score"] = percentile_score(ranking["volume_num"])

    ranking["delivery_strength_score"] = (
        percentile_score(ranking["delivery_qty_num"]) * 0.6
        + percentile_score(ranking["delivery_percent_num"]) * 0.4
    )
    ranking["earnings_growth_score"] = percentile_score(ranking["earnings_growth_pct"]).where(
        ranking["earnings_growth_pct"].notna(),
        50,
    )
    ranking["roce_score"] = percentile_score(ranking["roce_pct"]).where(ranking["roce_pct"].notna(), 50)
    ranking["commentary_score_component"] = to_number(ranking["commentary_score"]).clip(0, 100).fillna(50)

    market_component = (
        ranking["near_52w_high_score"] * 0.4
        + ranking["volume_expansion_score"] * 0.3
        + ranking["delivery_strength_score"] * 0.3
    )
    if "sector" in ranking.columns:
        ranking["sector_leadership_score"] = market_component.groupby(ranking["sector"]).rank(pct=True) * 100
    else:
        ranking["sector_leadership_score"] = percentile_score(market_component)

    ranking["alpha_score"] = (
        ranking["near_52w_high_score"] * WEIGHTS["near_52w_high"]
        + ranking["volume_expansion_score"] * WEIGHTS["volume_expansion"]
        + ranking["delivery_strength_score"] * WEIGHTS["delivery_strength"]
        + ranking["earnings_growth_score"] * WEIGHTS["earnings_growth"]
        + ranking["roce_score"] * WEIGHTS["roce"]
        + ranking["sector_leadership_score"] * WEIGHTS["sector_leadership"]
        + ranking["commentary_score_component"] * WEIGHTS["commentary_score"]
    ) / 100

    ranking["alpha_score"] = ranking["alpha_score"].round(2).clip(0, 100)
    return ranking.sort_values("alpha_score", ascending=False)


def select_output_columns(ranking: pd.DataFrame) -> pd.DataFrame:
    output = ranking.copy()
    output["rank"] = range(1, len(output) + 1)
    columns = [
        "trade_date",
        "rank",
        "symbol",
        "alpha_score",
        "close_price_num",
        "volume_num",
        "delivery_qty_num",
        "delivery_percent_num",
        "distance_from_52w_high_pct",
        "volume_expansion_score",
        "delivery_strength_score",
        "sector",
    ]
    return output[columns].rename(
        columns={
            "close_price_num": "close_price",
            "volume_num": "volume",
            "delivery_qty_num": "delivery_qty",
            "delivery_percent_num": "delivery_percent",
            "commentary_score_component": "commentary_score",
        }
    )


def identify_sector_leaders(ranking: pd.DataFrame) -> pd.DataFrame:
    output = select_output_columns(ranking)
    leaders = output.sort_values(["sector", "alpha_score"], ascending=[True, False])
    return leaders.groupby("sector", as_index=False).head(1).sort_values("alpha_score", ascending=False)


def build_alpha_outputs(processed_dir: Path, config_dir: Path, report_date: date) -> dict[str, pd.DataFrame]:
    universe = build_base_universe(processed_dir, report_date)
    ranking = score_ranking(universe, config_dir)
    daily_ranking = select_output_columns(ranking)
    return {
        "daily_ranking": daily_ranking,
        "top_20_for_tomorrow": daily_ranking.head(20),
        "sector_leaders": identify_sector_leaders(ranking),
    }


def write_alpha_outputs(processed_dir: Path, config_dir: Path, report_date: date) -> dict[str, Path]:
    outputs = build_alpha_outputs(processed_dir, config_dir, report_date)
    date_key = report_date.strftime("%Y%m%d")
    paths = {
        "daily_ranking": processed_dir / f"alpha_rankings_{date_key}.csv",
        "top_20_for_tomorrow": processed_dir / f"top_20_for_tomorrow_{date_key}.csv",
        "sector_leaders": processed_dir / f"sector_leaders_{date_key}.csv",
    }
    for key, output_path in paths.items():
        outputs[key].to_csv(output_path, index=False)
        LOGGER.info("Wrote %s rows to %s", len(outputs[key]), output_path)
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description="Build GoalHedge Alpha ranking outputs.")
    parser.add_argument("--date", help="Report date in YYYY-MM-DD format. Defaults to today in IST.")
    parser.add_argument("--processed-dir", type=Path, default=PROCESSED_DIR)
    parser.add_argument("--config-dir", type=Path, default=CONFIG_DIR)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    write_alpha_outputs(args.processed_dir, args.config_dir, parse_run_date(args.date))


if __name__ == "__main__":
    main()
