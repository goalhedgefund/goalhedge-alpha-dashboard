"""Streamlit dashboard for paper-trading performance."""

from __future__ import annotations

import sqlite3
import sys
import logging
from datetime import datetime
from pathlib import Path

import pandas as pd
import streamlit as st

if __package__:
    from .config import DB_PATH, LOG_DIR, TradingConfig
    from .database import TradingDatabase
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from AITrader.config import DB_PATH, LOG_DIR, TradingConfig
    from AITrader.database import TradingDatabase


logging.basicConfig(
    filename=LOG_DIR / "dashboard.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)


def load_table(query: str) -> pd.DataFrame:
    with sqlite3.connect(DB_PATH) as connection:
        return pd.read_sql_query(query, connection)


def profit_factor(closed: pd.DataFrame) -> float:
    gross_profit = closed.loc[closed["pnl"] > 0, "pnl"].sum()
    gross_loss = abs(closed.loc[closed["pnl"] < 0, "pnl"].sum())
    if gross_loss == 0:
        return float("inf") if gross_profit > 0 else 0.0
    return gross_profit / gross_loss


def max_drawdown(closed: pd.DataFrame) -> float:
    if closed.empty:
        return 0.0
    equity = closed["pnl"].cumsum()
    drawdown = equity - equity.cummax()
    return float(drawdown.min())


def load_backend_status() -> dict[str, object]:
    candles = load_table(
        """
        SELECT symbol, MAX(timestamp) AS last_timestamp, COUNT(*) AS candle_count
        FROM candles
        GROUP BY symbol
        ORDER BY symbol
        """
    )
    total_candles = int(candles["candle_count"].sum()) if not candles.empty else 0
    latest_candle = candles["last_timestamp"].max() if not candles.empty else None

    log_path = LOG_DIR / "live_feed.log"
    log_exists = log_path.exists()
    log_updated = None
    if log_exists:
        log_updated = datetime.fromtimestamp(log_path.stat().st_mtime)

    return {
        "candles": candles,
        "total_candles": total_candles,
        "latest_candle": latest_candle,
        "log_exists": log_exists,
        "log_updated": log_updated,
    }


def load_candidates() -> pd.DataFrame:
    return load_table(
        """
        SELECT symbol, security_id, price, sma200, eligible, source, updated_at
        FROM symbol_candidates
        ORDER BY eligible DESC, symbol
        """
    )


def load_selection() -> pd.DataFrame:
    return load_table(
        """
        SELECT symbol, selected, source, updated_at
        FROM symbol_selection
        ORDER BY symbol
        """
    )


def rank_today_volume_buzzers(limit: int = 5) -> pd.DataFrame:
    with sqlite3.connect(DB_PATH) as connection:
        return pd.read_sql_query(
            """
            SELECT
                symbol,
                SUM(volume) AS day_volume,
                MAX(timestamp) AS last_timestamp,
                MAX(close) AS last_close
            FROM candles
            WHERE date(timestamp) = date('now')
            GROUP BY symbol
            HAVING day_volume IS NOT NULL
            ORDER BY day_volume DESC, last_timestamp DESC
            LIMIT ?
            """,
            connection,
            params=(limit,),
        )


def main() -> None:
    TradingDatabase()
    st.set_page_config(page_title="AITrader Paper Dashboard", layout="wide")
    st.title("AITrader Paper Dashboard")

    status = load_backend_status()
    db = TradingDatabase()
    candidates = load_candidates()
    selected_df = load_selection()
    open_trades = load_table("SELECT * FROM trades WHERE status = 'OPEN' ORDER BY timestamp")
    closed = load_table("SELECT * FROM trades WHERE status = 'CLOSED' ORDER BY exit_timestamp DESC")

    st.subheader("Universe Scan")
    if st.button("Refresh Top 5 Buzzers"):
        status_box = st.empty()
        try:
            logging.info("Dashboard volume-buzzer refresh started")
            status_box.info("Ranking today's candle volume buzzers...")
            top5 = rank_today_volume_buzzers(limit=5)
            if top5.empty:
                status_box.warning("No candle data yet. Start the live feed first.")
                logging.info("No candle rows found for today's buzzer ranking")
            else:
                symbols = top5["symbol"].tolist()
                logging.info("Top 5 buzzers: %s", ",".join(symbols))
                st.session_state["top20_table"] = top5.rename(columns={"day_volume": "traded_value"})
                st.session_state["top5_universe"] = symbols
                st.session_state["match_count"] = len(symbols)
                st.session_state["scan_symbols"] = symbols
                st.session_state["top_universe"] = symbols
                for _, row in top5.iterrows():
                    db.upsert_symbol_candidate(
                        str(row["symbol"]),
                        str(row["symbol"]),
                        float(row["last_close"]) if pd.notna(row["last_close"]) else 0.0,
                        None,
                        True,
                        source="today_volume",
                    )
                    db.upsert_symbol_selection(str(row["symbol"]), True, source="top5_volume")
                status_box.success("Top 5 buzzers selected.")
            st.rerun()
        except Exception as exc:
            logging.exception("Dashboard refresh failed")
            status_box.error(f"Refresh failed: {exc}")

    if "top_universe" in st.session_state:
        st.caption(
            "Top 5 buzzers selected from today's candles."
        )
        st.write("Selected universe:", ", ".join(st.session_state["top_universe"]))

    if "top20_table" in st.session_state:
        st.subheader("Top 20 Ranked")
        st.dataframe(st.session_state["top20_table"], use_container_width=True, hide_index=True)

    active_options = st.session_state.get("top5_universe", [])
    current_selected = selected_df.loc[selected_df["selected"] == 1, "symbol"].tolist() if not selected_df.empty else []
    chosen = st.multiselect(
        "Choose active scalping symbols",
        options=active_options,
        default=[symbol for symbol in current_selected if symbol in active_options],
    )
    if st.button("Save Active Symbols"):
        for symbol in active_options:
            db.upsert_symbol_selection(symbol, symbol in chosen, source="dashboard")
        st.rerun()

    if not candidates.empty:
        st.subheader("Saved Candidates")
        st.dataframe(candidates, use_container_width=True, hide_index=True)
    else:
        st.info("No ranked candidates loaded yet. Refresh the scan first.")

    total_pnl = float(closed["pnl"].sum()) if not closed.empty else 0.0
    if not closed.empty:
        closed["exit_timestamp"] = pd.to_datetime(closed["exit_timestamp"])
        today = pd.Timestamp.today().date()
        week_start = pd.Timestamp.today().normalize() - pd.Timedelta(days=pd.Timestamp.today().weekday())
        daily_pnl = float(closed.loc[closed["exit_timestamp"].dt.date == today, "pnl"].sum())
        weekly_pnl = float(closed.loc[closed["exit_timestamp"] >= week_start, "pnl"].sum())
    else:
        daily_pnl = 0.0
        weekly_pnl = 0.0
    win_rate = float((closed["pnl"] > 0).mean() * 100) if not closed.empty else 0.0
    avg_gain = float(closed.loc[closed["pnl"] > 0, "pnl"].mean()) if (not closed.empty and (closed["pnl"] > 0).any()) else 0.0
    avg_loss = float(closed.loc[closed["pnl"] < 0, "pnl"].mean()) if (not closed.empty and (closed["pnl"] < 0).any()) else 0.0

    cols = st.columns(8)
    cols[0].metric("Open Trades", len(open_trades))
    cols[1].metric("Closed Trades", len(closed))
    cols[2].metric("Daily PnL", round(daily_pnl, 2))
    cols[3].metric("Weekly PnL", round(weekly_pnl, 2))
    cols[4].metric("Total PnL", round(total_pnl, 2))
    cols[5].metric("Win Rate", f"{win_rate:.1f}%")
    cols[6].metric("Profit Factor", round(profit_factor(closed), 2))
    cols[7].metric("Max Drawdown", round(max_drawdown(closed), 2))

    cols = st.columns(2)
    cols[0].metric("Average Gain", round(avg_gain, 2))
    cols[1].metric("Average Loss", round(avg_loss, 2))

    st.subheader("Backend Status")
    cols = st.columns(3)
    cols[0].metric("Total Candles", status["total_candles"])
    cols[1].metric("Last Candle", status["latest_candle"] or "No data")
    cols[2].metric(
        "Log Updated",
        status["log_updated"].strftime("%Y-%m-%d %H:%M:%S") if status["log_updated"] else "Missing",
    )

    if not status["candles"].empty:
        st.dataframe(status["candles"], use_container_width=True, hide_index=True)
    else:
        st.info("No candle rows have been stored yet.")

    if not selected_df.empty:
        st.subheader("Active Symbols")
        active_df = selected_df.loc[selected_df["selected"] == 1]
        st.dataframe(active_df, use_container_width=True, hide_index=True)

    st.subheader("Summary")
    summary_cols = st.columns(4)
    summary_cols[0].metric("Top 5 Active", len(st.session_state.get("top5_universe", [])))
    summary_cols[1].metric("Selected", len(current_selected))
    summary_cols[2].metric("Open Trades", len(open_trades))
    summary_cols[3].metric("Closed Trades", len(closed))
    if st.session_state.get("top5_universe"):
        st.write("Active scalp universe:", ", ".join(st.session_state["top5_universe"]))

    st.subheader("Open Trades")
    st.dataframe(open_trades, use_container_width=True)

    st.subheader("Closed Trades")
    st.dataframe(closed, use_container_width=True)


if __name__ == "__main__":
    main()
