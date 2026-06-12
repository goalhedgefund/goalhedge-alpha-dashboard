"""Deterministic rule-based strategy engine."""

from __future__ import annotations

from .models import IndicatorSnapshot, Signal


def evaluate_long_rules(snapshot: IndicatorSnapshot) -> tuple[dict[str, bool], list[str]]:
    missing_values: list[str] = []
    checks = {
        "vwap": snapshot.vwap,
        "ema9": snapshot.ema9,
        "ema20": snapshot.ema20,
        "rsi14": snapshot.rsi14,
        "previous_high": snapshot.previous_high,
    }
    for name, value in checks.items():
        if value is None:
            missing_values.append(name)

    rules = {
        "price_above_vwap": snapshot.vwap is not None and snapshot.close > snapshot.vwap,
        "ema9_above_ema20": snapshot.ema9 is not None and snapshot.ema20 is not None and snapshot.ema9 > snapshot.ema20,
        "rsi_above_55": snapshot.rsi14 is not None and snapshot.rsi14 > 55,
        "break_previous_high": snapshot.previous_high is not None and snapshot.close > snapshot.previous_high,
    }
    return rules, missing_values


def generate_long_signal(snapshot: IndicatorSnapshot) -> Signal | None:
    rules, missing_values = evaluate_long_rules(snapshot)
    if missing_values:
        return None

    if not all(rules.values()):
        return None

    reason = ", ".join(name for name, passed in rules.items() if passed)
    return Signal(
        symbol=snapshot.symbol,
        timestamp=snapshot.timestamp,
        side="BUY",
        price=snapshot.close,
        reason=reason,
        indicators=snapshot,
    )
