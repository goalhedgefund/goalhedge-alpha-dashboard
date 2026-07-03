import type { InstrumentId } from '../../src/domain/ids.js';
import { makeInstrumentId } from '../../src/domain/ids.js';
import type { OptionChainRow } from '../../src/domain/marketdata.js';
import type { UnderlyingFeatures } from '../../src/marketdata/features/library.js';
import type { OptionView, StrategyView } from '../../src/strategy/types.js';

export const CE_ID: InstrumentId = makeInstrumentId('NSE', 'CE1');
export const PE_ID: InstrumentId = makeInstrumentId('NSE', 'PE1');
export const ATM_STRIKE = 2_450_000; // ₹24,500 in paise

export function mkFeatures(overrides: Partial<UnderlyingFeatures> = {}): UnderlyingFeatures {
  return {
    ret1s: 0,
    ret5s: 0,
    ret30s: 0,
    vwapPaise: 2_450_000,
    atr1mPaise: 1_500,
    tickVelocityPerSec: 5,
    volumeBurstRatio: 1,
    codexScore: { bull: 0, bear: 0, signal: 'WAIT', trend: 'flat', indicators: { last: 2_450_000 } },
    ...overrides,
  };
}

export function mkRow(
  instrumentId: InstrumentId,
  right: 'CE' | 'PE',
  overrides: Partial<OptionChainRow> = {},
): OptionChainRow {
  return {
    instrumentId,
    strikePaise: ATM_STRIKE,
    right,
    expiry: '2026-07-07',
    ltpPaise: 15_000,
    bidPaise: 14_990,
    askPaise: 15_000,
    bidQty: 650,
    askQty: 650,
    volume: 100_000,
    oi: 500_000,
    updatedTs: 1,
    ...overrides,
  };
}

export interface ViewOverrides {
  nowMs?: number;
  spotPaise?: number;
  features?: UnderlyingFeatures;
  atmStrikePaise?: number;
  ceRow?: OptionChainRow;
  peRow?: OptionChainRow;
  params?: Record<string, number | string | boolean>;
}

export function mkView(o: ViewOverrides = {}): StrategyView {
  const ceRow = o.ceRow ?? mkRow(CE_ID, 'CE');
  const peRow = o.peRow ?? mkRow(PE_ID, 'PE');
  const options = new Map<'CE' | 'PE', OptionView>([
    ['CE', { instrumentId: CE_ID, row: ceRow }],
    ['PE', { instrumentId: PE_ID, row: peRow }],
  ]);
  return {
    nowMs: o.nowMs ?? 1_000,
    spotPaise: o.spotPaise ?? 2_450_000,
    underlyingFeatures: o.features ?? mkFeatures(),
    atmStrikePaise: o.atmStrikePaise ?? ATM_STRIKE,
    atmOption: (right) => options.get(right),
    params: o.params ?? {},
  };
}
