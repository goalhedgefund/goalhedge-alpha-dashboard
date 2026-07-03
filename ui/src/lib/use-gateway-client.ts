import { useEffect, useReducer, useRef } from 'react';
import type { GatewayState } from '@proto';
import { GatewayClient, type ConnStatus } from './gateway-client.js';

export interface GatewayHook {
  state: GatewayState | undefined;
  status: ConnStatus;
  client: GatewayClient;
}

/**
 * One GatewayClient per app. Re-renders on every protocol message and on a
 * 1s cadence (staleness + tick-age displays). Exposes window.__gw test hooks
 * for the Playwright seq-gap spec.
 */
export function useGatewayClient(url: string): GatewayHook {
  const ref = useRef<GatewayClient | null>(null);
  if (ref.current === null) {
    ref.current = new GatewayClient({ url });
  }
  const [, force] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const c = ref.current as GatewayClient;
    c.onChange = force;
    c.connect();
    const iv = setInterval(() => {
      c.tickStale();
      force();
    }, 1_000);
    (window as unknown as Record<string, unknown>).__gw = {
      skipSeq: () => c.skipSeq(),
      get stats() {
        return c.stats;
      },
      get lastSeq() {
        return c.lastSeq;
      },
    };
    return () => {
      clearInterval(iv);
      c.close();
    };
  }, []); // one client for the app lifetime

  return { state: ref.current.state, status: ref.current.status, client: ref.current };
}
