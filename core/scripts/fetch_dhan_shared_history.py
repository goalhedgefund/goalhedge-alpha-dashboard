#!/usr/bin/env python3
"""
Download a shared, lossless Dhan rolling-option minute-bar corpus.

This script is deliberately separate from the live feed and from the legacy
`fetch_dhan_atm4_history.py`, which expands one-minute candles into synthetic
ticks. This downloader preserves the values Dhan actually returns and never
fabricates bid/ask quotes or sub-minute event order.

Output:
  <out>/bars.jsonl.gz
  <out>/manifest.json

The end date is exclusive, matching Dhan's API.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable


DEFAULT_ENV_PATH = Path(r"D:\Claude\workstation\secrets\dhan\.env")
REQUIRED_DATA = ("open", "high", "low", "close", "iv", "volume", "strike", "oi", "spot")


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            values[key.strip()] = value
    values.update({key: value for key, value in os.environ.items() if value is not None})
    return values


def chunks(from_date: date, to_date: date, max_days: int = 30) -> Iterable[tuple[date, date]]:
    cursor = from_date
    while cursor < to_date:
        end = min(to_date, cursor + timedelta(days=max_days))
        yield cursor, end
        cursor = end


def moneyness(offset: int) -> str:
    return "ATM" if offset == 0 else f"ATM{offset:+d}"


def paise(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return round(float(value) * 100)
    except (TypeError, ValueError):
        return None


def number_at(values: Any, index: int) -> Any:
    return values[index] if isinstance(values, list) and index < len(values) else None


def unwrap_side(response: Any, right: str) -> dict[str, Any]:
    data = response.get("data") if isinstance(response, dict) else response
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    if not isinstance(data, dict):
        return {}
    key = "ce" if right == "CE" else "pe"
    side = data.get(key)
    return side if isinstance(side, dict) else {}


def normalize(
    side: dict[str, Any],
    *,
    expiry_flag: str,
    expiry_code: int,
    offset: int,
    right: str,
) -> list[dict[str, Any]]:
    timestamps = side.get("timestamp")
    if not isinstance(timestamps, list):
        return []
    records: list[dict[str, Any]] = []
    for index, raw_ts in enumerate(timestamps):
        try:
            ts_ms = int(float(raw_ts) * (1 if float(raw_ts) > 10_000_000_000 else 1000))
        except (TypeError, ValueError):
            continue
        values = {field: number_at(side.get(field), index) for field in REQUIRED_DATA}
        prices = {field: paise(values[field]) for field in ("open", "high", "low", "close")}
        if any(value is None for value in prices.values()):
            continue
        records.append(
            {
                "schemaVersion": 1,
                "kind": "dhan.rollingOption.1m",
                "ts": ts_ms,
                "expiryFlag": expiry_flag,
                "expiryCode": expiry_code,
                "moneyness": moneyness(offset),
                "offset": offset,
                "right": right,
                "openPaise": prices["open"],
                "highPaise": prices["high"],
                "lowPaise": prices["low"],
                "closePaise": prices["close"],
                "volume": int(float(values["volume"] or 0)),
                "oi": int(float(values["oi"] or 0)),
                "iv": None if values["iv"] is None else float(values["iv"]),
                "strikePaise": paise(values["strike"]),
                "spotPaise": paise(values["spot"]),
            }
        )
    return records


def fetch(
    api: Any,
    *,
    security_id: str,
    exchange_segment: str,
    instrument: str,
    expiry_flag: str,
    expiry_code: int,
    offset: int,
    right: str,
    from_date: date,
    to_date: date,
) -> list[dict[str, Any]]:
    response = api.expired_options_data(
        security_id=security_id,
        exchange_segment=exchange_segment,
        instrument_type=instrument,
        expiry_flag=expiry_flag,
        expiry_code=expiry_code,
        strike=moneyness(offset),
        drv_option_type="CALL" if right == "CE" else "PUT",
        required_data=list(REQUIRED_DATA),
        from_date=from_date.isoformat(),
        to_date=to_date.isoformat(),
        interval=1,
    )
    if isinstance(response, dict) and str(response.get("status", "")).lower() == "failure":
        detail = response.get("errorMessage") or response.get("remarks") or response.get("errorCode")
        raise RuntimeError(f"Dhan request failed: {detail or 'unknown error'}")
    return normalize(
        unwrap_side(response, right),
        expiry_flag=expiry_flag,
        expiry_code=expiry_code,
        offset=offset,
        right=right,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--from-date", required=True, help="Inclusive YYYY-MM-DD")
    parser.add_argument("--to-date", required=True, help="Exclusive YYYY-MM-DD")
    parser.add_argument("--out", required=True)
    parser.add_argument("--depth", type=int, default=4)
    parser.add_argument("--expiry-codes", default="0,1,2")
    parser.add_argument("--expiry-flag", choices=("WEEK", "MONTH"), default="WEEK")
    parser.add_argument("--security-id", default="13")
    parser.add_argument("--exchange-segment", default="NSE_FNO")
    parser.add_argument("--instrument", default="OPTIDX")
    parser.add_argument("--pause-sec", type=float, default=0.15)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    start = date.fromisoformat(args.from_date)
    end = date.fromisoformat(args.to_date)
    if end <= start:
        raise SystemExit("--to-date must be after --from-date")
    if not 0 <= args.depth <= 10:
        raise SystemExit("--depth must be between 0 and 10")
    expiry_codes = sorted({int(value) for value in args.expiry_codes.split(",")})
    if any(value not in (0, 1, 2) for value in expiry_codes):
        raise SystemExit("Dhan rolling-option expiry codes are limited to 0,1,2")

    request_plan = [
        {
            "from": chunk_start.isoformat(),
            "to": chunk_end.isoformat(),
            "expiryCode": expiry_code,
            "moneyness": moneyness(offset),
            "right": right,
        }
        for chunk_start, chunk_end in chunks(start, end)
        for expiry_code in expiry_codes
        for offset in range(-args.depth, args.depth + 1)
        for right in ("CE", "PE")
    ]
    if args.dry_run:
        print(json.dumps({"requests": len(request_plan), "plan": request_plan}, indent=2))
        return 0

    env = parse_env(Path(os.environ.get("DHAN_ENV_PATH", DEFAULT_ENV_PATH)))
    missing = [name for name in ("DHAN_CLIENT_ID", "DHAN_ACCESS_TOKEN") if not env.get(name)]
    if missing:
        raise SystemExit(f"Missing credentials: {', '.join(missing)}")
    from dhanhq import DhanContext, dhanhq

    api = dhanhq(DhanContext(env["DHAN_CLIENT_ID"], env["DHAN_ACCESS_TOKEN"]))
    records: list[dict[str, Any]] = []
    for request in request_plan:
        records.extend(
            fetch(
                api,
                security_id=args.security_id,
                exchange_segment=args.exchange_segment,
                instrument=args.instrument,
                expiry_flag=args.expiry_flag,
                expiry_code=int(request["expiryCode"]),
                offset=int(str(request["moneyness"]).replace("ATM", "") or 0),
                right=str(request["right"]),
                from_date=date.fromisoformat(str(request["from"])),
                to_date=date.fromisoformat(str(request["to"])),
            )
        )
        if args.pause_sec > 0:
            time.sleep(args.pause_sec)

    deduped: dict[tuple[int, int, int, str], dict[str, Any]] = {}
    for record in records:
        key = (record["ts"], record["expiryCode"], record["offset"], record["right"])
        deduped[key] = record
    ordered = sorted(deduped.values(), key=lambda row: (row["ts"], row["expiryCode"], row["offset"], row["right"]))
    for sequence, record in enumerate(ordered, start=1):
        record["sequence"] = sequence

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    bars_path = out_dir / "bars.jsonl.gz"
    temp_path = out_dir / "bars.jsonl.gz.tmp"
    digest = hashlib.sha256()
    with gzip.open(temp_path, "wt", encoding="utf-8") as stream:
        for record in ordered:
            line = json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n"
            stream.write(line)
            digest.update(line.encode("utf-8"))
    temp_path.replace(bars_path)

    missing_counts = {
        field: sum(1 for record in ordered if record.get(field) is None)
        for field in ("spotPaise", "strikePaise", "iv")
    }
    manifest = {
        "schemaVersion": 1,
        "source": "Dhan /charts/rollingoption",
        "granularity": "1m",
        "fromDateInclusive": start.isoformat(),
        "toDateExclusive": end.isoformat(),
        "securityId": args.security_id,
        "exchangeSegment": args.exchange_segment,
        "instrument": args.instrument,
        "expiryFlag": args.expiry_flag,
        "expiryCodes": expiry_codes,
        "depth": args.depth,
        "requiredData": list(REQUIRED_DATA),
        "records": len(ordered),
        "sha256UncompressedJsonl": digest.hexdigest(),
        "missingCounts": missing_counts,
        "limitations": [
            "Minute bars; no historical bid/ask or tick event sequence.",
            "Expiry codes are limited by Dhan to current, next and far (0,1,2).",
            "Not valid for tick-exact replay without a separate execution model.",
        ],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(ordered)} minute bars to {bars_path}")
    print(f"Manifest: {out_dir / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
