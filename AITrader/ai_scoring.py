"""AI-style scoring filter.

This module intentionally does not generate trades. It only scores signals
already produced by deterministic strategy rules.
"""

from __future__ import annotations

from datetime import time

from .models import Signal


def score_trade(signal: Signal) -> int:
    snapshot = signal.indicators
    score = 50

    if snapshot.vwap and snapshot.close > snapshot.vwap:
        distance = (snapshot.close - snapshot.vwap) / snapshot.vwap
        score += min(12, int(distance * 1000))

    if snapshot.ema9 and snapshot.ema20 and snapshot.ema9 > snapshot.ema20:
        spread = (snapshot.ema9 - snapshot.ema20) / snapshot.ema20
        score += min(12, int(spread * 2000))

    if snapshot.rsi14 is not None:
        if 55 <= snapshot.rsi14 <= 70:
            score += 12
        elif snapshot.rsi14 > 75:
            score -= 8

    market_open = time(9, 15)
    avoid_first_noise = time(9, 20)
    late_scalp_cutoff = time(14, 45)
    trade_time = signal.timestamp.time()
    if avoid_first_noise <= trade_time <= late_scalp_cutoff:
        score += 10
    elif market_open <= trade_time < avoid_first_noise:
        score -= 5

    return max(0, min(100, score))


def passes_ai_filter(signal: Signal, threshold: int) -> Signal | None:
    score = score_trade(signal)
    if score < threshold:
        return None
    return Signal(
        symbol=signal.symbol,
        timestamp=signal.timestamp,
        side=signal.side,
        price=signal.price,
        reason=f"{signal.reason}, ai_score={score}",
        indicators=signal.indicators,
        ai_score=score,
    )
