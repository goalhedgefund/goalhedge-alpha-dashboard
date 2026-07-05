import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { canonicalStringify, hashValue, loadConfig } from '../src/config/loader.js';
import {
  MarketProfileSchema,
  RiskProfileSchema,
  StrategyConfigSchema,
} from '../src/config/schemas.js';

const configDir = fileURLToPath(new URL('../../config/', import.meta.url));

describe('config round trip (M0 acceptance)', () => {
  const cases = [
    ['market/india-nse-options.json', MarketProfileSchema],
    ['risk/paper-default.json', RiskProfileSchema],
    ['strategy/s1-momentum-burst.json', StrategyConfigSchema],
    ['strategy/s2-vwap-fade.json', StrategyConfigSchema],
  ] as const;

  for (const [rel, schema] of cases) {
    it(`${rel}: load → validate → hash → reload → same hash`, () => {
      const first = loadConfig(schema, join(configDir, rel));
      const second = loadConfig(schema, join(configDir, rel));
      expect(second.hash).toBe(first.hash);

      const dir = mkdtempSync(join(tmpdir(), 'scalper-cfg-'));
      const copy = join(dir, 'copy.json');
      writeFileSync(copy, canonicalStringify(first.value));
      const reloaded = loadConfig(schema, copy);
      expect(reloaded.hash).toBe(first.hash);
    });
  }

  it('hash is independent of key order (property)', () => {
    const leaf = fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null));
    const obj = fc.dictionary(fc.string({ minLength: 1 }), leaf, { maxKeys: 10 });
    fc.assert(
      fc.property(obj, (o) => {
        const reversed: Record<string, unknown> = {};
        for (const k of Object.keys(o).reverse()) reversed[k] = o[k];
        expect(hashValue(reversed)).toBe(hashValue(o));
      }),
    );
  });

  it('hash is independent of nesting key order', () => {
    const a = { x: { p: 1, q: [1, 2, { r: 's' }] }, y: true };
    const b = { y: true, x: { q: [1, 2, { r: 's' }], p: 1 } };
    expect(hashValue(a)).toBe(hashValue(b));
  });

  it('array order changes the hash (arrays are ordered data)', () => {
    expect(hashValue({ a: [1, 2] })).not.toBe(hashValue({ a: [2, 1] }));
  });
});

describe('config validation rejects bad profiles', () => {
  const marketPath = join(configDir, 'market/india-nse-options.json');

  it('rejects a charge component with both rate and flatPaise', () => {
    const profile = loadConfig(MarketProfileSchema, marketPath).value;
    const bad = structuredClone(profile) as Record<string, unknown>;
    const charges = bad.charges as { components: Record<string, unknown>[] };
    charges.components[0] = { ...charges.components[0], rate: 0.001, flatPaise: 100 };
    expect(() => MarketProfileSchema.parse(bad)).toThrow();
  });

  it('rejects malformed session times', () => {
    const profile = loadConfig(MarketProfileSchema, marketPath).value;
    const bad = structuredClone(profile) as Record<string, unknown>;
    bad.session = { open: '9:15', close: '15:30' };
    expect(() => MarketProfileSchema.parse(bad)).toThrow();
  });

  it('rejects non-positive risk limits', () => {
    const profile = loadConfig(RiskProfileSchema, join(configDir, 'risk/paper-default.json')).value;
    const bad = { ...profile, maxTradesPerDay: 0 };
    expect(() => RiskProfileSchema.parse(bad)).toThrow();
  });

  it('rejects fractional capitalPaise (money is integer paise)', () => {
    const profile = loadConfig(RiskProfileSchema, join(configDir, 'risk/paper-default.json')).value;
    const bad = { ...profile, capitalPaise: 100000000.5 };
    expect(() => RiskProfileSchema.parse(bad)).toThrow();
  });
});

describe('india-nse-options profile sanity', () => {
  it('freeze quantity is a whole number of lots', () => {
    const { value } = loadConfig(
      MarketProfileSchema,
      join(configDir, 'market/india-nse-options.json'),
    );
    expect(value.contract.freezeQty % value.contract.lotSize).toBe(0);
  });

  it('brokerage defaults to zero per mandate', () => {
    const { value } = loadConfig(
      MarketProfileSchema,
      join(configDir, 'market/india-nse-options.json'),
    );
    const brokerage = value.charges.components.find((c) => c.name === 'brokerage');
    expect(brokerage?.flatPaise).toBe(0);
  });
});
