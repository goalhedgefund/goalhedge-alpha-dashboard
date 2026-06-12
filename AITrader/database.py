"""SQLite persistence for candles and paper trades."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path

from .config import DB_PATH
from .models import Candle, Trade


SCHEMA = """
CREATE TABLE IF NOT EXISTS candles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL DEFAULT 0,
    UNIQUE(timestamp, symbol)
);

CREATE INDEX IF NOT EXISTS idx_candles_symbol_timestamp
ON candles(symbol, timestamp);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    quantity INTEGER NOT NULL,
    target REAL NOT NULL,
    stoploss REAL NOT NULL,
    pnl REAL NOT NULL DEFAULT 0,
    strategy_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_timestamp TEXT,
    exit_reason TEXT
);

CREATE TABLE IF NOT EXISTS symbol_selection (
    symbol TEXT PRIMARY KEY,
    selected INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS symbol_candidates (
    symbol TEXT PRIMARY KEY,
    security_id TEXT NOT NULL,
    price REAL NOT NULL,
    sma200 REAL,
    eligible INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT '200dma',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


class TradingDatabase:
    def __init__(self, db_path: Path = DB_PATH) -> None:
        self.db_path = db_path
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def initialize(self) -> None:
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(symbol_candidates)").fetchall()
            }
            if "sma200" not in columns:
                if "vwap" in columns:
                    connection.execute("ALTER TABLE symbol_candidates RENAME TO symbol_candidates_legacy")
                    connection.execute(
                        """
                        CREATE TABLE symbol_candidates (
                            symbol TEXT PRIMARY KEY,
                            security_id TEXT NOT NULL,
                            price REAL NOT NULL,
                            sma200 REAL,
                            eligible INTEGER NOT NULL DEFAULT 0,
                            source TEXT NOT NULL DEFAULT '200dma',
                            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                        """
                    )
                    connection.execute(
                        """
                        INSERT INTO symbol_candidates(symbol, security_id, price, sma200, eligible, source, updated_at)
                        SELECT symbol, security_id, price, vwap, eligible, source, updated_at
                        FROM symbol_candidates_legacy
                        """
                    )
                    connection.execute("DROP TABLE symbol_candidates_legacy")
                else:
                    connection.execute(
                        """
                        CREATE TABLE IF NOT EXISTS symbol_candidates (
                            symbol TEXT PRIMARY KEY,
                            security_id TEXT NOT NULL,
                            price REAL NOT NULL,
                            sma200 REAL,
                            eligible INTEGER NOT NULL DEFAULT 0,
                            source TEXT NOT NULL DEFAULT '200dma',
                            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                        """
                    )

    def save_candle(self, candle: Candle) -> None:
        self.save_candles([candle])

    def save_candles(self, candles: Iterable[Candle]) -> None:
        rows = [
            (
                candle.timestamp.isoformat(),
                candle.symbol,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume,
            )
            for candle in candles
        ]
        if not rows:
            return
        with self.connect() as connection:
            connection.executemany(
                """
                INSERT OR REPLACE INTO candles
                (timestamp, symbol, open, high, low, close, volume)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

    def load_recent_candles(self, symbol: str, limit: int = 100) -> list[Candle]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT timestamp, symbol, open, high, low, close, volume
                FROM candles
                WHERE symbol = ?
                ORDER BY timestamp DESC
                LIMIT ?
                """,
                (symbol, limit),
            ).fetchall()
        candles = [
            Candle(
                symbol=row["symbol"],
                timestamp=datetime.fromisoformat(row["timestamp"]),
                open=row["open"],
                high=row["high"],
                low=row["low"],
                close=row["close"],
                volume=row["volume"],
            )
            for row in rows
        ]
        return list(reversed(candles))

    def create_trade(self, trade: Trade) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO trades
                (timestamp, symbol, entry_price, exit_price, quantity, target, stoploss,
                 pnl, strategy_name, reason, status, exit_timestamp, exit_reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trade.timestamp.isoformat(),
                    trade.symbol,
                    trade.entry_price,
                    trade.exit_price,
                    trade.quantity,
                    trade.target,
                    trade.stoploss,
                    trade.pnl,
                    trade.strategy_name,
                    trade.reason,
                    trade.status,
                    trade.exit_timestamp.isoformat() if trade.exit_timestamp else None,
                    trade.exit_reason,
                ),
            )
            return int(cursor.lastrowid)

    def close_trade(self, trade_id: int, exit_price: float, exit_timestamp: str, exit_reason: str, pnl: float) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE trades
                SET exit_price = ?, exit_timestamp = ?, exit_reason = ?, pnl = ?, status = 'CLOSED'
                WHERE id = ? AND status = 'OPEN'
                """,
                (exit_price, exit_timestamp, exit_reason, pnl, trade_id),
            )

    def has_open_trade(self, symbol: str) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM trades WHERE symbol = ? AND status = 'OPEN' LIMIT 1",
                (symbol,),
            ).fetchone()
        return row is not None

    def open_trades(self) -> list[sqlite3.Row]:
        with self.connect() as connection:
            return list(connection.execute("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY timestamp"))

    def closed_trades(self, limit: int = 200) -> list[sqlite3.Row]:
        with self.connect() as connection:
            return list(
                connection.execute(
                    "SELECT * FROM trades WHERE status = 'CLOSED' ORDER BY exit_timestamp DESC LIMIT ?",
                    (limit,),
                )
            )

    def upsert_symbol_selection(self, symbol: str, selected: bool, source: str = "manual") -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO symbol_selection(symbol, selected, source, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(symbol) DO UPDATE SET
                    selected = excluded.selected,
                    source = excluded.source,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (symbol, 1 if selected else 0, source),
            )

    def load_selected_symbols(self) -> list[str]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT symbol FROM symbol_selection WHERE selected = 1 ORDER BY symbol"
            ).fetchall()
        return [row["symbol"] for row in rows]

    def load_symbol_selection(self) -> list[sqlite3.Row]:
        with self.connect() as connection:
            return list(connection.execute("SELECT * FROM symbol_selection ORDER BY symbol"))

    def upsert_symbol_candidate(self, symbol: str, security_id: str, price: float, sma200: float | None, eligible: bool, source: str = "200dma") -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO symbol_candidates(symbol, security_id, price, sma200, eligible, source, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(symbol) DO UPDATE SET
                    security_id = excluded.security_id,
                    price = excluded.price,
                    sma200 = excluded.sma200,
                    eligible = excluded.eligible,
                    source = excluded.source,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (symbol, security_id, price, sma200, 1 if eligible else 0, source),
            )

    def load_symbol_candidates(self) -> list[sqlite3.Row]:
        with self.connect() as connection:
            return list(connection.execute("SELECT * FROM symbol_candidates ORDER BY eligible DESC, symbol"))
