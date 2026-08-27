import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/loader.js';
import { MarketProfileSchema } from '../src/config/schemas.js';
import { S1_ENTRY_CUTOFF, S1_ENTRY_START, S1_HARD_SQUARE_OFF, s1MarketProfile } from '../src/strategy/s1-schedule.js';

const market = loadConfig(MarketProfileSchema, fileURLToPath(new URL('../../config/market/india-nse-options.json', import.meta.url))).value;

describe('S1 schedule', () => {
  it('starts entries at 09:20, stops new entries at 15:25, and squares off at 15:30', () => {
    const s1 = s1MarketProfile(market);
    expect(S1_ENTRY_START).toBe('09:20');
    expect(s1.entryCutoff).toBe(S1_ENTRY_CUTOFF);
    expect(s1.hardSquareOff).toBe(S1_HARD_SQUARE_OFF);
    expect(s1.session.close).toBe(S1_HARD_SQUARE_OFF);
    expect(market.hardSquareOff).toBe('15:12');
  });
});
