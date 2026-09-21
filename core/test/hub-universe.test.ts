import { describe, expect, it } from 'vitest';
import { makeInstrumentId } from '../src/domain/ids.js';
import { HubUniverse, subscriptionKey } from '../src/hub/universe.js';

describe('HubUniverse', () => {
  it('creates empty universe and increments version only on new items', () => {
    const universe = new HubUniverse();
    expect(universe.size()).toBe(0);
    expect(universe.currentVersion()).toBe(1);

    const res1 = universe.add([
      { exchangeSegment: 'NSE_FNO', brokerToken: '1001' },
      { exchangeSegment: 'NSE_FNO', brokerToken: '1002' },
    ]);
    expect(res1.added.length).toBe(2);
    expect(res1.universeVersion).toBe(2);
    expect(universe.size()).toBe(2);
    expect(universe.has('NSE_FNO', '1001')).toBe(true);
    expect(universe.has('NSE_FNO', '1002')).toBe(true);
    expect(universe.getInstrumentId('1001')).toBe(makeInstrumentId('NSE', '1001'));

    // Duplicate additions should NOT increment version or return added items
    const res2 = universe.add([
      { exchangeSegment: 'NSE_FNO', brokerToken: '1001' },
    ]);
    expect(res2.added.length).toBe(0);
    expect(res2.universeVersion).toBe(2);
    expect(universe.size()).toBe(2);

    // Adding one existing and one new
    const res3 = universe.add([
      { exchangeSegment: 'NSE_FNO', brokerToken: '1002' },
      { exchangeSegment: 'NSE_FNO', brokerToken: '1003' },
    ]);
    expect(res3.added.length).toBe(1);
    expect(res3.added[0]?.brokerToken).toBe('1003');
    expect(res3.universeVersion).toBe(3);
    expect(universe.size()).toBe(3);
  });

  it('normalizes subscription keys cleanly', () => {
    expect(subscriptionKey(' NSE_FNO ', '43210 ')).toBe('NSE_FNO:43210');
  });

  it('initializes from constructor subscriptions', () => {
    const universe = new HubUniverse([
      {
        exchangeSegment: 'NSE_FNO',
        brokerToken: '5001',
        instrumentId: makeInstrumentId('NSE', '5001'),
      },
    ]);
    expect(universe.size()).toBe(1);
    expect(universe.has('NSE_FNO', '5001')).toBe(true);
    expect(universe.hasToken('5001')).toBe(true);
    expect(universe.allSubscriptions().length).toBe(1);
  });
});
