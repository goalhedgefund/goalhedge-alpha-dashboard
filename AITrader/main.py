"""Command entrypoint for AITrader."""

from __future__ import annotations

from .live_feed import run_live_paper_trading


if __name__ == "__main__":
    run_live_paper_trading()

