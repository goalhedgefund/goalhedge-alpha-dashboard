"""Historical minute-candle backtester driven by Dhan data."""

from __future__ import annotations

import csv
import argparse
import logging
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from dhanhq import DhanContext, dhanhq

from .ai_scoring import passes_ai_filter
from .candle_builder import normalize_dhan_candles
from .config import DB_PATH, LOG_DIR, WATCHLIST, TradingConfig, load_dhan_credentials
from .database import TradingDatabase
from .indicators import build_indicator_snapshot
from .models import Candle
from .paper_trader import PaperTrader
from .strategy import evaluate_long_rules, generate_long_signal


logging.basicConfig(
    filename=LOG_DIR / "backtest.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)


@dataclass(frozen=True)
class BacktestSummary:
    candles: int
    trades: int
    closed_trades: int
    win_rate: float
    profit_factor: float
    total_pnl: float
    max_drawdown: float


class DhanHistoricalData:
    def __init__(self) -> None:
        credentials = load_dhan_credentials()
        context = DhanContext(client_id=credentials.client_id, access_token=credentials.access_token)
        self.client = dhanhq(context)

    def fetch_minute_candles(self, symbol: str, security_id: str, from_date: date, to_date: date) -> list[Candle]:
        payload = self.client.intraday_minute_data(
            security_id=security_id,
            exchange_segment="NSE_EQ",
            instrument_type="EQUITY",
            from_date=from_date.isoformat(),
            to_date=to_date.isoformat(),
        )
        return normalize_dhan_candles(symbol, payload)


def profit_factor_from_pnl(pnls: list[float]) -> float:
    gross_profit = sum(p for p in pnls if p > 0)
    gross_loss = abs(sum(p for p in pnls if p < 0))
    if gross_loss == 0:
        return float("inf") if gross_profit > 0 else 0.0
    return gross_profit / gross_loss


def max_drawdown_from_pnl(pnls: list[float]) -> float:
    equity = 0.0
    peak = 0.0
    worst = 0.0
    for pnl in pnls:
        equity += pnl
        peak = max(peak, equity)
        worst = min(worst, equity - peak)
    return worst


def fetch_last_n_trading_days(days: int) -> tuple[date, date]:
    end_date = date.today()
    start_date = end_date - timedelta(days=max(10, days * 2))
    return start_date, end_date


def build_backtest_database() -> TradingDatabase:
    backtest_db_path = Path(DB_PATH).with_name("backtest_trades.db")
    database = TradingDatabase(backtest_db_path)
    with database.connect() as connection:
        connection.execute("DELETE FROM trades")
        connection.execute("DELETE FROM candles")
    return database


def run_dhan_backtest(days: int = 10) -> BacktestSummary:
    historical = DhanHistoricalData()
    database = build_backtest_database()
    trader = PaperTrader(database=database, config=TradingConfig())
    config = TradingConfig()

    start_date, end_date = fetch_last_n_trading_days(days)
    all_candles: list[Candle] = []
    for symbol, security_id in WATCHLIST.items():
        candles = historical.fetch_minute_candles(symbol, security_id, start_date, end_date)
        logging.info("Fetched %s candles for %s", len(candles), symbol)
        all_candles.extend(candles)

    all_candles.sort(key=lambda candle: (candle.timestamp, candle.symbol))
    history_by_symbol: dict[str, list[Candle]] = {symbol: [] for symbol in WATCHLIST}
    for candle in all_candles:
        history = history_by_symbol.setdefault(candle.symbol, [])
        history.append(candle)
        trader.update_exits(candle)
        trader.square_off_intraday(candle)
        snapshot = build_indicator_snapshot(candle.symbol, history[-100:])
        if snapshot is None:
            continue
        rules, missing_values = evaluate_long_rules(snapshot)
        if missing_values:
            continue
        signal = generate_long_signal(snapshot)
        if signal is None:
            continue
        filtered = passes_ai_filter(signal, config.ai_score_threshold)
        if filtered:
            trader.enter_trade(filtered)

    closed = database.closed_trades()
    closed_pnls = [float(row["pnl"]) for row in closed]
    open_trades = database.open_trades()
    summary = BacktestSummary(
        candles=len(all_candles),
        trades=len(closed) + len(open_trades),
        closed_trades=len(closed),
        win_rate=float((sum(1 for pnl in closed_pnls if pnl > 0) / len(closed_pnls)) * 100) if closed_pnls else 0.0,
        profit_factor=profit_factor_from_pnl(closed_pnls),
        total_pnl=sum(closed_pnls),
        max_drawdown=max_drawdown_from_pnl(closed_pnls),
    )
    write_backtest_report(summary, closed_pnls)
    return summary


def write_backtest_report(summary: BacktestSummary, pnls: list[float]) -> None:
    output_dir = Path(__file__).resolve().parent.parent / "outputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    report_path = output_dir / "backtest_report.csv"
    with report_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["metric", "value"])
        writer.writerow(["candles", summary.candles])
        writer.writerow(["trades", summary.trades])
        writer.writerow(["closed_trades", summary.closed_trades])
        writer.writerow(["win_rate", round(summary.win_rate, 2)])
        writer.writerow(["profit_factor", round(summary.profit_factor, 2)])
        writer.writerow(["total_pnl", round(summary.total_pnl, 2)])
        writer.writerow(["max_drawdown", round(summary.max_drawdown, 2)])
        writer.writerow(["pnl_series", ";".join(str(round(pnl, 2)) for pnl in pnls)])


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a Dhan-backed 1-minute scalping backtest.")
    parser.add_argument("--days", type=int, default=10, help="Trading days to approximate in the backtest window.")
    args = parser.parse_args()

    summary = run_dhan_backtest(days=args.days)
    print(
        f"candles={summary.candles} trades={summary.trades} closed={summary.closed_trades} "
        f"win_rate={summary.win_rate:.2f}% profit_factor={summary.profit_factor:.2f} "
        f"total_pnl={summary.total_pnl:.2f} max_drawdown={summary.max_drawdown:.2f}"
    )


if __name__ == "__main__":
    main()
