"""
Phase D: Analyze S1 parameter sweep results.

Loads journals/s1-sweep/sweep-results.json and prints a ranked table
plus honesty caveats.

Usage: python scripts/analyze-sweep.py [--results <path>]
"""
import sys
import json
import os
import argparse

# Windows consoles default to cp1252; the table uses box-drawing chars and the
# rupee sign, which crash the default encoder. Force UTF-8 so callers don't
# need `python -X utf8`.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')


def fmt_inr(paise: float) -> str:
    """Format paise as Indian Rupees with sign."""
    rupees = paise / 100
    sign = '+' if rupees >= 0 else ''
    return f'{sign}₹{rupees:.2f}'


def fmt_pct(rate: float) -> str:
    return f'{rate * 100:.0f}%'


def fmt_hold(ms: float) -> str:
    if ms <= 0:
        return '  —'
    return f'{ms / 1000:.0f}s'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--results', default=None, help='Path to sweep-results.json')
    parser.add_argument('--top', type=int, default=10, help='Number of top combos to show')
    args = parser.parse_args()

    # Default path: relative to this script's location (scripts/ → ../ → journals/s1-sweep/)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    scalper_root = os.path.dirname(script_dir)
    default_path = os.path.join(scalper_root, 'journals', 's1-sweep', 'sweep-results.json')
    results_path = args.results or default_path

    if not os.path.exists(results_path):
        print(f'ERROR: sweep-results.json not found at: {results_path}')
        print('Run sweep-s1 first: node dist/scripts/sweep-s1.js')
        sys.exit(1)

    with open(results_path, encoding='utf-8') as f:
        results = json.load(f)

    print(f'Loaded {len(results)} combos from: {results_path}')
    print()

    # Already sorted by totalNetPaise descending (from sweep-s1.ts).
    top_n = args.top
    best = results[:top_n]
    worst = results[-3:] if len(results) > top_n else []

    # Identify baseline.
    baseline = next(
        (r for r in results
         if r['atrMult'] == 1 and r['timeStopSec'] == 90
         and abs(r['impulsePct'] - 0.00035) < 1e-9 and r['confirmTicks'] == 3),
        None,
    )
    baseline_rank = results.index(baseline) + 1 if baseline else None

    # ── Table ────────────────────────────────────────────────────────────────
    hdr = (
        f"{'#':<5}{'atrMult':<9}{'timeStp':<9}{'impPct':<10}"
        f"{'ctk':<5}{'trades':<8}{'wins':<6}{'hitRate':<9}{'avgHold':<9}{'net':>10}"
    )
    print('Top', top_n, 'combos by net P&L (after charges):')
    print(hdr)
    print('─' * len(hdr))

    for i, r in enumerate(best):
        rank = i + 1
        marker = ' ◀ BEST' if rank == 1 else (' ◀ baseline' if r is baseline else '')
        print(
            f"{rank:<5}{r['atrMult']:<9}{r['timeStopSec']:<9}{r['impulsePct']:.5f}   "
            f"{r['confirmTicks']:<5}{r['totalTrades']:<8}{r['totalWins']:<6}"
            f"{fmt_pct(r['hitRate']):<9}{fmt_hold(r['avgHoldMs']):<9}"
            f"{fmt_inr(r['totalNetPaise']):>10}{marker}"
        )

    if baseline and baseline not in best:
        print('...')
        print(
            f"{baseline_rank:<5}{baseline['atrMult']:<9}{baseline['timeStopSec']:<9}"
            f"{baseline['impulsePct']:.5f}   {baseline['confirmTicks']:<5}"
            f"{baseline['totalTrades']:<8}{baseline['totalWins']:<6}"
            f"{fmt_pct(baseline['hitRate']):<9}{fmt_hold(baseline['avgHoldMs']):<9}"
            f"{fmt_inr(baseline['totalNetPaise']):>10} ◀ baseline (rank {baseline_rank})"
        )

    if worst:
        print('...')
        print('Worst 3:')
        for r in worst:
            rank = results.index(r) + 1
            print(
                f"#{rank:<4}{r['atrMult']:<9}{r['timeStopSec']:<9}{r['impulsePct']:.5f}   "
                f"{r['confirmTicks']:<5}{r['totalTrades']:<8}"
                f"{fmt_inr(r['totalNetPaise']):>10}"
            )

    # ── Hypothesis summary ────────────────────────────────────────────────────
    if best:
        top = best[0]
        print()
        print('Hypothesis (top combo):')
        print(f"  atrMult    : {top['atrMult']}   (current: 1)")
        print(f"  timeStopSec: {top['timeStopSec']}   (current: 90)")
        print(f"  impulsePct : {top['impulsePct']:.5f}  (current: 0.00035)")
        print(f"  confirmTicks: {top['confirmTicks']}  (current: 3)")

    # ── Distribution stats ────────────────────────────────────────────────────
    zero_trade = sum(1 for r in results if r['totalTrades'] == 0)
    total = len(results)
    print()
    print(f'Distribution: {zero_trade}/{total} combos triggered 0 trades')
    print(f'Net P&L range: {fmt_inr(results[-1]["totalNetPaise"])} to {fmt_inr(results[0]["totalNetPaise"])}')

    # ── Honesty caveats ───────────────────────────────────────────────────────
    clean_days = list({d['date'] for r in results for d in r['days']})
    print()
    print('━' * 70)
    print('⚠  HONESTY CAVEATS — READ BEFORE ACTING ON THESE RESULTS:')
    print(f'   · Clean replayable days: {len(clean_days)} ({", ".join(sorted(clean_days))})')
    print('   · Max trades per combo = 1 day × likely 0–1 trades = no statistics.')
    print('   · Any "winning" combo is fitted to 1 trade. This is pure luck, not edge.')
    print('   · Ranking by net P&L with N≈1 is equivalent to ranking by coin flip.')
    print('   · REQUIRED next step: paper-trade top-3 combos live for ≥2 weeks,')
    print('     then compare Sharpe / hit-rate with same-period baseline before')
    print('     editing config/strategy/s1-momentum-burst.json.')
    print('━' * 70)


if __name__ == '__main__':
    main()
