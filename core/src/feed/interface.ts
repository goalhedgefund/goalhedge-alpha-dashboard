import type { InstrumentId } from '../domain/ids.js';
import type { Tick } from '../domain/marketdata.js';

export type FeedStatus = 'CONNECTED' | 'DISCONNECTED' | 'STALE';

export interface FeedHealth {
  status: FeedStatus;
  /** Epoch-ms of the most recent tick received; 0 if none. */
  lastTickTs: number;
  tickRatePerSec: number;
  detail?: string;
}

export interface SubscribeRequest {
  /** Exchange segment string used by the broker, e.g. 'NSE_FNO'. */
  exchangeSegment: string;
  /** Broker-specific security/instrument token. */
  brokerToken: string;
  instrumentId: InstrumentId;
  /** Broker-specific market-data mode; falls back to the adapter default. */
  requestCode?: number;
}

export interface IFeedAdapter {
  readonly adapterId: string;
  connect(): Promise<void>;
  subscribe(requests: SubscribeRequest[]): void;
  /** Register the hot-path tick handler. Only one handler per adapter. */
  setTickHandler(cb: (tick: Tick) => void): void;
  health(): FeedHealth;
  close(): Promise<void>;
}
