export { EventBus } from './bus/event-bus.js';
export type { EventMap } from './bus/event-bus.js';
export { canonicalStringify, hashValue, loadConfig } from './config/loader.js';
export type { LoadedConfig } from './config/loader.js';
export {
  ChargeComponentSchema,
  MarketProfileSchema,
  RiskProfileSchema,
  StrategyConfigSchema,
} from './config/schemas.js';
export type {
  ChargeComponent,
  MarketProfile,
  RiskProfile,
  StrategyConfig,
} from './config/schemas.js';
export {
  aggregateCharges,
  computeCharges,
  computeTradeNet,
} from './charges/engine.js';
export type { FillForCharges } from './charges/engine.js';
export { logger } from './logger.js';
export type { Logger } from './logger.js';

export * from './domain/index.js';
export { JournalWriter } from './journal/writer.js';
export type { FsyncPolicy, JournalWriterOptions } from './journal/writer.js';
export { JournalIntegrityError, iterateJournal, readJournal } from './journal/reader.js';
export type { JournalReadOptions, JournalReadResult } from './journal/reader.js';
export { hashEventStream } from './journal/hash.js';
export { mirrorEvent } from './journal/mirror.js';
export { Persistence } from './persistence/db.js';
export type { TableCounts } from './persistence/db.js';

export const CORE_VERSION = '0.1.0';
