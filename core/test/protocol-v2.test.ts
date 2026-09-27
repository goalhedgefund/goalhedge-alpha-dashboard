import { describe, expect, it } from 'vitest';
import {
  HUB_PROTOCOL_V2,
  MAX_HUB_INSTRUMENTS_PER_REQUEST,
  makeHubError,
  parseHubClientFrameV2,
} from '../src/hub/protocol-v2.js';

describe('shared market hub protocol v2 validator', () => {
  it('accepts a complete identity-bearing hello frame', () => {
    const result = parseHubClientFrameV2({
      t: 'hello', proto: HUB_PROTOCOL_V2, clientId: 's1', instanceId: 's1-20260927-001',
      lastSessionId: null, lastSequence: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame.t).toBe('hello');
  });

  it('rejects missing identity and unsupported frame shape without echoing input', () => {
    const result = parseHubClientFrameV2({ t: 'hello', proto: HUB_PROTOCOL_V2, clientId: 's1' });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_FRAME', message: 'invalid hello frame' } });
    const error = makeHubError({ code: 'INVALID_FRAME', message: 'invalid hello frame' });
    expect(JSON.stringify(error)).not.toContain('accessToken');
  });

  it('bounds each subscription request and validates its request identity', () => {
    const instruments = Array.from({ length: MAX_HUB_INSTRUMENTS_PER_REQUEST + 1 }, (_, i) => ({
      exchangeSegment: 'NSE_FNO', brokerToken: String(i),
    }));
    const result = parseHubClientFrameV2({ t: 'sub', requestId: 's1-sub-1', instruments });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_FRAME', message: 'invalid sub frame', requestId: 's1-sub-1' } });
  });

  it('treats unknown message types as nonfatal structured errors', () => {
    const result = parseHubClientFrameV2({ t: 'future-command', requestId: 'req-1' });
    expect(result).toEqual({ ok: false, error: { code: 'UNKNOWN_MESSAGE', message: 'unknown frame type "future-command"', requestId: 'req-1' } });
  });
});
