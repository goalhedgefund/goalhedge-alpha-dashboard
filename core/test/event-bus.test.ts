import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EventBus } from '../src/bus/event-bus.js';

interface TestEvents {
  tick: { price: number };
  halt: { reason: string };
  [key: string]: unknown;
}

describe('EventBus', () => {
  it('delivers payloads to handlers in subscription order', () => {
    const bus = new EventBus<TestEvents>();
    const seen: string[] = [];
    bus.on('tick', (t) => seen.push(`a:${t.price}`));
    bus.on('tick', (t) => seen.push(`b:${t.price}`));
    bus.emit('tick', { price: 100 });
    bus.emit('tick', { price: 101 });
    expect(seen).toEqual(['a:100', 'b:100', 'a:101', 'b:101']);
  });

  it('emit with no handlers is a no-op', () => {
    const bus = new EventBus<TestEvents>();
    expect(() => bus.emit('halt', { reason: 'none' })).not.toThrow();
  });

  it('unsubscribe stops delivery and is idempotent', () => {
    const bus = new EventBus<TestEvents>();
    let calls = 0;
    const off = bus.on('tick', () => calls++);
    bus.emit('tick', { price: 1 });
    off();
    off();
    bus.emit('tick', { price: 2 });
    expect(calls).toBe(1);
    expect(bus.handlerCount('tick')).toBe(0);
  });

  it('subscriptions made during an emit take effect from the next emit', () => {
    const bus = new EventBus<TestEvents>();
    const seen: string[] = [];
    bus.on('tick', () => {
      seen.push('outer');
      if (seen.length === 1) bus.on('tick', () => seen.push('inner'));
    });
    bus.emit('tick', { price: 1 });
    expect(seen).toEqual(['outer']);
    bus.emit('tick', { price: 2 });
    expect(seen).toEqual(['outer', 'outer', 'inner']);
  });

  it('a throwing handler is reported and later handlers still run', () => {
    const errors: unknown[] = [];
    const bus = new EventBus<TestEvents>((err, type) => errors.push(`${type}:${String(err)}`));
    const seen: string[] = [];
    bus.on('tick', () => {
      throw new Error('boom');
    });
    bus.on('tick', () => seen.push('survivor'));
    bus.emit('tick', { price: 1 });
    expect(seen).toEqual(['survivor']);
    expect(errors).toEqual(['tick:Error: boom']);
  });

  it('default error hook rethrows (loud in tests)', () => {
    const bus = new EventBus<TestEvents>();
    bus.on('tick', () => {
      throw new Error('boom');
    });
    expect(() => bus.emit('tick', { price: 1 })).toThrow('boom');
  });

  it('property: every emit reaches exactly the handlers subscribed at emit time', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<'sub' | 'unsub' | 'emit'>('sub', 'unsub', 'emit'), {
          maxLength: 200,
        }),
        (ops) => {
          const bus = new EventBus<TestEvents>();
          const unsubs: Array<() => void> = [];
          let live = 0;
          let expected = 0;
          let delivered = 0;
          for (const op of ops) {
            if (op === 'sub') {
              unsubs.push(bus.on('tick', () => delivered++));
              live++;
            } else if (op === 'unsub' && unsubs.length > 0) {
              const off = unsubs.pop();
              off?.();
              live--;
            } else if (op === 'emit') {
              expected += live;
              bus.emit('tick', { price: 1 });
            }
          }
          expect(delivered).toBe(expected);
        },
      ),
    );
  });
});
