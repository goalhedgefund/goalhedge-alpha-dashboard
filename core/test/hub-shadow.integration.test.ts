import { describe, expect, it } from 'vitest';
import { makeInstrumentId } from '../src/domain/ids.js';
import type { Tick } from '../src/domain/marketdata.js';
import type { FeedHealth, IFeedAdapter, SubscribeRequest } from '../src/feed/interface.js';
import { HubFeed } from '../src/feed/hub/feed.js';
import { HubServer } from '../src/hub/server.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error('timed out waiting for shared-hub condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class SyntheticProvider implements IFeedAdapter {
  readonly adapterId = 'synthetic-provider';
  handler?: (tick: Tick) => void;
  connect = async (): Promise<void> => undefined;
  subscribe(_requests: SubscribeRequest[]): void {}
  setTickHandler(handler: (tick: Tick) => void): void { this.handler = handler; }
  health(): FeedHealth { return { status: 'CONNECTED', lastTickTs: Date.now(), tickRatePerSec: 1 }; }
  close = async (): Promise<void> => undefined;
  emit(token: string): void { this.handler?.({ instrumentId: makeInstrumentId('NSE', token), ts: Date.now(), recvTs: Date.now(), ltpPaise: 10000, qty: 1, volume: 1, bidPaise: 9999, askPaise: 10001, bidQty: 1, askQty: 1 }); }
}

describe('six-consumer offline shared-hub shadow', () => {
  it('uses no external feed and delivers only each consumer owned synthetic ticks', async () => {
    const provider = new SyntheticProvider();
    const hub = new HubServer({ port: 0, host: '127.0.0.1', feed: provider });
    await hub.start();
    const port = (hub as any).wss.address().port as number;
    const definitions: Record<string, string[]> = {
      s1: ['100', '101'], s2: ['100', '102'], 'all-op': ['103'], 'op-minus': ['104'], 'ex-s1': ['105'], arb: ['101', '105'],
    };
    const received = new Map<string, string[]>();
    const feeds = await Promise.all(Object.entries(definitions).map(async ([id, tokens]) => {
      const feed = new HubFeed({ url: `ws://127.0.0.1:${port}`, clientId: id, instanceId: `${id}-shadow`, protocolVersion: 2 });
      received.set(id, []);
      feed.setTickHandler((tick) => received.get(id)?.push(tick.instrumentId.split(':')[1] ?? ''));
      await feed.connect();
      feed.subscribe(tokens.map((token) => ({ exchangeSegment: 'NSE_FNO', brokerToken: token, instrumentId: makeInstrumentId('NSE', token) })));
      return feed;
    }));
    await waitFor(() => (hub.diagnostics().clients as Array<{ subscriptions: number }>).length === Object.keys(definitions).length
      && (hub.diagnostics().clients as Array<{ subscriptions: number }>).every((client) => client.subscriptions > 0));
    for (const token of ['100', '101', '102', '103', '104', '105', '999']) provider.emit(token);
    await waitFor(() => Array.from(received.entries()).every(([id, ticks]) => ticks.length === definitions[id]?.length));
    for (const [id, tokens] of Object.entries(definitions)) {
      expect(received.get(id)?.sort()).toEqual(tokens.slice().sort());
    }
    expect(received.get('s1')).not.toContain('999');
    expect(hub.diagnostics()).toMatchObject({ status: 'CONNECTED' });
    await Promise.all(feeds.map((feed) => feed.close()));
    await hub.close();
  });
});
