import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DHAN_DEFAULT_WS_URL,
  loadDhanLiveDataPaperEnv,
  parseDhanEnvText,
} from '../src/host/dhan-live-data-paper-env.js';

function tempEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dhan-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('Dhan live-data paper env loader', () => {
  it('reads the Dhan env file and applies safe runner defaults', () => {
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
    expect(env.spotSecurityId).toBe('13');
    expect(env.spotExchangeSegment).toBe('IDX_I');
    expect(env.optionExchangeSegment).toBe('NSE_FNO');
    expect(env.feedRequestCode).toBe(21);
    expect(env.autoArm).toBe(false);
    expect(env.regimeTrendRet30Pct).toBe(0.0015);
    expect(env.paperSlippageTicks).toBe(1);
    expect(env.paperAckLatencyMs).toBe(80);
    expect(env.paperFillLatencyMs).toBe(120);
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
    expect(env.paperSlippageTicks).toBe(2);
    expect(env.paperAckLatencyMs).toBe(90);
    expect(env.paperFillLatencyMs).toBe(140);
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
});
