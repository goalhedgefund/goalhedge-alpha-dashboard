import type { Gateway } from './gateway.js';
import type { StrategyLifecycle, StrategyParams } from '../strategy/types.js';

/**
 * The slice of StrategyRunner the command channel needs. StrategyRunner
 * satisfies this structurally; tests can use a fake.
 */
export interface RunnerCommandTarget {
  arm(): void;
  disarm(): void;
  setParams(params: StrategyParams): void;
  state(): StrategyLifecycle;
}

/**
 * Wire ARM / DISARM / SET_PARAMS to the strategy runner. KILL / REARM /
 * ACK_PREFLIGHT are registered by the kill-switch and session modules (M9);
 * until then the gateway rejects them as UNKNOWN_COMMAND — never a silent
 * success.
 */
export function registerRunnerCommands(gateway: Gateway, runner: RunnerCommandTarget): void {
  gateway.onCommand('ARM', () => {
    runner.arm();
    return { accepted: true, reason: runner.state() };
  });

  gateway.onCommand('DISARM', () => {
    runner.disarm();
    return { accepted: true, reason: runner.state() };
  });

  gateway.onCommand('SET_PARAMS', (payload) => {
    const params = payload.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return { accepted: false, reason: 'INVALID_PARAMS' };
    }
    for (const v of Object.values(params as Record<string, unknown>)) {
      if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
        return { accepted: false, reason: 'INVALID_PARAMS' };
      }
    }
    runner.setParams(params as StrategyParams);
    return { accepted: true, reason: 'APPLIES_WHEN_FLAT' };
  });
}
