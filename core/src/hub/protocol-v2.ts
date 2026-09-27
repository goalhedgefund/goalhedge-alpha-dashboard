import { z } from 'zod';
import type { Tick } from '../domain/marketdata.js';

/** Protocol version used only by the opt-in shared-routing transport. */
export const HUB_PROTOCOL_V2 = 2 as const;
export const MAX_HUB_FRAME_BYTES = 64 * 1024;
export const MAX_HUB_INSTRUMENTS_PER_REQUEST = 100;

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const clientId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);
const instrument = z.object({
  exchangeSegment: z.string().trim().min(1).max(32),
  brokerToken: z.string().trim().min(1).max(64),
  instrumentId: z.string().trim().min(1).max(128).optional(),
  requestCode: z.number().int().positive().max(255).optional(),
}).strict();

const helloSchema = z.object({
  t: z.literal('hello'),
  proto: z.literal(HUB_PROTOCOL_V2),
  clientId,
  instanceId: id,
  lastSessionId: z.string().trim().min(1).max(128).nullable().optional(),
  lastSequence: z.number().int().nonnegative().optional(),
}).strict();

const subSchema = z.object({
  t: z.literal('sub'),
  requestId: id,
  instruments: z.array(instrument).min(1).max(MAX_HUB_INSTRUMENTS_PER_REQUEST),
}).strict();
const unsubSchema = z.object({
  t: z.literal('unsub'),
  requestId: id,
  instruments: z.array(instrument).min(1).max(MAX_HUB_INSTRUMENTS_PER_REQUEST),
}).strict();

const pingSchema = z.object({
  t: z.literal('ping'),
  requestId: id.optional(),
}).strict();
const statusSchema = z.object({ t: z.literal('status'), requestId: id }).strict();

export type HubHelloV2 = z.infer<typeof helloSchema>;
export type HubSubscribeV2 = z.infer<typeof subSchema>;
export type HubUnsubscribeV2 = z.infer<typeof unsubSchema>;
export type HubPingV2 = z.infer<typeof pingSchema>;
export type HubStatusV2 = z.infer<typeof statusSchema>;
export type HubClientFrameV2 = HubHelloV2 | HubSubscribeV2 | HubUnsubscribeV2 | HubPingV2 | HubStatusV2;

export interface HubProtocolError {
  code: 'MALFORMED_JSON' | 'INVALID_FRAME' | 'HANDSHAKE_REQUIRED' | 'UNSUPPORTED_PROTOCOL' | 'UNKNOWN_MESSAGE' | 'FRAME_TOO_LARGE';
  message: string;
  requestId?: string;
}

export type ParseV2Result =
  | { ok: true; frame: HubClientFrameV2 }
  | { ok: false; error: HubProtocolError };

/**
 * Runtime validation deliberately returns stable, operator-safe errors rather
 * than serializing parser internals or the rejected payload.
 */
export function parseHubClientFrameV2(value: unknown): ParseV2Result {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: { code: 'INVALID_FRAME', message: 'frame must be an object' } };
  }
  const raw = value as Record<string, unknown>;
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.slice(0, 128) : undefined;
  if (typeof raw.t !== 'string') {
    return { ok: false, error: { code: 'INVALID_FRAME', message: 'frame type is required', ...(requestId ? { requestId } : {}) } };
  }

  const schema = raw.t === 'hello' ? helloSchema : raw.t === 'sub' ? subSchema : raw.t === 'unsub' ? unsubSchema : raw.t === 'ping' ? pingSchema : raw.t === 'status' ? statusSchema : undefined;
  if (!schema) {
    return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: `unknown frame type "${raw.t}"`, ...(requestId ? { requestId } : {}) } };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: { code: 'INVALID_FRAME', message: `invalid ${raw.t} frame`, ...(requestId ? { requestId } : {}) } };
  }
  return { ok: true, frame: parsed.data };
}

export function makeHubError(error: HubProtocolError): { t: 'error'; proto: 2; code: string; message: string; requestId?: string } {
  return {
    t: 'error',
    proto: HUB_PROTOCOL_V2,
    code: error.code,
    message: error.message,
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
}

export function makeHubWelcomeV2(input: {
  sessionId: string;
  connectionId: string;
  providerEpoch: number;
  universeVersion: number;
  serverTime?: number;
}): Record<string, unknown> {
  return {
    t: 'welcome',
    proto: HUB_PROTOCOL_V2,
    sessionId: input.sessionId,
    connectionId: input.connectionId,
    providerEpoch: input.providerEpoch,
    universeVersion: input.universeVersion,
    serverTime: input.serverTime ?? Date.now(),
  };
}

export function makeHubTickV2(input: { sessionId: string; providerEpoch: number; sequence: number; tick: Tick }): Record<string, unknown> {
  return {
    t: 'tick',
    proto: HUB_PROTOCOL_V2,
    sessionId: input.sessionId,
    providerEpoch: input.providerEpoch,
    sequence: input.sequence,
    d: input.tick,
  };
}
