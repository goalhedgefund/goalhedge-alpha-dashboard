import type { InstrumentId } from './ids.js';
import type { OptionRight } from './instrument.js';

/**
 * Unified normalized feed event: last trade plus current top-of-book.
 * `qty` is 0 for quote-only updates.
 */
export interface Tick {
  instrumentId: InstrumentId;
  /** Exchange/feed timestamp, epoch-ms. */
  ts: number;
  /** Our receive timestamp, epoch-ms (latency hop t_recv). */
  recvTs: number;
  ltpPaise: number;
  qty: number;
  /** Cumulative day volume. */
  volume: number;
  oi?: number;
  /** 0 when the side is unknown/empty. */
  bidPaise: number;
  askPaise: number;
  bidQty: number;
  askQty: number;
}

export type Timeframe = '1s' | '1m';

export interface Bar {
  instrumentId: InstrumentId;
  tf: Timeframe;
  startTs: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
  tickCount: number;
}

export interface OptionChainRow {
  instrumentId: InstrumentId;
  strikePaise: number;
  right: OptionRight;
  expiry: string;
  ltpPaise: number;
  bidPaise: number;
  askPaise: number;
  bidQty: number;
  askQty: number;
  volume: number;
  oi: number;
  /** Analytics (not money) stay floats. */
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  updatedTs: number;
}
