"""Live Dhan data polling loop for completed one-minute candles."""

from __future__ import annotations

import argparse
import logging
import time
from datetime import date, timedelta
from pprint import pformat
from pathlib import Path

import pandas as pd
from dhanhq import DhanContext, dhanhq

from .ai_scoring import passes_ai_filter
from .candle_builder import normalize_dhan_candles
from .config import EXCHANGE_SEGMENT, INSTRUMENT_TYPE, LOG_DIR, WATCHLIST, TradingConfig, load_dhan_credentials
from .database import TradingDatabase
from .indicators import build_indicator_snapshot
from .paper_trader import PaperTrader
from .scanner import resolve_equity_security_id
from .strategy import evaluate_long_rules, generate_long_signal


def _configure_logging() -> Path:
    primary_log = LOG_DIR / "live_feed.log"
    fallback_log = Path.cwd() / "live_feed.log"
    try:
        logging.basicConfig(
            filename=primary_log,
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
        )
        return primary_log
    except PermissionError:
        logging.basicConfig(
            filename=fallback_log,
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(message)s",
        )
        logging.warning("Falling back to local log file at %s because %s is locked", fallback_log, primary_log)
        return fallback_log


LOG_FILE = _configure_logging()


def parse_dhan_error(payload: object) -> tuple[str | None, str | None]:
    if not isinstance(payload, dict):
        return None, None
    remarks = payload.get("remarks")
    if not isinstance(remarks, dict):
        return None, None
    return remarks.get("error_code"), remarks.get("error_message")


def print_candles(symbol: str, candles) -> None:
    latest = candles[-1]
    print(
        f"{latest.timestamp:%Y-%m-%d %H:%M} {symbol} "
        f"O:{latest.open:.2f} H:{latest.high:.2f} L:{latest.low:.2f} C:{latest.close:.2f} "
        f"V:{latest.volume:.0f}"
    )


def extract_last_price(payload: object) -> float | None:
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if isinstance(data, dict):
        nested_data = data.get("data")
        if isinstance(nested_data, dict):
            for exchange_payload in nested_data.values():
                if isinstance(exchange_payload, dict):
                    for security_payload in exchange_payload.values():
                        if isinstance(security_payload, dict):
                            value = security_payload.get("last_price")
                            if isinstance(value, (int, float)):
                                return float(value)
        for key in ("last_price", "ltp", "close", "price"):
            value = data.get(key)
            if isinstance(value, (int, float)):
                return float(value)
            if isinstance(value, list) and value:
                tail = value[-1]
                if isinstance(tail, (int, float)):
                    return float(tail)
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            for key in ("last_price", "ltp", "close", "price"):
                value = first.get(key)
                if isinstance(value, (int, float)):
                    return float(value)
    return None


class DhanMarketData:
    def __init__(self) -> None:
        credentials = load_dhan_credentials()
        context = DhanContext(client_id=credentials.client_id, access_token=credentials.access_token)
        self.client = dhanhq(context)
        self.security_master = self._load_security_master()

    def _load_security_master(self) -> pd.DataFrame | None:
        try:
            df = self.client.fetch_security_list()
            logging.info("Loaded security master with %s rows", len(df))
            return df
        except Exception:
            logging.exception("Unable to load security master")
            return None

    def resolve_security_id(self, symbol: str) -> str:
        security_id = resolve_equity_security_id(self.security_master, symbol)
        if security_id:
            return security_id
        return WATCHLIST.get(symbol, symbol)

    def fetch_quote_snapshot(self, security_id: str) -> object:
        securities = {EXCHANGE_SEGMENT: [int(security_id)]}
        try:
            return self.client.quote_data(securities)
        except TypeError:
            return self.client.quote_data({EXCHANGE_SEGMENT: int(security_id)})

    def fetch_recent_minute_candles(self, symbol: str, security_id: str, lookback_days: int = 1):
        today = date.today()
        from_date = today - timedelta(days=lookback_days)
        request_kwargs = {
            "security_id": security_id,
            "exchange_segment": EXCHANGE_SEGMENT,
            "instrument_type": INSTRUMENT_TYPE,
            "from_date": from_date.isoformat(),
            "to_date": today.isoformat(),
        }

        payload = self.client.intraday_minute_data(**request_kwargs)
        error_code, error_message = parse_dhan_error(payload)
        candles = normalize_dhan_candles(symbol, payload)
        logging.info(
            "Raw Dhan payload for %s (%s): type=%s candles=%s preview=%s",
            symbol,
            security_id,
            type(payload).__name__,
            len(candles),
            pformat(payload, compact=True, depth=2)[:1200],
        )
        if error_code:
            logging.warning("Dhan returned %s for %s (%s): %s", error_code, symbol, security_id, error_message)
        return candles, error_code


def backoff_seconds(error_code: str | None, attempt: int) -> int:
    if error_code == "DH-904":
        return min(180, max(30, 30 * attempt))
    return min(30, max(5, 5 * attempt))


def run_live_paper_trading(symbols: list[str] | None = None) -> None:
    config = TradingConfig()
    database = TradingDatabase()
    trader = PaperTrader(database=database, config=config)
    market_data = DhanMarketData()
    rate_limit_streak = 0

    selected_symbols = symbols or database.load_selected_symbols() or list(WATCHLIST.keys())
    logging.info("Starting paper-only live feed for %s", ", ".join(selected_symbols))
    while True:
        saw_rate_limit = False
        for symbol in selected_symbols:
            try:
                resolved_security_id = market_data.resolve_security_id(symbol)
                quote_payload = market_data.fetch_quote_snapshot(resolved_security_id)
                last_price = extract_last_price(quote_payload)
                logging.info(
                    "Quote payload for %s (%s): type=%s last_price=%s preview=%s",
                    symbol,
                    resolved_security_id,
                    type(quote_payload).__name__,
                    f"{last_price:.2f}" if last_price is not None else "None",
                    pformat(quote_payload, compact=True, depth=2)[:1200],
                )
                if last_price is not None:
                    print(f"QUOTE {symbol} ({resolved_security_id}) LTP:{last_price:.2f}")

                candles, error_code = market_data.fetch_recent_minute_candles(symbol, resolved_security_id)
                if not candles:
                    logging.warning("No candles returned for %s (%s)", symbol, resolved_security_id)
                    if error_code == "DH-904":
                        saw_rate_limit = True
                    continue

                latest = candles[-1]
                print_candles(symbol, candles)
                database.save_candles(candles)
                trader.update_exits(latest)
                trader.square_off_intraday(latest)

                recent = database.load_recent_candles(symbol, limit=100)
                snapshot = build_indicator_snapshot(symbol, recent)
                if snapshot is None:
                    continue

                rules, missing_values = evaluate_long_rules(snapshot)
                if missing_values:
                    logging.info(
                        "Waiting for indicator history on %s: missing=%s candle_count=%s",
                        symbol,
                        ",".join(missing_values),
                        len(recent),
                    )
                    continue

                signal = generate_long_signal(snapshot)
                if signal is None:
                    failed_rules = [name for name, passed in rules.items() if not passed]
                    logging.info(
                        "No signal for %s at %s: failed_rules=%s close=%.2f ema9=%s ema20=%s vwap=%s rsi14=%s previous_high=%s",
                        symbol,
                        snapshot.timestamp.isoformat(),
                        ",".join(failed_rules),
                        snapshot.close,
                        f"{snapshot.ema9:.2f}" if snapshot.ema9 is not None else "None",
                        f"{snapshot.ema20:.2f}" if snapshot.ema20 is not None else "None",
                        f"{snapshot.vwap:.2f}" if snapshot.vwap is not None else "None",
                        f"{snapshot.rsi14:.2f}" if snapshot.rsi14 is not None else "None",
                        f"{snapshot.previous_high:.2f}" if snapshot.previous_high is not None else "None",
                    )
                    continue

                filtered = passes_ai_filter(signal, config.ai_score_threshold)
                if filtered is None:
                    logging.info("Signal rejected by AI filter: %s", signal)
                    continue

                trade_id = trader.enter_trade(filtered)
                if trade_id:
                    logging.info("Paper BUY created: id=%s symbol=%s price=%s", trade_id, symbol, filtered.price)
            except Exception:
                logging.exception("Failed processing %s", symbol)
            time.sleep(1.0)

        if saw_rate_limit:
            rate_limit_streak += 1
            sleep_for = backoff_seconds("DH-904", rate_limit_streak)
            logging.warning("Rate limit detected; backing off for %s seconds", sleep_for)
            time.sleep(sleep_for)
        else:
            rate_limit_streak = 0

        time.sleep(config.refresh_seconds)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run AITrader live paper feed.")
    parser.add_argument("--symbol", action="append", dest="symbols", help="Trade only this symbol. Repeat to add more.")
    args = parser.parse_args()
    run_live_paper_trading(symbols=args.symbols)
