/** Integer paise → '₹123.45' (sign preserved). */
export function rupees(paise: number): string {
  const sign = paise < 0 ? '−' : '';
  return `${sign}₹${(Math.abs(paise) / 100).toFixed(2)}`;
}

/** Strike paise → '24500'. */
export function strike(paise: number): string {
  return String(Math.round(paise / 100));
}

export function ageSec(ts: number, now: number): string {
  if (ts <= 0) return '—';
  return `${((now - ts) / 1000).toFixed(1)}s`;
}

/** Epoch-ms → 'HH:MM:SS' IST. */
export function istTime(ts: number): string {
  return new Date(ts + 330 * 60_000).toISOString().slice(11, 19);
}

export function pct(frac: number): string {
  return `${(frac * 100).toFixed(2)}%`;
}
