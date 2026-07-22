#!/usr/bin/env python3
r"""
Fetch OP(-) research data from Dhan HQ and materialize a tick corpus.

This is a fallback data-collection helper for the backtest harness.
It uses the official `dhanhq` Python client and the repo's Dhan env file.

Because Dhan's historical API is candle-based, this script expands 1-minute
OHLCV candles into synthetic ticks so the existing tick-driven backtest can
still run. That is good enough for research backfills, but it is not a
replacement for a real tick corpus.

Usage:
  python scripts/fetch-dhan-op-minus-history.py --date YYYY-MM-DD --out DIR

Environment:
  DHAN_ENV_PATH                  Dhan env file (default:
                                 D:\Claude\workstation\secrets\dhan\.env)
  DHAN_SCRIP_MASTER_PATH         Scrip master CSV (required)
  DHAN_OPTION_EXCHANGE_SEGMENT   Option segment (default NSE_FNO)
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from dhanhq import DhanContext, dhanhq


IST = timezone(timedelta(hours=5, minutes=30))
DEFAULT_ENV_PATH = r"D:\Claude\workstation\secrets\dhan\.env"


@dataclass(frozen=True)
class ScripRow:
    exchange: str
    segment: str
    security_id: str
    instrument_name: str
    expiry_code: int
    trading_symbol: str
    lot_size: int
    expiry_date: str
    strike_paise: int
    option_type: str
    tick_size_paise: int
    expiry_flag: str
    underlying_symbol: str


def parse_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = unquote(value.strip())
    return out


def unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def load_scrip_master(path: Path) -> list[ScripRow]:
    rows: list[ScripRow] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)
        for cols in reader:
            if len(cols) < 16:
                continue
            trading_symbol = cols[5].strip()
            underlying = cols[15].strip() or trading_symbol.split("-")[0]
            rows.append(
                ScripRow(
                    exchange=cols[0].strip(),
                    segment=cols[1].strip(),
                    security_id=cols[2].strip(),
                    instrument_name=cols[3].strip(),
                    expiry_code=int(cols[4] or "0"),
                    trading_symbol=trading_symbol,
                    lot_size=int(float(cols[6] or "1")),
                    expiry_date=(cols[8] or "").split(" ")[0],
                    strike_paise=round(float(cols[9] or "0") * 100),
                    option_type=cols[10].strip(),
                    tick_size_paise=max(1, round(float(cols[11] or "0.05") * 100)),
                    expiry_flag=cols[12].strip(),
                    underlying_symbol=underlying,
                )
            )
    return rows


def filter_options(rows: Iterable[ScripRow], underlying: str) -> list[ScripRow]:
    return [
        r for r in rows
        if r.underlying_symbol == underlying
        and r.instrument_name in {"OPTIDX", "OPTSTK"}
        and r.option_type in {"CE", "PE"}
    ]


def resolve_expiries(rows: Iterable[ScripRow]) -> list[str]:
    return sorted({r.expiry_date for r in rows if r.expiry_date})


def resolve_weekly_chain(rows: list[ScripRow], as_of: str, min_days: int = 0) -> tuple[str, dict[int, dict[str, ScripRow]]]:
    opts = filter_options(rows, "NIFTY")
    earliest = as_of
    if min_days > 0:
      earliest = (datetime.fromisoformat(as_of).date() + timedelta(days=min_days)).isoformat()
    expiry = next((d for d in resolve_expiries(opts) if d >= earliest), None)
    if expiry is None:
        raise RuntimeError(f"could not resolve NIFTY expiry for {as_of}")
    chain: dict[int, dict[str, ScripRow]] = defaultdict(dict)
    for r in opts:
        if r.expiry_date == expiry:
            chain[r.strike_paise][r.option_type] = r
    return expiry, chain


def resolve_expiry_offset(rows: list[ScripRow], base_expiry: str, offset: int) -> tuple[str, dict[int, dict[str, ScripRow]]]:
    opts = filter_options(rows, "NIFTY")
    expiries = resolve_expiries(opts)
    try:
        idx = expiries.index(base_expiry)
    except ValueError as exc:
        raise RuntimeError(f"base expiry {base_expiry} not found") from exc
    target = expiries[idx + max(0, offset)]
    chain: dict[int, dict[str, ScripRow]] = defaultdict(dict)
    for r in opts:
        if r.expiry_date == target:
            chain[r.strike_paise][r.option_type] = r
    return target, chain


def choose_strikes(chain: dict[int, dict[str, ScripRow]], spot_paise: int, depth: int) -> list[int]:
    strikes = sorted(chain)
    if not strikes:
        return []
    atm = min(strikes, key=lambda s: abs(s - spot_paise))
    idx = strikes.index(atm)
    lo = max(0, idx - depth)
    hi = min(len(strikes) - 1, idx + depth)
    return strikes[lo : hi + 1]


def candles_to_ticks(instrument_id: str, candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ticks: list[dict[str, Any]] = []
    for candle in candles:
        ts = parse_ts(candle["timestamp"])
        o = paise(candle["open"])
        h = paise(candle["high"])
        l = paise(candle["low"])
        c = paise(candle["close"])
        vol = int(float(candle.get("volume", 0) or 0))
        ltp_series = [o, h, l, c]
        qty_series = split_qty(vol, len(ltp_series))
        for idx, (ltp, qty) in enumerate(zip(ltp_series, qty_series, strict=True)):
            ticks.append({
                "instrumentId": instrument_id,
                "ts": ts + idx * 15_000,
                "recvTs": ts + idx * 15_000,
                "ltpPaise": ltp,
                "qty": qty,
                "volume": vol,
                "bidPaise": max(0, ltp - 5),
                "askPaise": ltp + 5,
                "bidQty": max(1, qty or 1),
                "askQty": max(1, qty or 1),
            })
    ticks.sort(key=lambda t: (t["ts"], t["instrumentId"]))
    return ticks


def split_qty(volume: int, parts: int) -> list[int]:
    if volume <= 0:
        return [1] * parts
    base, rem = divmod(volume, parts)
    return [max(1, base + (1 if i < rem else 0)) for i in range(parts)]


def parse_ts(value: Any) -> int:
    if isinstance(value, (int, float)):
        return int(value if value > 10_000_000_000 else value * 1000)
    s = str(value).replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return int(dt.astimezone(IST).timestamp() * 1000)


def paise(value: Any) -> int:
    return round(float(value) * 100)


def fetch_rolling_option(
    api: dhanhq,
    underlying_security_id: str,
    underlying_segment: str,
    instrument_type: str,
    expiry_flag: str,
    expiry_code: int,
    strike: str,
    option_side: str,
    day: str,
) -> list[dict[str, Any]]:
    end_date = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
    response = api.expired_options_data(
        security_id=underlying_security_id,
        exchange_segment=underlying_segment,
        instrument_type=instrument_type,
        expiry_flag=expiry_flag,
        expiry_code=expiry_code,
        strike=strike,
        drv_option_type=option_side,
        required_data=["open", "high", "low", "close", "volume", "oi"],
        from_date=day,
        # Dhan's toDate is non-inclusive; same-day requests otherwise return
        # an empty data set.
        to_date=end_date,
        interval=1,
    )
    if isinstance(response, dict) and str(response.get("status", "")).lower() == "failure":
        message = response.get("errorMessage") or response.get("remarks") or response.get("errorCode") or "unknown Dhan error"
        raise RuntimeError(f"Dhan rolling options request failed: {message}")
    data = response.get("data") if isinstance(response, dict) else response
    if not data:
        return []
    # dhanhq currently adds an extra `data` wrapper around the API's
    # documented {ce, pe} payload.
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    # The documented response is columnar under data.ce/data.pe, not a list
    # of candle objects. Normalize it to the shape used by candles_to_ticks.
    if isinstance(data, dict) and any(key in data for key in ("ce", "pe")):
        side_data = data.get("ce") or data.get("pe") or {}
        timestamps = side_data.get("timestamp", [])
        out = []
        for i, timestamp in enumerate(timestamps):
            row = {"timestamp": timestamp}
            for key in ("open", "high", "low", "close", "volume"):
                values = side_data.get(key, [])
                row[key] = values[i] if i < len(values) else None
            if all(row[key] is not None for key in ("open", "high", "low", "close")):
                out.append(row)
        return out
    if isinstance(data, dict):
        for key in ("candles", "data", "result"):
            if key in data and isinstance(data[key], list):
                data = data[key]
                break
    out: list[dict[str, Any]] = []
    for item in data if isinstance(data, list) else []:
        if isinstance(item, dict):
            out.append(item)
            continue
        if isinstance(item, list) and len(item) >= 6:
            out.append({
                "timestamp": item[0],
                "open": item[1],
                "high": item[2],
                "low": item[3],
                "close": item[4],
                "volume": item[5],
            })
    return out


def load_credentials(env_path: Path) -> dict[str, str]:
    vars_ = parse_env_file(env_path)
    vars_.update({k: v for k, v in os.environ.items() if v is not None})
    missing = [k for k in ("DHAN_CLIENT_ID", "DHAN_ACCESS_TOKEN", "DHAN_SCRIP_MASTER_PATH") if not vars_.get(k)]
    if missing:
        raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")
    return vars_


def norm_exchange_segment(value: str) -> str:
    raw = value.strip().upper()
    return {
        "IDX_I": "IDX_I",
        "NSE_FNO": "NSE_FNO",
        "NSE": "NSE",
    }.get(raw, raw)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--profile", default="research")
    args = ap.parse_args()

    env = load_credentials(Path(os.environ.get("DHAN_ENV_PATH", DEFAULT_ENV_PATH)))
    client = dhanhq(DhanContext(env["DHAN_CLIENT_ID"], env["DHAN_ACCESS_TOKEN"]))
    rows = load_scrip_master(Path(env["DHAN_SCRIP_MASTER_PATH"]))

    date_str = args.date
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "ticks.jsonl.gz"

    min_days = 1
    scalp_expiry, scalp_chain = resolve_weekly_chain(rows, date_str, min_days=min_days)
    hedge_offset = 3
    hedge_expiry, hedge_chain = resolve_expiry_offset(rows, scalp_expiry, hedge_offset)

    option_segment = env.get("DHAN_OPTION_EXCHANGE_SEGMENT", "NSE_FNO")
    underlying_security_id = env.get("DHAN_UNDERLYING_SECURITY_ID", env.get("DHAN_SPOT_SECURITY_ID", "13"))
    # /charts/rollingoption expects the option exchange segment (NSE_FNO),
    # not the underlying's IDX_I segment used by option-chain endpoints.
    rolling_option_segment = norm_exchange_segment(option_segment)
    all_ticks: list[dict[str, Any]] = []
    strikes = sorted(scalp_chain)
    if not strikes:
        raise RuntimeError(f"No strikes resolved for {date_str}")
    scalp_atm = strikes[len(strikes) // 2]
    scalp_row_ce = scalp_chain.get(scalp_atm, {}).get("CE")
    scalp_row_pe = scalp_chain.get(scalp_atm, {}).get("PE")
    for row, side in ((scalp_row_ce, "CALL"), (scalp_row_pe, "PUT")):
        if row is None:
            continue
        expiry_flag = "WEEK" if row.expiry_flag == "W" else "MONTH"
        candles = fetch_rolling_option(
            client,
            underlying_security_id,
            rolling_option_segment,
            row.instrument_name,
            expiry_flag,
            # Dhan's live validator rejects JSON 0 as "missing" even though
            # older documentation lists 0..3. Use the nearest expiry code.
            max(1, int(row.expiry_code)),
            "ATM",
            side,
            date_str,
        )
        if candles:
            all_ticks.extend(candles_to_ticks(f"NSE:{row.security_id}", candles))

    all_ticks.sort(key=lambda t: (t["ts"], t["instrumentId"]))
    if not all_ticks:
        raise RuntimeError(f"No rolling option candles returned for {date_str}")
    with gzip.open(out_path, "wt", encoding="utf-8") as gz:
        for tick in all_ticks:
            gz.write(json.dumps(tick, separators=(",", ":")))
            gz.write("\n")

    print(f"Wrote {len(all_ticks)} synthetic ticks to {out_path}")
    print(f"Scalp expiry: {scalp_expiry}; hedge expiry: {hedge_expiry}; option history probe: ATM CE/PE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
