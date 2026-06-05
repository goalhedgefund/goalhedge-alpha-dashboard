"""Download and process NSE end-of-day report files."""

from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin

import requests

from bhavcopy_parser import process_bhavcopy_file, process_csv_file
from delivery_parser import process_delivery_file


LOGGER = logging.getLogger("nse_downloader")
ROOT_DIR = Path(__file__).resolve().parent
RAW_DIR = ROOT_DIR / "data" / "raw"
PROCESSED_DIR = ROOT_DIR / "data" / "processed"
NSE_BASE = "https://www.nseindia.com"


@dataclass(frozen=True)
class ReportSpec:
    key: str
    api_segment: str
    api_file_key: str
    archive_path: str
    filename_template: str
    processor: str
    section_url: str

    def filename_for(self, report_date: date) -> str:
        return self.filename_template.format(
            yyyymmdd=report_date.strftime("%Y%m%d"),
            ddmmyyyy=report_date.strftime("%d%m%Y"),
        )


REPORTS: tuple[ReportSpec, ...] = (
    ReportSpec(
        key="cm_bhavcopy",
        api_segment="CM",
        api_file_key="CM-UDIFF-BHAVCOPY-CSV",
        archive_path="https://nsearchives.nseindia.com/content/cm/",
        filename_template="BhavCopy_NSE_CM_0_0_0_{yyyymmdd}_F_0000.csv.zip",
        processor="bhavcopy",
        section_url=f"{NSE_BASE}/all-reports",
    ),
    ReportSpec(
        key="delivery_data",
        api_segment="CM",
        api_file_key="CM-BHAVDATA-FULL",
        archive_path="https://nsearchives.nseindia.com/products/content/",
        filename_template="sec_bhavdata_full_{ddmmyyyy}.csv",
        processor="delivery",
        section_url=f"{NSE_BASE}/all-reports",
    ),
    ReportSpec(
        key="fo_bhavcopy",
        api_segment="FO",
        api_file_key="FO-UDIFF-BHAVCOPY-CSV",
        archive_path="https://nsearchives.nseindia.com/content/fo/",
        filename_template="BhavCopy_NSE_FO_0_0_0_{yyyymmdd}_F_0000.csv.zip",
        processor="bhavcopy",
        section_url=f"{NSE_BASE}/all-reports-derivatives",
    ),
    ReportSpec(
        key="week_52_high_low",
        api_segment="CM",
        api_file_key="CM-52 WEEK-HIGH_LOW",
        archive_path="https://nsearchives.nseindia.com/content/",
        filename_template="CM_52_wk_High_low_{ddmmyyyy}.csv",
        processor="csv",
        section_url=f"{NSE_BASE}/all-reports",
    ),
)


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )


def parse_run_date(value: str | None) -> date:
    if value:
        return datetime.strptime(value, "%Y-%m-%d").date()
    ist = timezone(timedelta(hours=5, minutes=30))
    return datetime.now(ist).date()


def candidate_dates(target_date: date, lookback_days: int) -> Iterable[date]:
    for offset in range(lookback_days + 1):
        current = target_date - timedelta(days=offset)
        if current.weekday() < 5:
            yield current


def build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "accept": "*/*",
            "accept-language": "en-US,en;q=0.9",
            "referer": f"{NSE_BASE}/all-reports",
            "user-agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0 Safari/537.36"
            ),
        }
    )
    for url in (f"{NSE_BASE}/", f"{NSE_BASE}/all-reports", f"{NSE_BASE}/all-reports-derivatives"):
        try:
            session.get(url, timeout=20)
        except requests.RequestException as exc:
            LOGGER.debug("Cookie warmup failed for %s: %s", url, exc)
    return session


def parse_nse_date(value: str) -> date:
    return datetime.strptime(value, "%d-%b-%Y").date()


def get_daily_reports(session: requests.Session, segment: str) -> dict[str, Any]:
    url = f"{NSE_BASE}/api/daily-reports?key={segment}"
    LOGGER.debug("Fetching report metadata from %s", url)
    response = session.get(url, headers={"referer": f"{NSE_BASE}/all-reports"}, timeout=30)
    response.raise_for_status()
    return response.json()


def find_report_in_metadata(metadata: dict[str, Any], spec: ReportSpec, report_date: date) -> dict[str, Any] | None:
    for bucket_name in ("CurrentDay", "PreviousDay", "FutureDay"):
        for item in metadata.get(bucket_name, []) or []:
            if item.get("fileKey") != spec.api_file_key:
                continue
            trading_date = item.get("tradingDate")
            if trading_date and parse_nse_date(trading_date) == report_date:
                return item
    return None


def resolve_report_url(session: requests.Session, spec: ReportSpec, report_date: date) -> tuple[str, str]:
    try:
        metadata = get_daily_reports(session, spec.api_segment)
        item = find_report_in_metadata(metadata, spec, report_date)
        if item:
            filename = item["fileActlName"]
            return filename, urljoin(item["filePath"], filename)
    except Exception as exc:
        LOGGER.warning("Could not resolve %s through NSE API metadata: %s", spec.key, exc)

    filename = spec.filename_for(report_date)
    return filename, urljoin(spec.archive_path, filename)


def download_file(session: requests.Session, spec: ReportSpec, report_date: date, raw_dir: Path) -> Path:
    filename, url = resolve_report_url(session, spec, report_date)
    target_dir = raw_dir / report_date.strftime("%Y%m%d")
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / filename

    LOGGER.info("Downloading %s from %s", spec.key, url)
    headers = {"referer": spec.section_url}
    response = session.get(url, headers=headers, timeout=60)
    response.raise_for_status()

    if not response.content:
        raise ValueError(f"NSE returned an empty file for {spec.key}: {url}")

    target_path.write_bytes(response.content)
    LOGGER.info("Saved %s (%d bytes)", target_path, target_path.stat().st_size)
    return target_path


def process_file(spec: ReportSpec, raw_path: Path, report_date: date, processed_dir: Path) -> Path:
    processed_dir.mkdir(parents=True, exist_ok=True)
    output_path = processed_dir / f"{spec.key}_{report_date.strftime('%Y%m%d')}.csv"

    if spec.processor == "bhavcopy":
        return process_bhavcopy_file(raw_path, output_path, spec.key, report_date)
    if spec.processor == "delivery":
        return process_delivery_file(raw_path, output_path, report_date)
    if spec.processor == "csv":
        return process_csv_file(raw_path, output_path, spec.key, report_date)

    raise ValueError(f"Unsupported processor: {spec.processor}")


def clean_old_raw_files(raw_dir: Path, keep_date: date) -> None:
    if not raw_dir.exists():
        return

    keep_dir_name = keep_date.strftime("%Y%m%d")
    for path in raw_dir.iterdir():
        if path.name == ".gitkeep" or path.name == keep_dir_name:
            continue
        if path.is_dir():
            for child in path.rglob("*"):
                if child.is_file():
                    child.unlink()
            for child in sorted(path.rglob("*"), reverse=True):
                if child.is_dir():
                    child.rmdir()
            path.rmdir()
            LOGGER.info("Removed old raw data folder: %s", path)
        elif path.is_file():
            path.unlink()
            LOGGER.info("Removed old raw data file: %s", path)


def run_pipeline(target_date: date, lookback_days: int, raw_dir: Path, processed_dir: Path) -> date:
    session = build_session()
    errors: list[str] = []

    for report_date in candidate_dates(target_date, lookback_days):
        LOGGER.info("Trying NSE EOD reports for %s", report_date.isoformat())
        downloaded: list[tuple[ReportSpec, Path]] = []
        try:
            for spec in REPORTS:
                downloaded.append((spec, download_file(session, spec, report_date, raw_dir)))
            for spec, raw_path in downloaded:
                output = process_file(spec, raw_path, report_date, processed_dir)
                LOGGER.info("Processed %s to %s", spec.key, output)
            clean_old_raw_files(raw_dir, report_date)
            LOGGER.info("NSE EOD pipeline completed for %s", report_date.isoformat())
            return report_date
        except Exception as exc:
            message = f"{report_date.isoformat()}: {exc}"
            LOGGER.warning("Could not complete downloads for %s", message)
            errors.append(message)

    raise RuntimeError(
        "Unable to download a complete NSE EOD bundle. Attempts: " + " | ".join(errors)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and process NSE EOD reports.")
    parser.add_argument("--date", help="Target report date in YYYY-MM-DD format. Defaults to today in IST.")
    parser.add_argument("--lookback-days", type=int, default=5, help="Previous weekdays to try if the target date has no reports.")
    parser.add_argument("--raw-dir", type=Path, default=RAW_DIR)
    parser.add_argument("--processed-dir", type=Path, default=PROCESSED_DIR)
    args = parser.parse_args()

    configure_logging()
    report_date = parse_run_date(args.date)
    completed_date = run_pipeline(report_date, args.lookback_days, args.raw_dir, args.processed_dir)
    LOGGER.info("Completed date: %s", completed_date.isoformat())


if __name__ == "__main__":
    main()
