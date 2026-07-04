import { ManualClock } from '../src/domain/time.js';
import { PaperBroker } from '../src/exec/paper-broker.js';
import { describeAdapterConformance, type AdapterHarness } from './helpers/adapter-conformance.js';

/**
 * PaperBroker must pass the same conformance suite any real broker adapter will
 * face (M11 gate). This proves the suite is correct and pins PaperBroker to the
 * contract. Latency is 0 → fills are synchronous, so settle() is a no-op.
 */
function makePaperHarness(): AdapterHarness {
  const broker = new PaperBroker({ clock: new ManualClock(1) });
  return {
    adapter: broker,
    quote: (id, q) => broker.setQuote(id, q),
    settle: () => Promise.resolve(),
    rejectNext: (reason) => broker.rejectNext(reason),
    partialNext: (qty) => broker.partialFillNext(qty),
    emitDuplicate: (ev) => broker.emitDuplicate(ev),
  };
}

describeAdapterConformance('PaperBroker', makePaperHarness);
