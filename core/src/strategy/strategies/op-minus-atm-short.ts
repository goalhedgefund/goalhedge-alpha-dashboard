import { none, type IStrategy, type StrategyDecision } from '../types.js';

/**
 * OP(-) naked ATM short-option scalper.
 *
 * Execution is owned by OpMinusRunner because the strategy manages a
 * short-book cycle rather than one independent entry proposal.
 */
export class OpMinusAtmShort implements IStrategy {
  readonly id = 'op-minus-atm-short';
  readonly version = '0.1.0';

  reset(): void {
    // State lives in OpMinusRunner and its pure engine.
  }

  decide(): StrategyDecision {
    return none('OP_MINUS_RUNNER_OWNS_EXECUTION');
  }
}
