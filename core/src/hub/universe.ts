import { makeInstrumentId, type InstrumentId } from '../domain/ids.js';
import type { SubscribeRequest } from '../feed/interface.js';
import {
  resolveNiftyCurrentFuture,
  resolveNiftyOptionChain,
  type ScripRow,
} from '../marketdata/instrument-master.js';

export interface HubInstrumentInput {
  exchangeSegment: string;
  brokerToken: string;
  instrumentId?: InstrumentId;
  requestCode?: number;
}

export interface HubUniverseSeedOptions {
  scripRows: ScripRow[];
  date: string;
  underlyingSymbol?: string;
  minDaysToExpiry?: number;
  spotSecurityId?: string;
  spotExchangeSegment?: string;
  optionExchangeSegment?: string;
  requestCode?: number;
}

/**
 * Normalizes subscription requests into a consistent unique key.
 */
export function subscriptionKey(segment: string, token: string): string {
  return `${segment.trim()}:${token.trim()}`;
}

/**
 * HubUniverse manages the session-long subscription set for the feed hub.
 *
 * Requirements:
 * - Expand-only during a session: added instruments are never removed before end of day.
 * - Seeds with full weekly option chain (all strikes, CE + PE) plus current future/spot.
 * - Tracks universe version incremented on each expansion.
 * - Maps broker token -> canonical InstrumentId for downstream normalization.
 */
export class HubUniverse {
  private version = 1;
  private readonly subscriptions = new Map<string, SubscribeRequest>();
  private readonly tokenToId = new Map<string, InstrumentId>();

  constructor(initialRequests?: SubscribeRequest[]) {
    if (initialRequests && initialRequests.length > 0) {
      for (const req of initialRequests) {
        this.insert(req);
      }
    }
  }

  /**
   * Builds the initial subscription list seeded from the scrip master for the active weekly chain.
   */
  static seedFromScripMaster(opts: HubUniverseSeedOptions): HubUniverse {
    const underlying = opts.underlyingSymbol ?? 'NIFTY';
    if (underlying !== 'NIFTY') {
      throw new Error(`Only NIFTY is currently supported for full weekly seeding; got ${underlying}`);
    }

    const minDays = opts.minDaysToExpiry ?? 0;
    const weekly = resolveNiftyOptionChain(opts.scripRows, opts.date, minDays);
    if (!weekly) {
      throw new Error(`Could not resolve NIFTY weekly chain for ${opts.date}`);
    }

    const optionSegment = opts.optionExchangeSegment ?? 'NSE_FNO';
    const requestCode = opts.requestCode ?? 21;
    const initial: SubscribeRequest[] = [];

    // 1. Add all weekly option chain strikes (both CE and PE)
    for (const entry of weekly.chain.values()) {
      for (const row of [entry.ce, entry.pe]) {
        if (!row) continue;
        const instrumentId = makeInstrumentId('NSE', row.securityId);
        initial.push({
          exchangeSegment: optionSegment,
          brokerToken: row.securityId,
          instrumentId,
          requestCode,
        });
      }
    }

    // 2. Add spot/futures feed instrument
    let spotToken = opts.spotSecurityId;
    let spotSegment = opts.spotExchangeSegment;
    if (!spotToken || !spotSegment) {
      const futRow = resolveNiftyCurrentFuture(opts.scripRows, opts.date);
      if (futRow) {
        spotToken = futRow.securityId;
        spotSegment = optionSegment;
      }
    }

    if (spotToken && spotSegment) {
      const spotInstrumentId = makeInstrumentId('NSE', spotToken);
      initial.push({
        exchangeSegment: spotSegment,
        brokerToken: spotToken,
        instrumentId: spotInstrumentId,
        requestCode: spotSegment === 'IDX_I' ? 15 : requestCode,
      });
    }

    return new HubUniverse(initial);
  }

  private insert(req: SubscribeRequest): void {
    const key = subscriptionKey(req.exchangeSegment, req.brokerToken);
    this.subscriptions.set(key, req);
    this.tokenToId.set(req.brokerToken, req.instrumentId);
  }

  /**
   * Expand-only registration: adds any instruments not already present in the universe.
   * Returns newly added requests (if any). Increments version only if new instruments were added.
   */
  add(instruments: HubInstrumentInput[]): { added: SubscribeRequest[]; universeVersion: number } {
    const added: SubscribeRequest[] = [];

    for (const item of instruments) {
      const key = subscriptionKey(item.exchangeSegment, item.brokerToken);
      if (this.subscriptions.has(key)) continue;

      const instrumentId = item.instrumentId ?? makeInstrumentId('NSE', item.brokerToken);
      const req: SubscribeRequest = {
        exchangeSegment: item.exchangeSegment,
        brokerToken: item.brokerToken,
        instrumentId,
        ...(item.requestCode !== undefined ? { requestCode: item.requestCode } : {}),
      };

      this.insert(req);
      added.push(req);
    }

    if (added.length > 0) {
      this.version += 1;
    }

    return { added, universeVersion: this.version };
  }

  has(exchangeSegment: string, brokerToken: string): boolean {
    return this.subscriptions.has(subscriptionKey(exchangeSegment, brokerToken));
  }

  hasToken(brokerToken: string): boolean {
    return this.tokenToId.has(brokerToken);
  }

  getInstrumentId(brokerToken: string): InstrumentId | undefined {
    return this.tokenToId.get(brokerToken);
  }

  tokenToInstrumentMap(): ReadonlyMap<string, InstrumentId> {
    return this.tokenToId;
  }

  allSubscriptions(): SubscribeRequest[] {
    return Array.from(this.subscriptions.values());
  }

  size(): number {
    return this.subscriptions.size;
  }

  currentVersion(): number {
    return this.version;
  }
}
