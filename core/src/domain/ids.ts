/**
 * Branded ID types so an order id can never be passed where a position id
 * belongs. IDs are deterministic (session + monotonic counter) — no
 * randomness on the hot path, so replays produce identical ids.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, 'SessionId'>;
export type InstrumentId = Brand<string, 'InstrumentId'>;
export type IntentId = Brand<string, 'IntentId'>;
export type ClientOrderId = Brand<string, 'ClientOrderId'>;
export type PositionId = Brand<string, 'PositionId'>;
export type TradeId = Brand<string, 'TradeId'>;

export type SessionMode = 'paper' | 'live';

export function makeSessionId(date: string, mode: SessionMode): SessionId {
  return `${date}_${mode}` as SessionId;
}

export function makeInstrumentId(exchange: string, token: string): InstrumentId {
  return `${exchange}:${token}` as InstrumentId;
}

/** Deterministic, session-scoped id generator. One instance per session. */
export class IdFactory {
  private readonly counters = new Map<string, number>();

  constructor(private readonly sessionId: SessionId) {}

  private next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${this.sessionId}-${n}`;
  }

  /**
   * Raise counters past ids already persisted for this session. A process
   * restart mid-session otherwise rebuilds this factory from zero and
   * re-issues `trd-<session>-1`, which collides with the PRIMARY KEY in the
   * SQLite mirror and silently drops the row (the journal keeps both, so the
   * two stores disagree). Replays and fresh sessions read an empty store, get
   * no seeds, and keep the deterministic 1..n sequence.
   */
  resumeFrom(counters: Iterable<readonly [string, number]>): void {
    for (const [prefix, n] of counters) {
      if (!Number.isInteger(n) || n <= 0) continue;
      if (n > (this.counters.get(prefix) ?? 0)) this.counters.set(prefix, n);
    }
  }

  intentId(): IntentId {
    return this.next('int') as IntentId;
  }

  clientOrderId(): ClientOrderId {
    return this.next('ord') as ClientOrderId;
  }

  positionId(): PositionId {
    return this.next('pos') as PositionId;
  }

  tradeId(): TradeId {
    return this.next('trd') as TradeId;
  }
}
