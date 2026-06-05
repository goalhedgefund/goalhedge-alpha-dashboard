from datetime import date

from nse_downloader import (
    REPORTS,
    clean_old_raw_data,
    clean_old_processed_data,
    clean_old_raw_files,
    find_report_in_metadata,
    previous_trading_date,
    retained_dates,
    resolve_report_url,
    download_file,
)


class DummySession:
    def get(self, *args, **kwargs):
        raise AssertionError("API should not be called for fallback-only test")


def test_find_report_in_metadata_matches_file_key_and_date():
    spec = next(report for report in REPORTS if report.key == "cm_bhavcopy")
    metadata = {
        "CurrentDay": [
            {
                "fileKey": "CM-UDIFF-BHAVCOPY-CSV",
                "fileActlName": "BhavCopy_NSE_CM_0_0_0_20260602_F_0000.csv.zip",
                "filePath": "https://nsearchives.nseindia.com/content/cm/",
                "tradingDate": "02-Jun-2026",
            }
        ]
    }

    item = find_report_in_metadata(metadata, spec, date(2026, 6, 2))

    assert item is not None
    assert item["fileActlName"] == "BhavCopy_NSE_CM_0_0_0_20260602_F_0000.csv.zip"


def test_resolve_report_url_falls_back_to_correct_archive_path():
    spec = next(report for report in REPORTS if report.key == "week_52_high_low")

    filename, url = resolve_report_url(DummySession(), spec, date(2026, 6, 2))

    assert filename == "CM_52_wk_High_low_02062026.csv"
    assert url == "https://nsearchives.nseindia.com/content/CM_52_wk_High_low_02062026.csv"


def test_clean_old_raw_files_keeps_only_requested_date(tmp_path):
    keep_dir = tmp_path / "20260602"
    old_dir = tmp_path / "20260601"
    keep_dir.mkdir()
    old_dir.mkdir()
    (keep_dir / "today.csv").write_text("ok", encoding="utf-8")
    (old_dir / "old.csv").write_text("old", encoding="utf-8")
    (tmp_path / ".gitkeep").write_text("", encoding="utf-8")

    clean_old_raw_files(tmp_path, date(2026, 6, 2))

    assert keep_dir.exists()
    assert (keep_dir / "today.csv").exists()
    assert not old_dir.exists()
    assert (tmp_path / ".gitkeep").exists()


def test_clean_old_raw_data_keeps_requested_dates(tmp_path):
    today_dir = tmp_path / "20260605"
    previous_dir = tmp_path / "20260604"
    old_dir = tmp_path / "20260603"
    today_dir.mkdir()
    previous_dir.mkdir()
    old_dir.mkdir()
    (today_dir / "today.csv").write_text("today", encoding="utf-8")
    (previous_dir / "previous.csv").write_text("previous", encoding="utf-8")
    (old_dir / "old.csv").write_text("old", encoding="utf-8")

    clean_old_raw_data(tmp_path, {date(2026, 6, 5), date(2026, 6, 4)})

    assert today_dir.exists()
    assert previous_dir.exists()
    assert not old_dir.exists()


def test_clean_old_processed_data_keeps_requested_dates(tmp_path):
    (tmp_path / "cm_bhavcopy_20260605.csv").write_text("today", encoding="utf-8")
    (tmp_path / "cm_bhavcopy_20260604.csv").write_text("previous", encoding="utf-8")
    (tmp_path / "cm_bhavcopy_20260602.csv").write_text("today", encoding="utf-8")
    (tmp_path / ".gitkeep").write_text("", encoding="utf-8")

    clean_old_processed_data(tmp_path, {date(2026, 6, 5), date(2026, 6, 4)})

    assert (tmp_path / "cm_bhavcopy_20260605.csv").exists()
    assert (tmp_path / "cm_bhavcopy_20260604.csv").exists()
    assert not (tmp_path / "cm_bhavcopy_20260602.csv").exists()
    assert (tmp_path / ".gitkeep").exists()


def test_download_file_uses_cached_raw_file_without_session_call(tmp_path):
    spec = next(report for report in REPORTS if report.key == "cm_bhavcopy")
    cached_dir = tmp_path / "20260605"
    cached_dir.mkdir()
    cached_path = cached_dir / spec.filename_for(date(2026, 6, 5))
    cached_path.write_text("cached", encoding="utf-8")

    result = download_file(DummySession(), spec, date(2026, 6, 5), tmp_path)

    assert result == cached_path


def test_previous_trading_date_skips_weekends():
    assert previous_trading_date(date(2026, 6, 8)) == date(2026, 6, 5)


def test_retained_dates_keeps_current_and_previous_trading_day():
    assert retained_dates(date(2026, 6, 8), True) == {date(2026, 6, 8), date(2026, 6, 5)}
