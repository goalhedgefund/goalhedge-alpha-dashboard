import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { z } from 'zod';

/**
 * Canonical JSON: recursively key-sorted, no whitespace. Two structurally
 * equal values always serialize identically, so the hash is independent of
 * key order and file formatting.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortValue(src[k]);
    return out;
  }
  return v;
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export interface LoadedConfig<T> {
  value: T;
  /** sha256 of the canonical form of the *validated* value (defaults applied). */
  hash: string;
  path: string;
}

/**
 * Load a JSON config file, validate it against `schema`, and content-hash the
 * validated value. The hash is what gets journaled at session start.
 */
export function loadConfig<S extends z.ZodTypeAny>(
  schema: S,
  path: string,
): LoadedConfig<z.output<S>> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const value = schema.parse(raw) as z.output<S>;
  return { value, hash: hashValue(value), path };
}
