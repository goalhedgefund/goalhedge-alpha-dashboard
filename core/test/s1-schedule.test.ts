import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema } from '../src/config/schemas.js';

const market = loadConfig(
  MarketProfileSchema,
  fileURLToPath(new URL('../../config/market/india-nse-options.json', import.meta.url)),
).value;

/**
 * S1 has no schedule of its own — it trades the market profile's window, the
 * same as every other strategy.
 *
 * It briefly did (09:20–15:25, square-off 15:30). That override put the hard
 * square-off on the exchange close itself, leaving the flatten-retry loop
 * under a minute of runway before the risk gate starts rejecting exits with
 * MARKET_CLOSED. These assertions lock in the runway that override removed.
 */
describe('S1 trades the base market schedule', () => {
  it('squares off strictly before the session closes, leaving retry runway', () => {
    expect(market.hardSquareOff < market.session.close).toBe(true);
  });

  it('stops new entries at or before the square-off', () => {
    expect(market.entryCutoff <= market.hardSquareOff).toBe(true);
  });

  it('opens entries at the session open', () => {
    expect(market.session.open < market.entryCutoff).toBe(true);
  });

  it('is the NSE session S1 is expected to trade', () => {
    expect(market.session.open).toBe('09:15');
    expect(market.entryCutoff).toBe('15:00');
    expect(market.hardSquareOff).toBe('15:12');
    expect(market.session.close).toBe('15:30');
  });
});
