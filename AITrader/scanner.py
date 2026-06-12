"""Universe scanners for 200DMA-based selection."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from dhanhq import DhanContext, dhanhq
import pandas as pd

from .candle_builder import normalize_dhan_candles
from .config import EXCHANGE_SEGMENT, INSTRUMENT_TYPE, load_dhan_credentials
from .models import Candle


@dataclass(frozen=True)
class UniverseSymbol:
    symbol: str
    security_id: str


def resolve_equity_security_id(security_master, symbol: str) -> str | None:
    if security_master is None or getattr(security_master, "empty", True):
        return None

    matches = security_master[
        security_master["SEM_TRADING_SYMBOL"].astype(str).str.fullmatch(symbol, case=False, na=False)
    ]
    if matches.empty:
        return None

    if "SEM_SERIES" in matches.columns:
        eq_matches = matches[matches["SEM_SERIES"].astype(str).str.upper().eq("EQ")]
        if not eq_matches.empty:
            return str(eq_matches.iloc[0]["SEM_SMST_SECURITY_ID"]).strip()

    return str(matches.iloc[0]["SEM_SMST_SECURITY_ID"]).strip()


def load_imported_symbol_names(csv_path: str | Path) -> list[str]:
    path = Path(csv_path)
    if not path.exists():
        return []

    df = pd.read_csv(path, usecols=["SEM_TRADING_SYMBOL"], low_memory=False)
    symbols: list[str] = []
    seen: set[str] = set()
    for value in df["SEM_TRADING_SYMBOL"].astype(str):
        symbol = value.strip()
        if symbol and symbol not in seen:
            seen.add(symbol)
            symbols.append(symbol)
    return symbols


def resolve_universe_symbols(security_master, imported_symbols: list[str] | None = None) -> list[UniverseSymbol]:
    if security_master is None or getattr(security_master, "empty", True):
        return []

    symbols = imported_symbols if imported_symbols else list(security_master["SEM_TRADING_SYMBOL"].astype(str))
    wanted = {str(symbol).strip() for symbol in symbols if str(symbol).strip()}
    filtered = security_master[
        security_master["SEM_TRADING_SYMBOL"].astype(str).str.strip().isin(wanted)
    ]
    universe: list[UniverseSymbol] = []
    for symbol in dict.fromkeys(filtered["SEM_TRADING_SYMBOL"].astype(str).map(str.strip).tolist()):
        security_id = resolve_equity_security_id(security_master, symbol)
        if security_id:
            universe.append(UniverseSymbol(symbol=str(symbol).strip(), security_id=security_id))
    return universe


def is_above_vwap(latest_close: float, vwap: float | None) -> bool:
    return vwap is not None and latest_close > vwap


def is_near_reference(price: float, reference: float | None, pct: float) -> bool:
    if reference is None or reference <= 0:
        return False
    return abs(price - reference) / reference <= pct


def load_historical_client():
    credentials = load_dhan_credentials()
    context = DhanContext(client_id=credentials.client_id, access_token=credentials.access_token)
    return dhanhq(context)


def fetch_latest_minute_candles(client, security_id: str, lookback_days: int = 1, symbol: str = "") -> list[Candle]:
    today = date.today()
    from_date = today - timedelta(days=lookback_days)
    payload = client.intraday_minute_data(
        security_id=security_id,
        exchange_segment=EXCHANGE_SEGMENT,
        instrument_type=INSTRUMENT_TYPE,
        from_date=from_date.isoformat(),
        to_date=today.isoformat(),
    )
    return normalize_dhan_candles(symbol or security_id, payload)


def fetch_daily_candles(client, security_id: str, lookback_days: int = 220, symbol: str = "") -> list[Candle]:
    today = date.today()
    from_date = today - timedelta(days=lookback_days)
    payload = client.historical_daily_data(
        security_id=security_id,
        exchange_segment=EXCHANGE_SEGMENT,
        instrument_type=INSTRUMENT_TYPE,
        from_date=from_date.isoformat(),
        to_date=today.isoformat(),
    )
    return normalize_dhan_candles(symbol or security_id, payload)


def rank_top_by_traded_value(universe: list[UniverseSymbol], client, top_n: int = 5) -> list[UniverseSymbol]:
    ranked: list[tuple[float, UniverseSymbol]] = []
    for item in universe:
        candles = fetch_daily_candles(client, item.security_id, lookback_days=10, symbol=item.symbol)
        if not candles:
            continue
        recent = candles[-5:]
        traded_value = sum(c.close * c.volume for c in recent if c.volume is not None)
        ranked.append((traded_value, item))
    ranked.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in ranked[:top_n]]


def rank_top_n_by_traded_value(universe: list[UniverseSymbol], client, top_n: int = 20) -> list[dict[str, object]]:
    ranked: list[dict[str, object]] = []
    for item in universe:
        candles = fetch_daily_candles(client, item.security_id, lookback_days=10, symbol=item.symbol)
        if not candles:
            continue
        recent = candles[-5:]
        traded_value = sum(c.close * c.volume for c in recent if c.volume is not None)
        last_close = candles[-1].close
        ranked.append(
            {
                "symbol": item.symbol,
                "security_id": item.security_id,
                "traded_value": traded_value,
                "last_close": last_close,
            }
        )
    ranked.sort(key=lambda row: row["traded_value"], reverse=True)
    for idx, row in enumerate(ranked, start=1):
        row["rank"] = idx
    return ranked[:top_n]


def scan_near_200dma(universe: list[UniverseSymbol], client, pct: float = 0.03) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for item in universe:
        candles = fetch_daily_candles(client, item.security_id, symbol=item.symbol)
        if len(candles) < 200:
            continue
        closes = [c.close for c in candles]
        sma200 = sum(closes[-200:]) / 200
        price = closes[-1]
        if abs(price - sma200) / sma200 <= pct:
            matches.append(
                {
                    "symbol": item.symbol,
                    "security_id": item.security_id,
                    "price": price,
                    "sma200": sma200,
                    "distance_pct": abs(price - sma200) / sma200 * 100,
                }
            )
    return matches


def scan_combined_candidates(universe: list[UniverseSymbol], client, dma_pct: float = 0.03) -> list[dict[str, object]]:
    combined: list[dict[str, object]] = []
    for item in universe:
        daily_candles = fetch_daily_candles(client, item.security_id, symbol=item.symbol)
        if len(daily_candles) < 200:
            continue
        closes = [c.close for c in daily_candles]
        sma200 = sum(closes[-200:]) / 200
        price = closes[-1]
        if abs(price - sma200) / sma200 > dma_pct:
            continue

        combined.append(
            {
                "symbol": item.symbol,
                "security_id": item.security_id,
                "price": price,
                "sma200": sma200,
                "eligible": True,
                "distance_to_200dma_pct": abs(price - sma200) / sma200 * 100,
                "source": "dma200",
            }
        )
    return combined
