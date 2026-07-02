import type { InstrumentId } from './ids.js';

export type InstrumentKind = 'INDEX' | 'FUTURE' | 'OPTION';
export type OptionRight = 'CE' | 'PE';

export interface Instrument {
  id: InstrumentId;
  kind: InstrumentKind;
  /** Human symbol, e.g. NIFTY26JUL24500CE. */
  symbol: string;
  underlying: string;
  exchange: string;
  segment: string;
  /** 1 for indices. */
  lotSize: number;
  tickSizePaise: number;
  /** Options/futures only — ISO date YYYY-MM-DD. */
  expiry?: string;
  strikePaise?: number;
  right?: OptionRight;
  /** Adapter-specific token (e.g. Dhan securityId). */
  brokerToken?: string;
}
