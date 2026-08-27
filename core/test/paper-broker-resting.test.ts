import { describe, expect, it } from 'vitest';
import {
  IdFactory,
  makeInstrumentId,
  makeSessionId,
} from '../src/domain/ids.js';
import type { Order } from '../src/domain/orders.js';
import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';

const INSTRUMENT = makeInstrumentId('NSE', 'PASSIVE_TEST');
const SESSION = makeSessionId('2026-08-25', 'paper');
const LIMIT = 10_000;
const LOT = 65;

function buyOrder(): Order {
  const ids = new IdFactory(SESSION);
  return {
    clientOrderId: ids.clientOrderId(),
    intentId: ids.intentId(),
    sessionId: SESSION,
    instrumentId: INSTRUMENT,
    side: 'BUY',
    qty: LOT,
    filledQty: 0,
    avgFillPricePaise: 0,
    type: 'LIMIT',
    limitPricePaise: LIMIT,
    state: 'SENT',
    purpose: 'ENTRY',
    tag: 'allop-atm-mm:quote_bid',
    createdTs: 1,
    updatedTs: 1,
  };
}

function broker(queueLots = 2): PaperBroker {
  return new PaperBroker({
    clock: new ManualClock(1),
    restingFills: true,
    passiveTradeFills: true,
    passiveQueueAheadLots: queueLots,
  });
}

describe('PaperBroker passive trade-print fills', () => {
  it('ignores a pre-ACK LTP, then fills on a new post-ACK trade through the bid', async () => {
    const paper = broker();
    paper.setQuote(INSTRUMENT, {
      bidPaise: 9_980,
      askPaise: 10_020,
      ltpPaise: 9_990,
      qty: LOT,
      volume: 1_000,
    });
    const order = buyOrder();
    await paper.placeOrder(order);
    expect(paper.getOrders()[0]?.state).toBe('ACKED');

    paper.setQuote(INSTRUMENT, {
      bidPaise: 9_980,
      askPaise: 10_020,
      ltpPaise: 9_990,
      qty: 0,
      volume: 1_000,
    });
    expect(paper.getOrders()[0]?.state).toBe('ACKED');

    paper.setQuote(INSTRUMENT, {
      bidPaise: 9_980,
      askPaise: 10_020,
      ltpPaise: 9_990,
      qty: LOT,
      volume: 1_065,
    });
    expect(paper.getOrders()[0]).toEqual(expect.objectContaining({
      state: 'FILLED',
      filledQty: LOT,
      avgFillPricePaise: LIMIT,
    }));
  });

  it('requires prints at the limit to consume the conservative queue first', async () => {
    const paper = broker(2);
    paper.setQuote(INSTRUMENT, {
      bidPaise: LIMIT,
      askPaise: LIMIT + 20,
      ltpPaise: LIMIT + 10,
      qty: 0,
      volume: 1_000,
      bidQty: LOT,
    });
    await paper.placeOrder(buyOrder());

    for (const volume of [1_065, 1_130]) {
      paper.setQuote(INSTRUMENT, {
        bidPaise: LIMIT,
        askPaise: LIMIT + 20,
        ltpPaise: LIMIT,
        qty: LOT,
        volume,
        bidQty: LOT,
      });
      expect(paper.getOrders()[0]?.state).toBe('ACKED');
    }
    paper.setQuote(INSTRUMENT, {
      bidPaise: LIMIT,
      askPaise: LIMIT + 20,
      ltpPaise: LIMIT,
      qty: LOT,
      volume: 1_195,
      bidQty: LOT,
    });
    expect(paper.getOrders()[0]?.state).toBe('FILLED');
  });

  it('keeps touch crossing as a guaranteed fill even on a quote-only update', async () => {
    const paper = broker();
    paper.setQuote(INSTRUMENT, {
      bidPaise: LIMIT - 20,
      askPaise: LIMIT + 20,
      ltpPaise: LIMIT + 10,
      qty: 0,
      volume: 1_000,
    });
    await paper.placeOrder(buyOrder());
    paper.setQuote(INSTRUMENT, {
      bidPaise: LIMIT - 20,
      askPaise: LIMIT,
      ltpPaise: LIMIT + 10,
      qty: 0,
      volume: 1_000,
    });
    expect(paper.getOrders()[0]).toEqual(expect.objectContaining({
      state: 'FILLED',
      avgFillPricePaise: LIMIT,
    }));
  });
});
