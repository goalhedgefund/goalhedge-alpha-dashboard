import { none, type IStrategy, type StrategyDecision } from '../types.js';

/**
 * ALL_OP — daily ATM option market maker.
 * Design: D:\Claude\workstation\docs\ALLOP_DESIGN.md.
 *
 * CP1 placeholder: registers the strategy id so the config, hosts, gateway,
 * and the workstation ALL_OP tab wire end-to-end. The real desk is an
 * MmRunner + QuotingEngine (CP2/CP3) managing a standing bid/ask set — it
 * will not flow through IStrategy.decide. Until then this stub never
 * proposes an entry, and the desk surfaces MM_ENGINE_NOT_BUILT as its
 * no-trade reason.
 */
export class AllOpAtmMm implements IStrategy {
  readonly id = 'allop-atm-mm';
  readonly version = '0.1.0';

  reset(): void {
    // stateless
  }

  decide(): StrategyDecision {
    return none('MM_ENGINE_NOT_BUILT');
  }
}
