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

/** The slice of KillSwitch the command channel needs. */
export interface KillCommandTarget {
  trip(source: 'MANUAL' | 'AUTO', reason: string): Promise<unknown>;
  rearm(confirm: string, reason: string): { accepted: boolean; reason?: string };
  isLocked(): boolean;
}

export interface RunnerCommandOptions {
  /** When locked by the kill switch, ARM must be refused. */
  isLocked?: () => boolean;
}

/**
 * Wire ARM / DISARM / SET_PARAMS to the strategy runner. ACK_PREFLIGHT is
 * registered by the session module (M9b); until then the gateway rejects it
 * as UNKNOWN_COMMAND — never a silent success.
 */
export function registerRunnerCommands(
  gateway: Gateway,
  runner: RunnerCommandTarget,
  opts: RunnerCommandOptions = {},
): void {
  gateway.onCommand('ARM', () => {
    if (opts.isLocked?.() === true) return { accepted: false, reason: 'KILL_LOCKED' };
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

/**
 * Wire KILL / REARM to the kill switch. KILL always trips (idempotent);
 * REARM demands the typed confirmation and a reason — anything less is
 * rejected, and the UI shows exactly why.
 */
export function registerKillCommands(gateway: Gateway, kill: KillCommandTarget): void {
  gateway.onCommand('KILL', async (payload) => {
    const reason = typeof payload.reason === 'string' && payload.reason.trim() !== '' ? payload.reason : 'UI';
    await kill.trip('MANUAL', reason);
    return { accepted: true, reason: 'LOCKED' };
  });

  gateway.onCommand('REARM', (payload) => {
    const confirm = typeof payload.confirm === 'string' ? payload.confirm : '';
    const reason = typeof payload.reason === 'string' ? payload.reason : '';
    return kill.rearm(confirm, reason);
  });
}
