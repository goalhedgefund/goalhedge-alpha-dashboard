import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DHAN_DEFAULT_WS_URL,
  loadDhanLiveDataPaperEnv,
  parseDhanEnvText,
  parseHubConsumers,
  parseSharedMarketHubMode,
  parseUseSharedMarketHub,
  strategyIdToConsumerId,
} from '../src/host/dhan-live-data-paper-env.js';

function tempEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dhan-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('Dhan live-data paper env loader', () => {
  it('reads the Dhan env file and applies safe runner defaults (USE_SHARED_MARKET_HUB=false -> feedSource=dhan)', () => {
    const path = tempEnv(`
DHAN_CLIENT_ID=client-1
DHAN_ACCESS_TOKEN=token-1
DHAN_SCRIP_MASTER_PATH=data/dhan/api-scrip-master.csv
`);

    const env = loadDhanLiveDataPaperEnv({ DHAN_ENV_PATH: path });

    expect(env.envPath).toBe(path);
    expect(env.wsUrl).toBe(DHAN_DEFAULT_WS_URL);
    expect(env.clientId).toBe('client-1');
    expect(env.accessToken).toBe('token-1');
    expect(env.scripMasterPath).toBe('data/dhan/api-scrip-master.csv');
    expect(env.strategyId).toBe('s1-momentum-burst');
    expect(env.consumerId).toBe('s1');
    expect(env.spotSecurityId).toBe('');
    expect(env.spotExchangeSegment).toBe('');
    expect(env.optionExchangeSegment).toBe('NSE_FNO');
    expect(env.feedRequestCode).toBe(21);
    expect(env.autoArm).toBe(false);
    expect(env.regimeTrendRet30Pct).toBe(0.0015);
    expect(env.paperSlippageTicks).toBe(1);
    expect(env.paperAckLatencyMs).toBe(80);
    expect(env.paperFillLatencyMs).toBe(120);
    // CRITICAL: Must default to dhan, not hub, when flag is absent
    expect(env.feedSource).toBe('dhan');
    expect(env.useSharedMarketHub).toBe(false);
    expect(env.hubMode).toBe('off');
    expect(env.hubConsumers).toEqual([]);
    expect(env.hubWsUrl).toBe('ws://127.0.0.1:8795');
  });

  it('lets process env override values from the env file', () => {
    const path = tempEnv(`
DHAN_CLIENT_ID=file-client
DHAN_ACCESS_TOKEN=file-token
DHAN_WS_URL=wss://file.example
DHAN_SCRIP_MASTER_PATH=file.csv
`);

    const env = loadDhanLiveDataPaperEnv({
      DHAN_ENV_PATH: path,
      DHAN_CLIENT_ID: 'process-client',
      DHAN_ACCESS_TOKEN: 'process-token',
      DHAN_WS_URL: 'wss://process.example',
      DHAN_AUTO_ARM: 'yes',
      DHAN_INITIAL_SPOT_RUPEES: '24501.25',
      DHAN_STRATEGY_ID: 's2-vwap-fade',
      DHAN_PAPER_SLIPPAGE_TICKS: '2',
      DHAN_PAPER_ACK_LATENCY_MS: '90',
      DHAN_PAPER_FILL_LATENCY_MS: '140',
    });

    expect(env.clientId).toBe('process-client');
    expect(env.accessToken).toBe('process-token');
    expect(env.wsUrl).toBe('wss://process.example');
    expect(env.autoArm).toBe(true);
    expect(env.initialSpotPaise).toBe(2_450_125);
    expect(env.strategyId).toBe('s2-vwap-fade');
    expect(env.consumerId).toBe('s2');
    expect(env.paperSlippageTicks).toBe(2);
    expect(env.paperAckLatencyMs).toBe(90);
    expect(env.paperFillLatencyMs).toBe(140);
    expect(env.feedSource).toBe('dhan');
  });

  it('fails clearly when required Dhan runtime keys are missing', () => {
    const path = tempEnv(`
DHAN_CLIENT_ID=client-1
DHAN_ACCESS_TOKEN=token-1
`);

    expect(() => loadDhanLiveDataPaperEnv({ DHAN_ENV_PATH: path })).toThrow(/DHAN_SCRIP_MASTER_PATH/);
  });

  it('parses quoted and exported env entries', () => {
    expect(parseDhanEnvText(`export DHAN_CLIENT_ID="abc"\nDHAN_ACCESS_TOKEN='xyz'\n`)).toEqual({
      DHAN_CLIENT_ID: 'abc',
      DHAN_ACCESS_TOKEN: 'xyz',
    });
  });

  it('maps strategyId to consumerId accurately', () => {
    expect(strategyIdToConsumerId('s1-momentum-burst')).toBe('s1');
    expect(strategyIdToConsumerId('s2-vwap-fade')).toBe('s2');
    expect(strategyIdToConsumerId('allop-atm-mm')).toBe('all-op');
    expect(strategyIdToConsumerId('op-minus-atm-short')).toBe('op-minus');
    expect(strategyIdToConsumerId('arb')).toBe('arb');
    expect(strategyIdToConsumerId('ex-s1')).toBe('ex-s1');
    expect(() => strategyIdToConsumerId('unsupported-strategy')).toThrow(/Cannot map strategyId/);
  });

  describe('USE_SHARED_MARKET_HUB safety gate and boolean parsing', () => {
    it('treats missing, blank, and false spellings as false', () => {
      expect(parseUseSharedMarketHub(undefined)).toBe(false);
      expect(parseUseSharedMarketHub('')).toBe(false);
      expect(parseUseSharedMarketHub('   ')).toBe(false);
      expect(parseUseSharedMarketHub('0')).toBe(false);
      expect(parseUseSharedMarketHub('false')).toBe(false);
      expect(parseUseSharedMarketHub('no')).toBe(false);
      expect(parseUseSharedMarketHub('off')).toBe(false);
      expect(parseUseSharedMarketHub('FALSE')).toBe(false);
      expect(parseUseSharedMarketHub(' Off ')).toBe(false);
    });

    it('treats accepted true spellings as true', () => {
      expect(parseUseSharedMarketHub('1')).toBe(true);
      expect(parseUseSharedMarketHub('true')).toBe(true);
      expect(parseUseSharedMarketHub('yes')).toBe(true);
      expect(parseUseSharedMarketHub('on')).toBe(true);
      expect(parseUseSharedMarketHub('TRUE')).toBe(true);
      expect(parseUseSharedMarketHub(' Yes ')).toBe(true);
      expect(parseUseSharedMarketHub('ON')).toBe(true);
    });

    it('rejects invalid boolean spellings', () => {
      expect(() => parseUseSharedMarketHub('maybe')).toThrow(/USE_SHARED_MARKET_HUB must be a boolean/);
      expect(() => parseUseSharedMarketHub('2')).toThrow(/USE_SHARED_MARKET_HUB must be a boolean/);
      expect(() => parseUseSharedMarketHub('enabled')).toThrow(/USE_SHARED_MARKET_HUB must be a boolean/);
    });
  });

  describe('SHARED_MARKET_HUB_MODE parsing and validation', () => {
    it('returns off when disabled regardless of mode variable', () => {
      expect(parseSharedMarketHubMode(undefined, false)).toBe('off');
      expect(parseSharedMarketHubMode('consume', false)).toBe('off');
      expect(parseSharedMarketHubMode('shadow', false)).toBe('off');
      expect(parseSharedMarketHubMode('invalid', false)).toBe('off');
    });

    it('requires mode when enabled=true and rejects missing or blank', () => {
      expect(() => parseSharedMarketHubMode(undefined, true)).toThrow(/SHARED_MARKET_HUB_MODE is required/);
      expect(() => parseSharedMarketHubMode('', true)).toThrow(/SHARED_MARKET_HUB_MODE is required/);
      expect(() => parseSharedMarketHubMode('   ', true)).toThrow(/SHARED_MARKET_HUB_MODE is required/);
    });

    it('accepts valid modes (off, shadow, consume) case-insensitively with whitespace', () => {
      expect(parseSharedMarketHubMode('off', true)).toBe('off');
      expect(parseSharedMarketHubMode('shadow', true)).toBe('shadow');
      expect(parseSharedMarketHubMode('consume', true)).toBe('consume');
      expect(parseSharedMarketHubMode(' SHADOW ', true)).toBe('shadow');
      expect(parseSharedMarketHubMode('Consume', true)).toBe('consume');
    });

    it('rejects invalid modes', () => {
      expect(() => parseSharedMarketHubMode('live', true)).toThrow(/Invalid SHARED_MARKET_HUB_MODE/);
      expect(() => parseSharedMarketHubMode('direct', true)).toThrow(/Invalid SHARED_MARKET_HUB_MODE/);
    });
  });

  describe('SHARED_MARKET_HUB_CONSUMERS allow-list parsing and normalization', () => {
    it('parses empty or blank as empty array', () => {
      expect(parseHubConsumers(undefined)).toEqual([]);
      expect(parseHubConsumers('')).toEqual([]);
      expect(parseHubConsumers('   ')).toEqual([]);
    });

    it('parses, trims, lowercases, and deduplicates valid consumers', () => {
      expect(parseHubConsumers('s1, s2, all-op')).toEqual(['s1', 's2', 'all-op']);
      expect(parseHubConsumers(' S1 , s1 , ALL-OP, op-minus ')).toEqual(['s1', 'all-op', 'op-minus']);
      expect(parseHubConsumers('ex-s1,arb,dh,vol-short,cash-scalp')).toEqual([
        'ex-s1',
        'arb',
        'dh',
        'vol-short',
        'cash-scalp',
      ]);
    });

    it('rejects unknown or misspelled consumer IDs', () => {
      expect(() => parseHubConsumers('s1, all_op')).toThrow(/Unknown consumer ID "all_op"/);
      expect(() => parseHubConsumers('unknown-desk')).toThrow(/Unknown consumer ID "unknown-desk"/);
      expect(() => parseHubConsumers('s3')).toThrow(/Unknown consumer ID "s3"/);
    });
  });

  describe('effective feedSource resolution under all combinations', () => {
    const baseEnv = {
      DHAN_CLIENT_ID: 'client-1',
      DHAN_ACCESS_TOKEN: 'token-1',
      DHAN_SCRIP_MASTER_PATH: 'master.csv',
    };

    it('rejects FEED_SOURCE=hub when USE_SHARED_MARKET_HUB is false or absent', () => {
      const path = tempEnv(``);
      expect(() =>
        loadDhanLiveDataPaperEnv({
          ...baseEnv,
          DHAN_ENV_PATH: path,
          FEED_SOURCE: 'hub',
        }),
      ).toThrow(/FEED_SOURCE="hub" cannot be used when USE_SHARED_MARKET_HUB is false\/off/);

      expect(() =>
        loadDhanLiveDataPaperEnv({
          ...baseEnv,
          DHAN_ENV_PATH: path,
          USE_SHARED_MARKET_HUB: 'false',
          FEED_SOURCE: 'hub',
        }),
      ).toThrow(/FEED_SOURCE="hub" cannot be used when USE_SHARED_MARKET_HUB is false\/off/);
    });

    it('rejects FEED_SOURCE=hub in shadow mode', () => {
      const path = tempEnv(``);
      expect(() =>
        loadDhanLiveDataPaperEnv({
          ...baseEnv,
          DHAN_ENV_PATH: path,
          USE_SHARED_MARKET_HUB: 'true',
          SHARED_MARKET_HUB_MODE: 'shadow',
          FEED_SOURCE: 'hub',
        }),
      ).toThrow(/cannot be consumed when SHARED_MARKET_HUB_MODE="shadow"/);
    });

    it('keeps strategies on direct dhan in shadow mode when FEED_SOURCE is omitted', () => {
      const path = tempEnv(``);
      const env = loadDhanLiveDataPaperEnv({
        ...baseEnv,
        DHAN_ENV_PATH: path,
        USE_SHARED_MARKET_HUB: 'true',
        SHARED_MARKET_HUB_MODE: 'shadow',
      });
      expect(env.feedSource).toBe('dhan');
      expect(env.hubMode).toBe('shadow');
    });

    it('in consume mode: selects hub only for allow-listed consumers', () => {
      const path = tempEnv(``);
      // Consumer S1 is allow-listed
      const envS1 = loadDhanLiveDataPaperEnv({
        ...baseEnv,
        DHAN_ENV_PATH: path,
        USE_SHARED_MARKET_HUB: 'true',
        SHARED_MARKET_HUB_MODE: 'consume',
        SHARED_MARKET_HUB_CONSUMERS: 's1',
        DHAN_STRATEGY_ID: 's1-momentum-burst',
      });
      expect(envS1.feedSource).toBe('hub');
      expect(envS1.consumerId).toBe('s1');

      // Consumer S2 is NOT allow-listed -> stays direct dhan
      const envS2 = loadDhanLiveDataPaperEnv({
        ...baseEnv,
        DHAN_ENV_PATH: path,
        USE_SHARED_MARKET_HUB: 'true',
        SHARED_MARKET_HUB_MODE: 'consume',
        SHARED_MARKET_HUB_CONSUMERS: 's1',
        DHAN_STRATEGY_ID: 's2-vwap-fade',
      });
      expect(envS2.feedSource).toBe('dhan');
      expect(envS2.consumerId).toBe('s2');

      // With empty allow-list in consume mode, all stay direct dhan
      const envEmpty = loadDhanLiveDataPaperEnv({
        ...baseEnv,
        DHAN_ENV_PATH: path,
        USE_SHARED_MARKET_HUB: 'true',
        SHARED_MARKET_HUB_MODE: 'consume',
        SHARED_MARKET_HUB_CONSUMERS: '',
        DHAN_STRATEGY_ID: 's1-momentum-burst',
      });
      expect(envEmpty.feedSource).toBe('dhan');
    });

    it('in consume mode: fails if FEED_SOURCE=hub is requested by a non-allow-listed consumer', () => {
      const path = tempEnv(``);
      expect(() =>
        loadDhanLiveDataPaperEnv({
          ...baseEnv,
          DHAN_ENV_PATH: path,
          USE_SHARED_MARKET_HUB: 'true',
          SHARED_MARKET_HUB_MODE: 'consume',
          SHARED_MARKET_HUB_CONSUMERS: 's1',
          DHAN_STRATEGY_ID: 's2-vwap-fade',
          FEED_SOURCE: 'hub',
        }),
      ).toThrow(/FEED_SOURCE="hub" requested, but consumer "s2" is not in SHARED_MARKET_HUB_CONSUMERS/);
    });

    it('allows explicit replay regardless of hub mode', () => {
      const path = tempEnv(``);
      const envReplay = loadDhanLiveDataPaperEnv({
        ...baseEnv,
        DHAN_ENV_PATH: path,
        FEED_SOURCE: 'replay',
      });
      expect(envReplay.feedSource).toBe('replay');
    });
  });
});
