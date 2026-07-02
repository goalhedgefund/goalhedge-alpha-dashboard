/**
 * Typed synchronous event bus for the trading hot path.
 *
 * Dispatch is synchronous with zero allocation on emit (handler lists are
 * copy-on-write: on/off replace the list, emit iterates the captured
 * reference). Subscriptions made during an emit take effect from the next
 * emit. Registering the same function reference twice is not supported —
 * unsubscribing removes every occurrence.
 *
 * Handlers must not throw. A throwing handler is reported to the onError
 * hook and the remaining handlers still run. The default hook rethrows so
 * bugs are loud in tests; production wiring must install a journaling hook.
 */
export type EventMap = Record<string, unknown>;

type Handler<P> = (payload: P) => void;

function rethrow(err: unknown): never {
  throw err;
}

export class EventBus<M extends EventMap> {
  private readonly lists = new Map<keyof M, ReadonlyArray<Handler<never>>>();

  constructor(
    private readonly onError: (err: unknown, type: keyof M & string) => void = rethrow,
  ) {}

  on<K extends keyof M & string>(type: K, handler: Handler<M[K]>): () => void {
    const current = (this.lists.get(type) ?? []) as ReadonlyArray<Handler<M[K]>>;
    this.lists.set(type, [...current, handler] as ReadonlyArray<Handler<never>>);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const now = (this.lists.get(type) ?? []) as ReadonlyArray<Handler<M[K]>>;
      this.lists.set(
        type,
        now.filter((h) => h !== handler) as ReadonlyArray<Handler<never>>,
      );
    };
  }

  emit<K extends keyof M & string>(type: K, payload: M[K]): void {
    const list = this.lists.get(type) as ReadonlyArray<Handler<M[K]>> | undefined;
    if (list === undefined) return;
    for (let i = 0; i < list.length; i++) {
      try {
        (list[i] as Handler<M[K]>)(payload);
      } catch (err) {
        this.onError(err, type);
      }
    }
  }

  handlerCount(type: keyof M & string): number {
    return this.lists.get(type)?.length ?? 0;
  }
}
