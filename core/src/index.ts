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

export type { IFeedAdapter, FeedHealth, FeedStatus, SubscribeRequest } from './feed/interface.js';
export { Recorder } from './feed/recorder.js';
export type { RecorderCompression, RecorderOptions } from './feed/recorder.js';
export { ReplayFeed } from './feed/replay.js';
export type { ReplayFeedOptions } from './feed/replay.js';
export { SynthFeed } from './feed/synth.js';
export type { SynthFeedOptions, SynthRegime } from './feed/synth.js';
export { BarBuilder } from './feed/bar-builder.js';
export { decodeDhanBuffer } from './feed/dhan/packet-decoder.js';
export type {
  DhanDepthLevel,
  DhanExchangeSegment,
  DhanFullPacket,
  DhanLtpPacket,
  DhanOiPacket,
  DhanPacket,
  DhanPrevClosePacket,
  DhanQuotePacket,
} from './feed/dhan/packet-decoder.js';
export { DhanFeed, dhanPacketToTick } from './feed/dhan/feed.js';
export type { DhanFeedOptions } from './feed/dhan/feed.js';

export {
  buildOptionChain,
  filterOptions,
  getChainStrikes,
  getExpiryDates,
  loadScripMaster,
  nextMonthlyExpiry,
  nextWeeklyExpiry,
  resolveNiftyWeeklyChain,
  toInstrument,
} from './marketdata/instrument-master.js';
export type {
  ChainEntry,
  ScripRow,
  WeeklyChainResult,
} from './marketdata/instrument-master.js';
export { AtmTracker } from './marketdata/atm-tracker.js';
export type { AtmTrackerOptions, AtmUpdate } from './marketdata/atm-tracker.js';
export { OptionChainState } from './marketdata/chain-state.js';
export type { AnalyticsContext, ChainStateOptions } from './marketdata/chain-state.js';
export {
  black76Greeks,
  black76Price,
  impliedVolBlack76,
  normalCdf,
  normalPdf,
} from './marketdata/black76.js';
export type { Black76Greeks, Black76Input, ImpliedVolOptions } from './marketdata/black76.js';
export {
  DEFAULT_CODEX_THRESHOLDS,
  scoreCodexSeries,
} from './marketdata/features/codex-score.js';
export type {
  CodexScore,
  CodexScoreConfig,
  CodexThresholds,
} from './marketdata/features/codex-score.js';
export {
  computeOptionFeatures,
  computeUnderlyingFeatures,
} from './marketdata/features/library.js';
export type { OptionFeatures, UnderlyingFeatures } from './marketdata/features/library.js';
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
export { PaperBroker } from './exec/paper-broker.js';
export type { PaperBrokerOptions, PaperQuote } from './exec/paper-broker.js';
export type { BrokerOrderEvent, IBrokerAdapter } from './exec/adapter.js';
export { TradesWriter } from './exec/trades-writer.js';
export type { TradesWriterOptions } from './exec/trades-writer.js';
export { Oms } from './oms/oms.js';
export type { JournalSink, OmsOptions, SubmitResult } from './oms/oms.js';
export { PositionKeeper } from './oms/position-keeper.js';
export { IllegalOrderTransitionError, canTransition, transitionOrder } from './oms/state-machine.js';
export { TokenBucket } from './oms/throttle.js';
export type { TokenBucketOptions } from './oms/throttle.js';
export { RiskGate } from './risk/risk-gate.js';
export type { RiskGateContext, RiskRejectReason } from './risk/risk-gate.js';
export { SessionRiskState } from './risk/session-risk.js';
export type { SessionRiskSnapshot } from './risk/session-risk.js';
export { StopEngine } from './stops/stop-engine.js';
export type { StopDecision, StopEngineOptions, StopTick, StopTriggerReason } from './stops/stop-engine.js';

export type {
  EntryProposal,
  IStrategy,
  NoSignal,
  OptionView,
  StrategyDecision,
  StrategyLifecycle,
  StrategyParams,
  StrategyView,
} from './strategy/types.js';
export { none, numParam } from './strategy/types.js';
export { buildLongOptionStopPlan } from './strategy/stop-plan.js';
export type { StopPlanPcts, UnderlyingInvalidation } from './strategy/stop-plan.js';
export { checkGlobal, checkOption } from './strategy/eligibility.js';
export type {
  EligibilityConfig,
  EligibilityResult,
  GlobalEligibilityInput,
  NoTradeReason,
  OptionEligibilityInput,
  RegimeTrend,
} from './strategy/eligibility.js';
export { StrategyRunner } from './strategy/runner.js';
export type {
  MarketViewProvider,
  RegimeProvider,
  StrategyRunnerOptions,
} from './strategy/runner.js';
export { S1MomentumBurst } from './strategy/strategies/s1-momentum-burst.js';
export { S2VwapFade } from './strategy/strategies/s2-vwap-fade.js';

export { Gateway } from './gateway/gateway.js';
export type { CommandHandler, CommandResult, GatewayOptions } from './gateway/gateway.js';
export { applyChanges } from './gateway/protocol.js';
export type {
  ClientMsg,
  CommandType,
  GatewayAlgoState,
  GatewayHealth,
  GatewayRiskState,
  GatewayState,
  ServerMsg,
  StateChange,
} from './gateway/protocol.js';
export { registerKillCommands, registerRunnerCommands } from './gateway/commands.js';
export type {
  KillCommandTarget,
  RunnerCommandOptions,
  RunnerCommandTarget,
} from './gateway/commands.js';
export { KillSwitch } from './killswitch/kill-switch.js';
export type {
  KillOmsPort,
  KillReport,
  KillSource,
  KillState,
  KillSwitchOptions,
  SelfTestCheck,
} from './killswitch/kill-switch.js';

export const CORE_VERSION = '0.1.0';
