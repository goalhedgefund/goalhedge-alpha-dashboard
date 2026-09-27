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
 * - Maps subscription keys to canonical InstrumentIds for downstream normalization.
 */
export class HubUniverse {
  private version = 1;
  private readonly subscriptions = new Map<string, SubscribeRequest>();
  /** Keyed by exchange segment + broker token; bare tokens are not unique. */
  private readonly subscriptionToInstrumentId = new Map<string, InstrumentId>();
  /** A normalized InstrumentId can be shared by legacy callers; retain every key, never overwrite. */
  private readonly instrumentToKeys = new Map<InstrumentId, Set<string>>();
  /** Active v2 consumer ownership. Upstream subscriptions remain expand-only. */
  private readonly ownerConnectionsByKey = new Map<string, Set<string>>();
  private readonly ownedKeysByConnection = new Map<string, Set<string>>();

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

    // 3. Add NIFTY spot index instrument ("13") for index spot consumers (e.g. Ex-S1)
    if (underlying === 'NIFTY' && spotToken !== '13') {
      initial.push({
        exchangeSegment: 'IDX_I',
        brokerToken: '13',
        instrumentId: makeInstrumentId('NSE', '13'),
        requestCode: 15,
      });
    }

    return new HubUniverse(initial);
  }

  private insert(req: SubscribeRequest): void {
    const key = subscriptionKey(req.exchangeSegment, req.brokerToken);
    this.subscriptions.set(key, req);
    this.subscriptionToInstrumentId.set(key, req.instrumentId);
    const keys = this.instrumentToKeys.get(req.instrumentId) ?? new Set<string>();
    keys.add(key);
    this.instrumentToKeys.set(req.instrumentId, keys);
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

  /** Idempotently adds active ownership while retaining expand-only upstream state. */
  subscribe(connectionId: string, instruments: HubInstrumentInput[]): {
    added: SubscribeRequest[];
    owned: number;
    activeCount: number;
    universeVersion: number;
  } {
    const { added, universeVersion } = this.add(instruments);
    let connectionKeys = this.ownedKeysByConnection.get(connectionId);
    if (!connectionKeys) {
      connectionKeys = new Set();
      this.ownedKeysByConnection.set(connectionId, connectionKeys);
    }
    let owned = 0;
    for (const item of instruments) {
      const key = subscriptionKey(item.exchangeSegment, item.brokerToken);
      if (connectionKeys.has(key)) continue;
      connectionKeys.add(key);
      const owners = this.ownerConnectionsByKey.get(key) ?? new Set<string>();
      owners.add(connectionId);
      this.ownerConnectionsByKey.set(key, owners);
      owned++;
    }
    return { added, owned, activeCount: connectionKeys.size, universeVersion };
  }

  /** Idempotent: removing an absent subscription never affects another client. */
  unsubscribe(connectionId: string, instruments: HubInstrumentInput[]): { removed: number; activeCount: number } {
    const connectionKeys = this.ownedKeysByConnection.get(connectionId);
    if (!connectionKeys) return { removed: 0, activeCount: 0 };
    let removed = 0;
    for (const item of instruments) {
      const key = subscriptionKey(item.exchangeSegment, item.brokerToken);
      if (!connectionKeys.delete(key)) continue;
      const owners = this.ownerConnectionsByKey.get(key);
      owners?.delete(connectionId);
      if (owners?.size === 0) this.ownerConnectionsByKey.delete(key);
      removed++;
    }
    if (connectionKeys.size === 0) this.ownedKeysByConnection.delete(connectionId);
    return { removed, activeCount: connectionKeys.size };
  }

  releaseConnection(connectionId: string): number {
    const keys = Array.from(this.ownedKeysByConnection.get(connectionId) ?? []);
    return this.unsubscribe(connectionId, keys.map((key) => {
      const [exchangeSegment, brokerToken] = key.split(':', 2);
      return { exchangeSegment: exchangeSegment ?? '', brokerToken: brokerToken ?? '' };
    })).removed;
  }

  connectionOwnsInstrument(connectionId: string, instrumentId: InstrumentId): boolean {
    const keys = this.instrumentToKeys.get(instrumentId);
    const owned = this.ownedKeysByConnection.get(connectionId);
    return keys !== undefined && owned !== undefined && Array.from(keys).some((key) => owned.has(key));
  }

  activeReferenceCount(exchangeSegment: string, brokerToken: string): number {
    return this.ownerConnectionsByKey.get(subscriptionKey(exchangeSegment, brokerToken))?.size ?? 0;
  }

  connectionSubscriptionCount(connectionId: string): number {
    return this.ownedKeysByConnection.get(connectionId)?.size ?? 0;
  }

  ownershipSnapshot(): ReadonlyMap<string, readonly string[]> {
    return new Map(Array.from(this.ownerConnectionsByKey, ([key, connections]) => [key, Array.from(connections)]));
  }

  has(exchangeSegment: string, brokerToken: string): boolean {
    return this.subscriptions.has(subscriptionKey(exchangeSegment, brokerToken));
  }

  hasToken(exchangeSegment: string, brokerToken: string): boolean {
    return this.subscriptionToInstrumentId.has(subscriptionKey(exchangeSegment, brokerToken));
  }

  getInstrumentId(exchangeSegment: string, brokerToken: string): InstrumentId | undefined {
    return this.subscriptionToInstrumentId.get(subscriptionKey(exchangeSegment, brokerToken));
  }

  tokenToInstrumentMap(): ReadonlyMap<string, InstrumentId> {
    return this.subscriptionToInstrumentId;
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
