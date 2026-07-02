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
export { logger } from './logger.js';
export type { Logger } from './logger.js';

export const CORE_VERSION = '0.1.0';
