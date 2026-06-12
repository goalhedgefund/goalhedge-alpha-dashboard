"""Indicator calculations for one-minute scalping candles."""

from __future__ import annotations

from .models import Candle, IndicatorSnapshot


def calculate_ema(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    multiplier = 2 / (period + 1)
    ema = sum(values[:period]) / period
    for value in values[period:]:
        ema = (value - ema) * multiplier + ema
    return ema


def calculate_vwap(candles: list[Candle]) -> float | None:
    total_volume = sum(candle.volume for candle in candles)
    if not candles or total_volume <= 0:
        return None
    total_price_volume = sum(
        ((candle.high + candle.low + candle.close) / 3) * candle.volume for candle in candles
    )
    return total_price_volume / total_volume


def calculate_rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    gains: list[float] = []
    losses: list[float] = []
    for previous, current in zip(values[-period - 1 : -1], values[-period:]):
        change = current - previous
        gains.append(max(change, 0))
        losses.append(abs(min(change, 0)))
    average_gain = sum(gains) / period
    average_loss = sum(losses) / period
    if average_loss == 0:
        return 100.0
    relative_strength = average_gain / average_loss
    return 100 - (100 / (1 + relative_strength))


def calculate_volume_ratio(candles: list[Candle], lookback: int = 20) -> float | None:
    if len(candles) < 2:
        return None
    history = candles[-lookback - 1 : -1]
    if not history:
        return None
    average_volume = sum(candle.volume for candle in history) / len(history)
    if average_volume <= 0:
        return None
    return candles[-1].volume / average_volume


def build_indicator_snapshot(symbol: str, candles: list[Candle]) -> IndicatorSnapshot | None:
    if not candles:
        return None
    closes = [candle.close for candle in candles]
    latest = candles[-1]
    previous = candles[-2] if len(candles) >= 2 else None
    return IndicatorSnapshot(
        symbol=symbol,
        timestamp=latest.timestamp,
        close=latest.close,
        ema9=calculate_ema(closes, 9),
        ema20=calculate_ema(closes, 20),
        vwap=calculate_vwap(candles),
        rsi14=calculate_rsi(closes, 14),
        previous_high=previous.high if previous else None,
    )
