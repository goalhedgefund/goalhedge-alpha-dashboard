"""Runtime configuration for the AI scalping paper-trading system."""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType


CONFIG_DIR = Path(r"C:\NSE Monitor")
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
EXTERNAL_CONFIG_PATH = CONFIG_DIR / "config.py"

LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(__file__).resolve().parent.parent / "trades.db"


WATCHLIST = {
    "RELIANCE": "2885",
    "HDFCBANK": "1333",
    "ICICIBANK": "4963",
    "SBIN": "3045",
    "INFY": "1594",
    "TCS": "11536",
}

EXCHANGE_SEGMENT = "NSE_EQ"
INSTRUMENT_TYPE = "EQUITY"


@dataclass(frozen=True)
class TradingConfig:
    strategy_name: str = "vwap_ema_rsi_volume_breakout"
    refresh_seconds: int = 60
    default_quantity: int = 1
    target_pct: float = 0.003
    stoploss_pct: float = 0.0015
    ai_score_threshold: int = 70
    paper_trading_only: bool = True
    near_vwap_pct: float = 0.003
    near_200dma_pct: float = 0.03


@dataclass(frozen=True)
class DhanCredentials:
    client_id: str
    access_token: str
    api_key: str | None = None


def _load_external_config() -> ModuleType | None:
    if not EXTERNAL_CONFIG_PATH.exists():
        return None

    spec = importlib.util.spec_from_file_location("nse_monitor_external_config", EXTERNAL_CONFIG_PATH)
    if spec is None or spec.loader is None:
        return None

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _first_non_empty(module: ModuleType | None, *names: str) -> str:
    if module is not None:
        for name in names:
            value = getattr(module, name, "")
            if isinstance(value, str) and value.strip():
                return value.strip()
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def load_dhan_credentials() -> DhanCredentials:
    """Load Dhan credentials from C:\\NSE Monitor\\config.py first, then env vars."""
    external_config = _load_external_config()
    client_id = _first_non_empty(external_config, "CLIENT_ID", "DHAN_CLIENT_ID")
    access_token = _first_non_empty(external_config, "ACCESS_TOKEN", "DHAN_ACCESS_TOKEN")
    api_key = _first_non_empty(external_config, "API_KEY", "DHAN_API_KEY") or None
    if not client_id or not access_token:
        raise RuntimeError(
            r"Set CLIENT_ID and ACCESS_TOKEN in C:\NSE Monitor\config.py or via DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN."
        )
    return DhanCredentials(client_id=client_id, access_token=access_token, api_key=api_key)
