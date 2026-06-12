"""Utilities for normalizing and storing 1-minute candles."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .models import Candle


def _parse_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        raw = float(value)
        if raw > 10_000_000_000:
            raw = raw / 1000
        return datetime.fromtimestamp(raw, tz=timezone.utc).replace(tzinfo=None)
    text = str(value)
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%d-%m-%Y %H:%M:%S"):
        try:
            return datetime.strptime(text[:19], fmt)
        except ValueError:
            pass
    return datetime.fromisoformat(text)


def _column_payload_to_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return data if isinstance(data, list) else []

    keys = ["timestamp", "start_Time", "open", "high", "low", "close", "volume"]
    lengths = [len(data[key]) for key in keys if key in data and isinstance(data[key], list)]
    if not lengths:
        return []
    row_count = min(lengths)
    rows: list[dict[str, Any]] = []
    for index in range(row_count):
        rows.append({key: data[key][index] for key in data if isinstance(data[key], list)})
    return rows


def normalize_dhan_candles(symbol: str, payload: dict[str, Any]) -> list[Candle]:
    rows = _column_payload_to_rows(payload)
    candles: list[Candle] = []
    for row in rows:
        timestamp_value = (
            row.get("timestamp")
            or row.get("start_Time")
            or row.get("start_time")
            or row.get("time")
            or row.get("date")
        )
        if timestamp_value is None:
            continue
        candles.append(
            Candle(
                symbol=symbol,
                timestamp=_parse_timestamp(timestamp_value),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row.get("volume", 0) or 0),
            )
        )
    return sorted(candles, key=lambda candle: candle.timestamp)

