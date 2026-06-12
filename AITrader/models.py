"""Shared data models."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Candle:
    symbol: str
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass(frozen=True)
class IndicatorSnapshot:
    symbol: str
    timestamp: datetime
    close: float
    ema9: float | None
    ema20: float | None
    vwap: float | None
    rsi14: float | None
    previous_high: float | None


@dataclass(frozen=True)
class Signal:
    symbol: str
    timestamp: datetime
    side: str
    price: float
    reason: str
    indicators: IndicatorSnapshot
    ai_score: int | None = None


@dataclass
class Trade:
    symbol: str
    timestamp: datetime
    entry_price: float
    quantity: int
    target: float
    stoploss: float
    strategy_name: str
    reason: str
    status: str = "OPEN"
    exit_price: float | None = None
    exit_timestamp: datetime | None = None
    exit_reason: str | None = None
    pnl: float = 0.0
