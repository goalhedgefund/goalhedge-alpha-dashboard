import { createHash } from 'node:crypto';
import { canonicalStringify } from '../config/loader.js';
import type { JournalEvent } from '../domain/events.js';

/**
 * Order-sensitive content hash of an event stream. Two streams hash equal
 * iff they contain structurally identical events in the same order — the
 * backbone of the replay-determinism guarantee (golden-session CI).
 */
export function hashEventStream(events: Iterable<JournalEvent>): string {
  const h = createHash('sha256');
  for (const ev of events) {
    h.update(canonicalStringify(ev));
    h.update('\n');
  }
  return h.digest('hex');
}
