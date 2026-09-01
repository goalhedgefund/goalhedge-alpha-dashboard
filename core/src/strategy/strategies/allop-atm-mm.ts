import { none, type IStrategy, type StrategyDecision } from '../types.js';

/**
 * ALL_OP daily ATM option market maker.
 * Design: D:\Claude\workstation\docs\ALLOP_DESIGN.md.
 *
 * Registers the strategy id for the shared host lifecycle. ALL_OP execution
 * is owned by MmRunner + QuotingEngine and intentionally does not flow
 * through IStrategy.decide.
 */
export class AllOpAtmMm implements IStrategy {
  readonly id = 'allop-atm-mm';
  readonly version = '0.10.0';

  reset(): void {
    // stateless
  }

  decide(): StrategyDecision {
    return none('MM_RUNNER_OWNS_EXECUTION');
  }
}
