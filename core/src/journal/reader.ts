import { readFile } from 'node:fs/promises';
import { JOURNAL_EVENT_TYPES, type JournalEvent } from '../domain/events.js';

export class JournalIntegrityError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`journal integrity: ${message} (line ${line})`);
    this.name = 'JournalIntegrityError';
  }
}

export interface JournalReadResult {
  events: JournalEvent[];
  /** True if the file ended in an incomplete line (crash mid-write) that was dropped. */
  partialTail: boolean;
}

export interface JournalReadOptions {
  /** Enforce gap-free seq starting at startSeq (default 1). */
  strictSeq?: boolean;
  startSeq?: number;
}

function validateEnvelope(value: unknown, line: number): JournalEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JournalIntegrityError('event is not an object', line);
  }
  const ev = value as Record<string, unknown>;
  if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq < 1) {
    throw new JournalIntegrityError('bad seq', line);
  }
  if (typeof ev.ts !== 'number') throw new JournalIntegrityError('bad ts', line);
  if (typeof ev.type !== 'string' || !JOURNAL_EVENT_TYPES.has(ev.type)) {
    throw new JournalIntegrityError(`unknown event type ${String(ev.type)}`, line);
  }
  if (!('payload' in ev)) throw new JournalIntegrityError('missing payload', line);
  return value as JournalEvent;
}

/**
 * Read a session journal. A trailing partial line (process died mid-write)
 * is tolerated and reported; a malformed line anywhere else throws.
 */
export async function readJournal(
  path: string,
  opts: JournalReadOptions = {},
): Promise<JournalReadResult> {
  const strictSeq = opts.strictSeq ?? true;
  let expectedSeq = opts.startSeq ?? 1;

  const raw = await readFile(path, 'utf8');
  const events: JournalEvent[] = [];
  let partialTail = false;

  const segments = raw.split('\n');
  const endsWithNewline = raw.endsWith('\n') || raw.length === 0;

  for (let i = 0; i < segments.length; i++) {
    const line = segments[i] as string;
    if (line === '') continue;
    const isTail = i === segments.length - 1 && !endsWithNewline;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (isTail) {
        partialTail = true;
        break;
      }
      throw new JournalIntegrityError('malformed JSON', i + 1);
    }

    const ev = validateEnvelope(parsed, i + 1);
    if (strictSeq) {
      if (ev.seq !== expectedSeq) {
        throw new JournalIntegrityError(`seq gap: expected ${expectedSeq}, got ${ev.seq}`, i + 1);
      }
      expectedSeq++;
    }
    events.push(ev);
  }

  return { events, partialTail };
}

/** Async iterator facade (streaming implementation can replace it later without breaking callers). */
export async function* iterateJournal(
  path: string,
  opts: JournalReadOptions = {},
): AsyncGenerator<JournalEvent> {
  const { events } = await readJournal(path, opts);
  for (const ev of events) yield ev;
}
