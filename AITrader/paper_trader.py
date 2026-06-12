"""Paper trade creation and exit management."""

from __future__ import annotations

from datetime import time

from .config import TradingConfig
from .database import TradingDatabase
from .models import Candle, Signal, Trade


MARKET_CLOSE = time(15, 30)


class PaperTrader:
    def __init__(self, database: TradingDatabase, config: TradingConfig) -> None:
        self.database = database
        self.config = config

    def enter_trade(self, signal: Signal) -> int | None:
        if self.database.has_open_trade(signal.symbol):
            return None
        entry = signal.price
        trade = Trade(
            symbol=signal.symbol,
            timestamp=signal.timestamp,
            entry_price=entry,
            quantity=self.config.default_quantity,
            target=round(entry * (1 + self.config.target_pct), 2),
            stoploss=round(entry * (1 - self.config.stoploss_pct), 2),
            strategy_name=self.config.strategy_name,
            reason=signal.reason,
        )
        return self.database.create_trade(trade)

    def update_exits(self, candle: Candle) -> None:
        for trade in self.database.open_trades():
            if trade["symbol"] != candle.symbol:
                continue
            exit_price = None
            exit_reason = None
            if candle.low <= trade["stoploss"]:
                exit_price = trade["stoploss"]
                exit_reason = "STOPLOSS"
            elif candle.high >= trade["target"]:
                exit_price = trade["target"]
                exit_reason = "TARGET"

            if exit_price is None:
                continue

            pnl = (exit_price - trade["entry_price"]) * trade["quantity"]
            self.database.close_trade(
                trade_id=trade["id"],
                exit_price=exit_price,
                exit_timestamp=candle.timestamp.isoformat(),
                exit_reason=exit_reason,
                pnl=round(pnl, 2),
            )

    def square_off_intraday(self, candle: Candle) -> None:
        if candle.timestamp.time() < MARKET_CLOSE:
            return

        for trade in self.database.open_trades():
            if trade["symbol"] != candle.symbol:
                continue

            pnl = (candle.close - trade["entry_price"]) * trade["quantity"]
            self.database.close_trade(
                trade_id=trade["id"],
                exit_price=round(candle.close, 2),
                exit_timestamp=candle.timestamp.isoformat(),
                exit_reason="EOD_SQUARE_OFF",
                pnl=round(pnl, 2),
            )
