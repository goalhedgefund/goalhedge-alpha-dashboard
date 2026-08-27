import type { MarketProfile } from '../config/schemas.js';

/** S1's intraday window, with a five-minute square-off execution buffer. */
export const S1_ENTRY_START = '09:20';
export const S1_ENTRY_CUTOFF = '15:25';
export const S1_HARD_SQUARE_OFF = '15:30';

export function s1MarketProfile(market: MarketProfile): MarketProfile {
  return {
    ...market,
    session: { ...market.session, close: S1_HARD_SQUARE_OFF },
    entryCutoff: S1_ENTRY_CUTOFF,
    hardSquareOff: S1_HARD_SQUARE_OFF,
  };
}
