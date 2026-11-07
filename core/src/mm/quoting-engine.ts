import { computeCharges } from '../charges/engine.js';
import type { MarketProfile } from '../config/schemas.js';
import type { InstrumentId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { OptionChainRow } from '../domain/marketdata.js';
import type { IntentType, Side, StopPlan } from '../domain/orders.js';
import { numParam, type StrategyParams } from '../strategy/types.js';

/**
 * ALL_OP hybrid quoting engine.
 *
 * The engine remains long-only and emits one covered sell lane per instrument.
 * Inventory exits are allocated to explicit fill lots so a profitable runner
 * can stay open while the other four slots continue scalping.
 */
export interface MmParams {
  spreadCostMultiple: number;
  /** Per-lot profit target, expressed as a multiple of round-trip costs. */
  takeProfitCostMultiple: number;
  maxLotsInventory: number;
  maxScalpLots: number;
  runnerLots: number;
  lotsPerOrder: number;
  ladderLevels: number;
  ladderGapPct: number;
  repriceTicks: number;
  /** Minimum lifetime for a passive entry quote before repricing it. */
  minRequoteMs: number;
  quoteTtlSec: number;
  /** Maximum age of an ordinary scalp lot. */
  maxHoldSec: number;
  /** Executable-bid hard stop, measured from each lot's own entry. */
  hardStopPct: number;
  /** Cancel same-right bids at this per-lot drawdown; do not average down. */
  adverseStopPct: number;
  /** Cooldown after an entry is rejected by a gate, avoiding retry storms. */
  entryRejectCooldownSec: number;
  /** Short option-premium window used to avoid buying into a still-falling touch. */
  entryMomentumLookbackSec: number;
  /** Maximum premium drop over the entry momentum window before bids pause. */
  maxEntryFallPct: number;
  /** Maximum executable L1 spread allowed when opening a passive bid, in percent. */
  maxEntrySpreadPct: number;
  /** Minimum displayed L1 bid/ask imbalance required for a new entry. */
  minEntryImbalance: number;
  /** Challenger score advantage required before changing the one-lot CE/PE lane. */
  entrySwitchScoreMargin: number;
  /** Time a materially better challenger must remain ahead before the lane changes. */
  entrySwitchConfirmMs: number;
  /** Maximum entry cancel/replacements in a rolling minute. 0 disables the guard. */
  maxEntryReplacementsPerMin: number;
  /** Keep passive entry quotes internal until the market approaches the anchored price. */
  shadowEntryEnabled: boolean;
  /** Lifetime of one anchored internal quote before it refreshes, without broker traffic. */
  shadowQuoteTtlMs: number;
  /** Report a shadow as near-touch within this distance; arming still requires a virtual fill. */
  shadowTriggerTicks: number;
  /** Maximum ticks above the shadow price allowed on the protected live limit. */
  shadowProtectionTicks: number;
  /** Minimum time after a touch before a recovering premium may release. */
  shadowConfirmMs: number;
  /** Executable-bid recovery required from the lowest touched ask. */
  shadowConfirmBounceTicks: number;
  /** Abandon a touched shadow if recovery does not arrive in this window. */
  shadowConfirmTimeoutMs: number;
  /** Lifetime of the real broker entry order after a shadow trigger. */
  shadowLiveOrderTtlMs: number;
  /** Cooldown after an armed order expires, is cancelled, or is rejected unfilled. */
  shadowRetryCooldownMs: number;
  /** Hard daily cap on broker-facing entry submissions. 0 disables the cap. */
  maxEntrySubmissionsPerDay: number;
  defensiveCooldownSec: number;
  /** Strategy-wide pause after any losing defensive exit. */
  globalDefensiveCooldownSec: number;
  /** Defensive exits inside one window that trigger the longer global pause. 0 disables. */
  globalLossClusterCount: number;
  globalLossClusterWindowSec: number;
  globalLossClusterCooldownSec: number;
  runnerActivationPct: number;
  runnerTrailPct: number;
  runnerMaxHoldSec: number;
  defensiveProtectTicks: number;
  deltaSkewLots: number;
  knifePct: number;
  knifeCooldownMin: number;
  /** Signed 5-min underlying move that declares a trend regime (suppresses against-trend bids). */
  trendPct: number;
  /** Hysteresis: the regime clears only when |drift| falls back below this. */
  trendResumePct: number;
  /** Require a confirmed directional regime before opening a long-option bid. */
  directionalOnly: boolean;
  /** Consecutive losing defensive exits on one right before the cooldown escalates. 0 disables. */
  lossStreakEscalation: number;
  escalatedCooldownSec: number;
  /** Maximum scalp lots on one side (CE or PE), excluding the runner. Limits clustering risk. */
  maxLotsPerSide: number;
  quoteFrom: string;
  bidCutoff: string;
  /** Disable the 15-second emergency market dump when strike/expiry migrates. */
  migrationPanicExit: boolean;
  /** Wing Scalp + Hold Architecture (combined CE + PE). */
  wingArchitectureEnabled: boolean;
  wingStepPoints: number;
  wingScaleInPoints: number;
  wingHoldLots: number;
  wingScalpLots: number;
  wingSpreadPct: number;
  wingNoStopLossOnBase: boolean;
  trendScalpStopNiftyPoints: number;
  /** Eliminate base straddle drag via credit-floor guard, with-trend short scaling, and breakout unwind/flip. */
  wingAvoidStraddleDrag: boolean;
  /** Minimum credit buffer (in points) required between Base Short Ask and Wing Hold reference price. */
  wingMinCreditPoints: number;
}

function strParam(params: StrategyParams, key: string, dflt: string): string {
  const v = params[key];
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : dflt;
}

function boundedParam(params: StrategyParams, key: string, dflt: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, numParam(params, key, dflt)));
}

function boolParam(params: StrategyParams, key: string, dflt: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : dflt;
}

export function resolveMmParams(params: StrategyParams): MmParams {
  const isWing = boolParam(params, 'wingArchitectureEnabled', false);
  const maxLotsInventory = Math.floor(boundedParam(params, 'maxLotsInventory', isWing ? 10 : 5, 1, 100));
  return {
    spreadCostMultiple: boundedParam(params, 'spreadCostMultiple', 3, 0.1, 100),
    takeProfitCostMultiple: boundedParam(params, 'takeProfitCostMultiple', 3, 0.1, 100),
    maxLotsInventory,
    maxScalpLots: Math.min(maxLotsInventory, Math.floor(boundedParam(params, 'maxScalpLots', isWing ? 10 : 4, 1, 100))),
    runnerLots: Math.min(1, Math.floor(boundedParam(params, 'runnerLots', 1, 0, 1))),
    lotsPerOrder: Math.floor(boundedParam(params, 'lotsPerOrder', 1, 1, 100)),
    ladderLevels: Math.floor(boundedParam(params, 'ladderLevels', 2, 1, 20)),
    ladderGapPct: boundedParam(params, 'ladderGapPct', 0.4, 0, 100),
    repriceTicks: Math.floor(boundedParam(params, 'repriceTicks', 2, 0, 100)),
    minRequoteMs: Math.floor(boundedParam(params, 'minRequoteMs', 2_000, 0, 60_000)),
    quoteTtlSec: boundedParam(params, 'quoteTtlSec', 20, 1, 86_400),
    maxHoldSec: boundedParam(params, 'maxHoldSec', 180, 1, 86_400),
    hardStopPct: boundedParam(params, 'hardStopPct', 10, 0.1, 99),
    adverseStopPct: boundedParam(params, 'adverseStopPct', 5, 0.1, 99),
    entryRejectCooldownSec: Math.floor(boundedParam(params, 'entryRejectCooldownSec', 10, 1, 3_600)),
    entryMomentumLookbackSec: Math.floor(boundedParam(params, 'entryMomentumLookbackSec', 5, 1, 60)),
    maxEntryFallPct: boundedParam(params, 'maxEntryFallPct', 0.2, 0, 20),
    maxEntrySpreadPct: boundedParam(params, 'maxEntrySpreadPct', 100, 0, 100),
    minEntryImbalance: boundedParam(params, 'minEntryImbalance', -1, -1, 1),
    entrySwitchScoreMargin: boundedParam(params, 'entrySwitchScoreMargin', 0.1, 0, 2),
    entrySwitchConfirmMs: Math.floor(boundedParam(params, 'entrySwitchConfirmMs', 1_500, 0, 60_000)),
    maxEntryReplacementsPerMin: Math.floor(boundedParam(params, 'maxEntryReplacementsPerMin', 12, 0, 120)),
    shadowEntryEnabled: boolParam(params, 'shadowEntryEnabled', false),
    shadowQuoteTtlMs: Math.floor(boundedParam(params, 'shadowQuoteTtlMs', 30_000, 1_000, 300_000)),
    shadowTriggerTicks: Math.floor(boundedParam(params, 'shadowTriggerTicks', 2, 0, 100)),
    shadowProtectionTicks: Math.floor(boundedParam(params, 'shadowProtectionTicks', 2, 0, 20)),
    shadowConfirmMs: Math.floor(boundedParam(params, 'shadowConfirmMs', 500, 0, 30_000)),
    shadowConfirmBounceTicks: Math.floor(boundedParam(params, 'shadowConfirmBounceTicks', 1, 0, 20)),
    shadowConfirmTimeoutMs: Math.floor(boundedParam(params, 'shadowConfirmTimeoutMs', 5_000, 250, 60_000)),
    shadowLiveOrderTtlMs: Math.floor(boundedParam(params, 'shadowLiveOrderTtlMs', 3_000, 250, 60_000)),
    shadowRetryCooldownMs: Math.floor(boundedParam(params, 'shadowRetryCooldownMs', 45_000, 0, 3_600_000)),
    maxEntrySubmissionsPerDay: Math.floor(boundedParam(params, 'maxEntrySubmissionsPerDay', 60, 0, 10_000)),
    defensiveCooldownSec: boundedParam(params, 'defensiveCooldownSec', 180, 0, 86_400),
    globalDefensiveCooldownSec: boundedParam(params, 'globalDefensiveCooldownSec', 0, 0, 86_400),
    globalLossClusterCount: Math.floor(boundedParam(params, 'globalLossClusterCount', 0, 0, 100)),
    globalLossClusterWindowSec: boundedParam(params, 'globalLossClusterWindowSec', 1_800, 1, 86_400),
    globalLossClusterCooldownSec: boundedParam(params, 'globalLossClusterCooldownSec', 1_800, 0, 86_400),
    runnerActivationPct: boundedParam(params, 'runnerActivationPct', 2, 0, 100),
    runnerTrailPct: boundedParam(params, 'runnerTrailPct', 3, 0.1, 99),
    runnerMaxHoldSec: boundedParam(params, 'runnerMaxHoldSec', 900, 1, 86_400),
    defensiveProtectTicks: Math.floor(boundedParam(params, 'defensiveProtectTicks', 10, 1, 100)),
    deltaSkewLots: boundedParam(params, 'deltaSkewLots', 3, 0, 100),
    knifePct: boundedParam(params, 'knifePct', 0.35, 0, 100),
    knifeCooldownMin: boundedParam(params, 'knifeCooldownMin', 10, 0, 1_440),
    trendPct: boundedParam(params, 'trendPct', 0.2, 0, 100),
    trendResumePct: boundedParam(params, 'trendResumePct', 0.1, 0, 100),
    directionalOnly: boolParam(params, 'directionalOnly', false),
    lossStreakEscalation: Math.floor(boundedParam(params, 'lossStreakEscalation', 2, 0, 100)),
    escalatedCooldownSec: boundedParam(params, 'escalatedCooldownSec', 900, 0, 86_400),
    maxLotsPerSide: Math.floor(boundedParam(params, 'maxLotsPerSide', isWing ? 6 : 2, 1, 100)),
    quoteFrom: strParam(params, 'quoteFrom', '09:20'),
    bidCutoff: strParam(params, 'bidCutoff', '15:10'),
    migrationPanicExit: boolParam(params, 'migrationPanicExit', false),
    wingArchitectureEnabled: isWing,
    wingStepPoints: Math.floor(boundedParam(params, 'wingStepPoints', 50, 10, 500)),
    wingScaleInPoints: Math.floor(boundedParam(params, 'wingScaleInPoints', 25, 5, 250)),
    wingHoldLots: Math.floor(boundedParam(params, 'wingHoldLots', 2, 0, 10)),
    wingScalpLots: Math.floor(boundedParam(params, 'wingScalpLots', 1, 0, 10)),
    wingSpreadPct: boundedParam(params, 'wingSpreadPct', 1.0, 0.1, 10.0),
    wingNoStopLossOnBase: boolParam(params, 'wingNoStopLossOnBase', true),
    trendScalpStopNiftyPoints: Math.floor(boundedParam(params, 'trendScalpStopNiftyPoints', 50, 10, 500)),
    wingAvoidStraddleDrag: boolParam(params, 'wingAvoidStraddleDrag', false),
    wingMinCreditPoints: boundedParam(params, 'wingMinCreditPoints', 10, 0, 200),
  };
}

export interface MmLotInput {
  lotId: string;
  qty: number;
  entryPricePaise: number;
  openedTs: number;
  entrySide?: Side;
  tag?: string;
  entrySpotPaise?: number;
}

/** One held option book. Actual runtime inputs always include fill-level lots. */
export interface MmBookInput {
  instrumentId: InstrumentId;
  right: OptionRight;
  qty: number;
  avgEntryPricePaise: number;
  openedTs: number;
  lots?: readonly MmLotInput[];
  row?: OptionChainRow;
}

export interface MmActiveRunnerInput extends MmLotInput {
  instrumentId: InstrumentId;
  activatedTs: number;
  highWaterBidPaise: number;
  stopPaise: number;
}

export interface MmQuoteInput {
  nowMs: number;
  nowHHMM: string;
  spotPaise?: number;
  atmCe?: OptionChainRow;
  atmPe?: OptionChainRow;
  wingCe?: OptionChainRow;
  wingPe?: OptionChainRow;
  contCe?: OptionChainRow;
  contPe?: OptionChainRow;
  wingHoldCeLotIds?: string[];
  wingHoldPeLotIds?: string[];
  wingHoldCeLotId?: string;
  wingHoldPeLotId?: string;
  ceLadderStage?: 'STAGE_0' | 'STAGE_1_SCALE_IN' | 'STAGE_2_WING' | 'PATH_1_PULLBACK' | 'PATH_2_TREND';
  peLadderStage?: 'STAGE_0' | 'STAGE_1_SCALE_IN' | 'STAGE_2_WING' | 'PATH_1_PULLBACK' | 'PATH_3_TREND';
  wingRollTriggered?: boolean;
  wingState?: {
    ceBaseStrikePaise?: number | undefined;
    ceWingStrikePaise?: number | undefined;
    ceScaleInSpotPaise?: number | undefined;
    ceTargetSpotPaise?: number | undefined;
    ceContinuationStrikePaise?: number | undefined;
    peBaseStrikePaise?: number | undefined;
    peWingStrikePaise?: number | undefined;
    peScaleInSpotPaise?: number | undefined;
    peTargetSpotPaise?: number | undefined;
    peContinuationStrikePaise?: number | undefined;
  };
  books: readonly MmBookInput[];
  latchedStop: boolean;
  runner?: MmActiveRunnerInput;
  pendingRunnerLotId?: string;
  allowRunnerCandidate?: boolean;
  /** Instruments temporarily ineligible after a rejected entry submission. */
  entryBlockedInstruments?: ReadonlySet<InstrumentId>;
}

export type MmDesiredReason =
  | 'QUOTE_BID'
  | 'QUOTE_ASK'
  | 'SCALP_EXIT'
  | 'SCALP_TIMEOUT'
  | 'HARD_STOP'
  | 'RUNNER_TRAIL'
  | 'RUNNER_TIMEOUT'
  | 'RISK_EXIT'
  | 'WING_HOLD_BUY'
  | 'WING_HOLD_SELL'
  | 'TREND_SCALP_BID'
  | 'TREND_SL_EXIT'
  | 'WING_ROLL_EXIT';

export interface MmDesiredOrder {
  instrumentId: InstrumentId;
  side: 'BUY' | 'SELL';
  qty: number;
  type: IntentType;
  limitPricePaise?: number;
  protectTicks?: number;
  purpose: 'ENTRY' | 'EXIT';
  reason: MmDesiredReason;
  stopPlan?: StopPlan;
  closeLotIds?: string[];
  entryFeatures?: MmEntryFeatures;
}

export interface MmEntryFeatures {
  spreadPct: number;
  imbalance: number;
  bidPaise: number;
  askPaise: number;
  bidQty: number;
  askQty: number;
  trendDriftPct: number;
  premiumMove1sPct?: number;
  premiumMove3sPct?: number;
  premiumMove5sPct?: number;
  premiumMove10sPct?: number;
  premiumMove30sPct?: number;
}

export type MmQuotePhase =
  | 'QUOTING'
  | 'ASK_ONLY'
  | 'PAUSED_WINDOW'
  | 'PAUSED_KNIFE'
  | 'PAUSED_LOCKOUT'
  | 'PAUSED_NEUTRAL'
  | 'PAUSED_ENTRY_QUALITY'
  | 'PAUSED_DEFENCE'
  | 'WING_ROLLING';

export interface MmDefenceState {
  right: OptionRight;
  reason: 'ADVERSE_BOOK' | 'COOLDOWN' | 'LOSS_STREAK' | 'TREND';
  instrumentId?: InstrumentId;
  drawdownPct?: number;
  untilTs?: number;
}

export type MmTrendRegime = 'NEUTRAL' | 'UP' | 'DOWN';

export interface MmEvaluation {
  desired: MmDesiredOrder[];
  phase: MmQuotePhase;
  pauseReason?: string;
  minSpreadPct?: number;
  runnerCandidateLotId?: string;
  defences: MmDefenceState[];
  trendRegime: MmTrendRegime;
  trendDriftPct: number;
  lossStreaks: Record<OptionRight, number>;
  /** Independently safe entry lanes, including candidates not selected by one-lot ranking. */
  eligibleEntryInstruments: InstrumentId[];
  selectedEntryRight?: OptionRight;
}

const KNIFE_WINDOW_MS = 5 * 60_000;

interface SpotPoint {
  ts: number;
  spotPaise: number;
}

interface PremiumPoint {
  ts: number;
  bidPaise: number;
}

interface EntryChallenger {
  right: OptionRight;
  sinceMs: number;
}

export class QuotingEngine {
  private params: MmParams;
  private spotHistory: SpotPoint[] = [];
  private knifeUntilMs = 0;
  private trendRegime: MmTrendRegime = 'NEUTRAL';
  private trendDriftPct = 0;
  private readonly premiumHistory = new Map<InstrumentId, PremiumPoint[]>();
  private readonly cooldownUntil = new Map<OptionRight, number>();
  private readonly lossStreak = new Map<OptionRight, number>();
  private globalDefensiveExitTs: number[] = [];
  private globalCooldownUntil = 0;
  private globalCooldownReason: 'DEFENSIVE_EXIT' | 'LOSS_CLUSTER' | undefined;
  private globalCooldownExitCount = 0;
  private lastDefences: MmDefenceState[] = [];
  private selectedEntryRight: OptionRight | undefined;
  private entryChallenger: EntryChallenger | undefined;

  constructor(
    private readonly market: MarketProfile,
    params: StrategyParams,
  ) {
    this.params = resolveMmParams(params);
  }

  setParams(params: StrategyParams): void {
    this.params = resolveMmParams(params);
    this.selectedEntryRight = undefined;
    this.entryChallenger = undefined;
  }

  activeParams(): MmParams {
    return { ...this.params };
  }

  roundTripCostPct(pricePaise: number): number {
    const qty = this.market.contract.lotSize;
    const charges = computeCharges(
      [
        { side: 'BUY', qty, pricePaise },
        { side: 'SELL', qty, pricePaise },
      ],
      this.market,
    );
    return (charges.totalPaise / (pricePaise * qty)) * 100;
  }

  minSpreadPct(pricePaise: number): number {
    return this.params.spreadCostMultiple * this.roundTripCostPct(pricePaise);
  }

  /** Net break-even plus one tick, used as the runner's minimum stop. */
  runnerBreakEvenPaise(entryPricePaise: number): number {
    const raw = entryPricePaise * (1 + this.roundTripCostPct(entryPricePaise) / 100);
    return ceilTick(raw, this.market.tickSizePaise) + this.market.tickSizePaise;
  }

  runnerStopPaise(entryPricePaise: number, highWaterBidPaise: number): number {
    const breakEven = this.runnerBreakEvenPaise(entryPricePaise);
    const activation = entryPricePaise * (1 + this.params.runnerActivationPct / 100);
    if (highWaterBidPaise < activation) return breakEven;
    const trail = floorTick(
      highWaterBidPaise * (1 - this.params.runnerTrailPct / 100),
      this.market.tickSizePaise,
    );
    return Math.max(breakEven, trail);
  }

  /**
   * A negative hard_stop/scalp_timeout completion: count the loss streak and
   * apply the same-right cooldown, escalated after repeated consecutive losses.
   */
  noteDefensiveExit(right: OptionRight, nowMs: number): void {
    const streak = (this.lossStreak.get(right) ?? 0) + 1;
    this.lossStreak.set(right, streak);
    const escalated = this.params.lossStreakEscalation > 0 && streak >= this.params.lossStreakEscalation;
    const cooldownSec = escalated ? this.params.escalatedCooldownSec : this.params.defensiveCooldownSec;
    this.cooldownUntil.set(right, nowMs + cooldownSec * 1_000);

    this.pruneGlobalDefensiveExits(nowMs);
    this.globalDefensiveExitTs.push(nowMs);
    const clustered =
      this.params.globalLossClusterCount > 0 &&
      this.globalDefensiveExitTs.length >= this.params.globalLossClusterCount;
    const globalCooldownSec = clustered
      ? this.params.globalLossClusterCooldownSec
      : this.params.globalDefensiveCooldownSec;
    const untilTs = nowMs + globalCooldownSec * 1_000;
    if (untilTs >= this.globalCooldownUntil) {
      this.globalCooldownUntil = untilTs;
      this.globalCooldownReason = clustered ? 'LOSS_CLUSTER' : 'DEFENSIVE_EXIT';
      this.globalCooldownExitCount = this.globalDefensiveExitTs.length;
    }
  }

  /** Any positive-net exit on a right breaks that right's consecutive-loss streak. */
  notePositiveExit(right: OptionRight): void {
    this.lossStreak.delete(right);
  }

  lossStreakCount(right: OptionRight): number {
    return this.lossStreak.get(right) ?? 0;
  }

  trendState(): { regime: MmTrendRegime; driftPct: number } {
    return { regime: this.trendRegime, driftPct: this.trendDriftPct };
  }

  entrySelection(): OptionRight | undefined {
    return this.selectedEntryRight;
  }

  defenceSnapshot(nowMs: number): MmDefenceState[] {
    return this.lastDefences.filter(
      (d) => d.reason === 'ADVERSE_BOOK' || d.reason === 'TREND' || (d.untilTs ?? 0) > nowMs,
    );
  }

  evaluate(input: MmQuoteInput): MmEvaluation {
    this.trackUnderlying(input);
    this.trackPremiums(input);
    const p = this.params;
    const tick = this.market.tickSizePaise;
    const lotSize = this.market.contract.lotSize;
    const desired: MmDesiredOrder[] = [];
    const candidateLotId = this.selectRunnerCandidate(input);
    const defences = this.computeDefences(input);
    this.lastDefences = defences;

    // Exits are always evaluated before entry gating.
    for (const book of input.books) {
      if (book.qty <= 0) continue;
      desired.push(...this.exitsForBook(book, input, candidateLotId, tick));
    }

    const pause = this.bidPause(input);
    if (pause !== undefined) {
      return this.result(desired, pause.phase, defences, input, candidateLotId, pause.reason);
    }

    const heldUnits = input.books.reduce((sum, book) => sum + Math.max(0, book.qty), 0);
    const runnerUnits = input.runner === undefined ? 0 : Math.max(0, input.runner.qty);
    const heldLots = heldUnits / lotSize;
    const scalpHeldLots = Math.max(0, heldUnits - runnerUnits) / lotSize;
    let remainingLots = Math.max(
      0,
      p.wingArchitectureEnabled
        ? Math.floor(p.maxLotsInventory - heldLots)
        : Math.floor(Math.min(p.maxLotsInventory - heldLots, p.maxScalpLots - scalpHeldLots)),
    );

    const ceLots = this.heldLots(input.books, 'CE', lotSize);
    const peLots = this.heldLots(input.books, 'PE', lotSize);
    const defensiveRights = new Set(defences.map((d) => d.right));
    const noDirectionalSetup = p.directionalOnly && this.trendRegime === 'NEUTRAL';
    const skip: Record<OptionRight, boolean> = p.wingArchitectureEnabled
      ? { CE: false, PE: false }
      : {
          CE: noDirectionalSetup || defensiveRights.has('CE') || ceLots - peLots >= p.deltaSkewLots,
          PE: noDirectionalSetup || defensiveRights.has('PE') || peLots - ceLots >= p.deltaSkewLots,
        };
    const heldByRight: Record<OptionRight, number> = { CE: ceLots, PE: peLots };
    const plannedByRight: Record<OptionRight, number> = { CE: 0, PE: 0 };
    const qualityRejects = new Map<OptionRight, { spreadPct: number; imbalance: number }>();
    const eligibleEntryInstruments = new Set<InstrumentId>();

    if (p.wingArchitectureEnabled) {
      if (input.wingRollTriggered) {
        return this.result(
          desired,
          'WING_ROLLING',
          defences,
          input,
          candidateLotId,
          'wing roll triggered: squaring off open positions',
          eligibleEntryInstruments,
        );
      }

      const ceStage = input.ceLadderStage ?? 'STAGE_0';
      const peStage = input.peLadderStage ?? 'STAGE_0';
      const holdCeLots = input.wingHoldCeLotIds ?? (input.wingHoldCeLotId ? [input.wingHoldCeLotId] : []);
      const holdPeLots = input.wingHoldPeLotIds ?? (input.wingHoldPeLotId ? [input.wingHoldPeLotId] : []);
      const wingCeHoldSet = new Set(holdCeLots);
      const wingPeHoldSet = new Set(holdPeLots);

      const {
        targetStationaryCeLots,
        targetStationaryPeLots,
        targetShortCeLots,
        targetShortPeLots,
      } = this.computeWingTargets(input);

      // Books and lots
      const baseCeBook = input.atmCe ? input.books.find((b) => b.instrumentId === input.atmCe?.instrumentId) : undefined;
      const basePeBook = input.atmPe ? input.books.find((b) => b.instrumentId === input.atmPe?.instrumentId) : undefined;
      const wingCeBook = input.wingCe ? input.books.find((b) => b.instrumentId === input.wingCe?.instrumentId) : undefined;
      const wingPeBook = input.wingPe ? input.books.find((b) => b.instrumentId === input.wingPe?.instrumentId) : undefined;
      const contCeBook = input.contCe ? input.books.find((b) => b.instrumentId === input.contCe?.instrumentId) : undefined;
      const contPeBook = input.contPe ? input.books.find((b) => b.instrumentId === input.contPe?.instrumentId) : undefined;

      const baseCeLots = baseCeBook ? this.bookLots(baseCeBook) : [];
      const basePeLots = basePeBook ? this.bookLots(basePeBook) : [];
      const baseCeShortLots = baseCeLots.filter((l) => l.entrySide === 'SELL');
      const basePeShortLots = basePeLots.filter((l) => l.entrySide === 'SELL');
      const baseCeLongLots = baseCeLots.filter((l) => l.entrySide !== 'SELL');
      const basePeLongLots = basePeLots.filter((l) => l.entrySide !== 'SELL');
      const wingCeLots = wingCeBook ? this.bookLots(wingCeBook) : [];
      const wingPeLots = wingPeBook ? this.bookLots(wingPeBook) : [];
      const wingCeHoldLotObjs = wingCeLots.filter((l) => wingCeHoldSet.has(l.lotId));
      const wingPeHoldLotObjs = wingPeLots.filter((l) => wingPeHoldSet.has(l.lotId));
      const wingCeScalpLots = wingCeLots.filter((l) => !wingCeHoldSet.has(l.lotId));
      const wingPeScalpLots = wingPeLots.filter((l) => !wingPeHoldSet.has(l.lotId));
      const contCeLots = contCeBook ? this.bookLots(contCeBook) : [];
      const contPeLots = contPeBook ? this.bookLots(contPeBook) : [];

      // Credit-floor guard reference prices for Base Short entries
      const wingCeRefPaise = wingCeHoldLotObjs.length > 0
        ? Math.round(wingCeHoldLotObjs.reduce((s, l) => s + l.entryPricePaise, 0) / wingCeHoldLotObjs.length)
        : (input.wingCe?.askPaise ?? 0);
      const wingPeRefPaise = wingPeHoldLotObjs.length > 0
        ? Math.round(wingPeHoldLotObjs.reduce((s, l) => s + l.entryPricePaise, 0) / wingPeHoldLotObjs.length)
        : (input.wingPe?.askPaise ?? 0);
      const minCreditPaise = Math.round(p.wingMinCreditPoints * 100);
      const ceCreditFloorOk = !p.wingAvoidStraddleDrag || wingCeRefPaise <= 0 ||
        (input.atmCe !== undefined && input.atmCe.askPaise >= wingCeRefPaise + minCreditPaise);
      const peCreditFloorOk = !p.wingAvoidStraddleDrag || wingPeRefPaise <= 0 ||
        (input.atmPe !== undefined && input.atmPe.askPaise >= wingPeRefPaise + minCreditPaise);

      // Check CE side
      if (!skip['CE']) {
        // 1. Stationary Wing CE:
        if (
          holdCeLots.length < targetStationaryCeLots &&
          input.wingCe !== undefined &&
          input.wingCe.bidPaise > 0 &&
          input.wingCe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.wingCe.instrumentId) &&
          remainingLots >= 1
        ) {
          const neededLots = Math.min(remainingLots, targetStationaryCeLots - holdCeLots.length);
          const price = input.wingCe.askPaise;
          desired.push({
            instrumentId: input.wingCe.instrumentId,
            side: 'BUY',
            qty: neededLots * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'WING_HOLD_BUY',
            stopPlan: {
              hardStopPremiumPaise: Math.max(tick, Math.round(price * 0.5)),
              timeStopSec: 86_400,
            },
          });
          plannedByRight['CE'] += neededLots;
          remainingLots -= neededLots;
          eligibleEntryInstruments.add(input.wingCe.instrumentId);
        }

        // 2. Base ATM CE Short (with Credit-Floor Guard when wingAvoidStraddleDrag is active):
        if (
          baseCeShortLots.length < targetShortCeLots &&
          baseCeLongLots.length === 0 &&
          ceCreditFloorOk &&
          input.atmCe !== undefined &&
          input.atmCe.bidPaise > 0 &&
          input.atmCe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.atmCe.instrumentId) &&
          remainingLots >= 1
        ) {
          const neededLots = Math.min(remainingLots, targetShortCeLots - baseCeShortLots.length);
          const price = input.atmCe.askPaise;
          const hardStop = ceilTick(price * (1 + p.hardStopPct / 100), tick);
          desired.push({
            instrumentId: input.atmCe.instrumentId,
            side: 'SELL',
            qty: neededLots * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'QUOTE_ASK',
            stopPlan: {
              hardStopPremiumPaise: hardStop,
              timeStopSec: 86_400,
            },
          });
          plannedByRight['CE'] += neededLots;
          remainingLots -= neededLots;
          eligibleEntryInstruments.add(input.atmCe.instrumentId);
        }

        // 2b. Base ATM CE Trend-Flip BFSL (when wingAvoidStraddleDrag unwinds short CE on breakout):
        if (
          p.wingAvoidStraddleDrag &&
          (ceStage === 'STAGE_2_WING' || ceStage === 'PATH_2_TREND') &&
          baseCeShortLots.length === 0 &&
          baseCeLongLots.length === 0 &&
          input.atmCe !== undefined &&
          input.atmCe.bidPaise > 0 &&
          input.atmCe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.atmCe.instrumentId) &&
          remainingLots >= 1
        ) {
          const price = input.atmCe.bidPaise;
          const hardStop = Math.max(tick, Math.round(price * (1 - p.hardStopPct / 100)));
          desired.push({
            instrumentId: input.atmCe.instrumentId,
            side: 'BUY',
            qty: 1 * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'QUOTE_BID',
            stopPlan: {
              hardStopPremiumPaise: hardStop,
              timeStopSec: 86_400,
            },
          });
          plannedByRight['CE'] += 1;
          remainingLots -= 1;
          eligibleEntryInstruments.add(input.atmCe.instrumentId);
        }

        // 3. Stage 2 / Path 2 Wing Scalp (1 lot BFSL on wing strike):
        if (
          (ceStage === 'STAGE_2_WING' || (p.wingAvoidStraddleDrag && ceStage === 'PATH_2_TREND')) &&
          wingCeScalpLots.length === 0 &&
          input.wingCe !== undefined &&
          input.wingCe.bidPaise > 0 &&
          input.wingCe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.wingCe.instrumentId) &&
          remainingLots >= 1
        ) {
          const price = input.wingCe.bidPaise;
          const hardStop = Math.max(tick, Math.round(price * (1 - p.hardStopPct / 100)));
          desired.push({
            instrumentId: input.wingCe.instrumentId,
            side: 'BUY',
            qty: 1 * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'QUOTE_BID',
            stopPlan: {
              hardStopPremiumPaise: hardStop,
              timeStopSec: 86_400,
            },
          });
          plannedByRight['CE'] += 1;
          remainingLots -= 1;
          eligibleEntryInstruments.add(input.wingCe.instrumentId);
        }

        // 4. Path 2 Trend Scalp (1 lot BFSL on ATM+100 strike):
        if (
          ceStage === 'PATH_2_TREND' &&
          contCeLots.length === 0 &&
          input.contCe !== undefined &&
          input.contCe.bidPaise > 0 &&
          input.contCe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.contCe.instrumentId) &&
          remainingLots >= 1
        ) {
          const price = input.contCe.bidPaise;
          desired.push({
            instrumentId: input.contCe.instrumentId,
            side: 'BUY',
            qty: 1 * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'TREND_SCALP_BID',
            stopPlan: {
              hardStopPremiumPaise: Math.max(tick, Math.round(price * 0.5)),
              timeStopSec: 86_400,
            },
          });
          plannedByRight['CE'] += 1;
          remainingLots -= 1;
          eligibleEntryInstruments.add(input.contCe.instrumentId);
        }
      }

      // Check PE side
      if (!skip['PE']) {
        // 1. Stationary Wing PE:
        if (
          holdPeLots.length < targetStationaryPeLots &&
          input.wingPe !== undefined &&
          input.wingPe.bidPaise > 0 &&
          input.wingPe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.wingPe.instrumentId) &&
          remainingLots >= 1
        ) {
          const neededLots = Math.min(remainingLots, targetStationaryPeLots - holdPeLots.length);
          const price = input.wingPe.askPaise;
          desired.push({
            instrumentId: input.wingPe.instrumentId,
            side: 'BUY',
            qty: neededLots * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'WING_HOLD_BUY',
            stopPlan: {
              hardStopPremiumPaise: Math.max(tick, Math.round(price * 0.5)),
              timeStopSec: 86_400,
            },
          });
          plannedByRight['PE'] += neededLots;
          remainingLots -= neededLots;
          eligibleEntryInstruments.add(input.wingPe.instrumentId);
        }

        // 2. Base ATM PE Short (with Credit-Floor Guard when wingAvoidStraddleDrag is active):
        if (
          basePeShortLots.length < targetShortPeLots &&
          basePeLongLots.length === 0 &&
          peCreditFloorOk &&
          input.atmPe !== undefined &&
          input.atmPe.bidPaise > 0 &&
          input.atmPe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.atmPe.instrumentId) &&
          remainingLots >= 1
        ) {
          const neededLots = Math.min(remainingLots, targetShortPeLots - basePeShortLots.length);
          const price = input.atmPe.askPaise;
          const hardStop = ceilTick(price * (1 + p.hardStopPct / 100), tick);
          desired.push({
            instrumentId: input.atmPe.instrumentId,
            side: 'SELL',
            qty: neededLots * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'QUOTE_ASK',
            stopPlan: {
              hardStopPremiumPaise: hardStop,
              timeStopSec: 86_400,
            },
          });
          plannedByRight['PE'] += neededLots;
          remainingLots -= neededLots;
          eligibleEntryInstruments.add(input.atmPe.instrumentId);
        }

        // 2b. Base ATM PE Trend-Flip BFSL (when wingAvoidStraddleDrag unwinds short PE on breakout):
        if (
          p.wingAvoidStraddleDrag &&
          (peStage === 'STAGE_2_WING' || peStage === 'PATH_3_TREND') &&
          basePeShortLots.length === 0 &&
          basePeLongLots.length === 0 &&
          input.atmPe !== undefined &&
          input.atmPe.bidPaise > 0 &&
          input.atmPe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.atmPe.instrumentId) &&
          remainingLots >= 1
        ) {
          const price = input.atmPe.bidPaise;
          const hardStop = Math.max(tick, Math.round(price * (1 - p.hardStopPct / 100)));
          desired.push({
            instrumentId: input.atmPe.instrumentId,
            side: 'BUY',
            qty: 1 * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'QUOTE_BID',
            stopPlan: {
              hardStopPremiumPaise: hardStop,
              timeStopSec: 86_400,
            },
          });
          plannedByRight['PE'] += 1;
          remainingLots -= 1;
          eligibleEntryInstruments.add(input.atmPe.instrumentId);
        }

        // 3. Stage 2 / Path 3 Wing Scalp (1 lot BFSL on wing strike):
        if (
          (peStage === 'STAGE_2_WING' || (p.wingAvoidStraddleDrag && peStage === 'PATH_3_TREND')) &&
          wingPeScalpLots.length === 0 &&
          input.wingPe !== undefined &&
          input.wingPe.bidPaise > 0 &&
          input.wingPe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.wingPe.instrumentId) &&
          remainingLots >= 1
        ) {
          const price = input.wingPe.bidPaise;
          const hardStop = Math.max(tick, Math.round(price * (1 - p.hardStopPct / 100)));
          desired.push({
            instrumentId: input.wingPe.instrumentId,
            side: 'BUY',
            qty: 1 * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'QUOTE_BID',
            stopPlan: {
              hardStopPremiumPaise: hardStop,
              timeStopSec: 86_400,
            },
          });
          plannedByRight['PE'] += 1;
          remainingLots -= 1;
          eligibleEntryInstruments.add(input.wingPe.instrumentId);
        }

        // 4. Path 3 Trend Scalp (1 lot BFSL on ATM-100 strike):
        if (
          peStage === 'PATH_3_TREND' &&
          contPeLots.length === 0 &&
          input.contPe !== undefined &&
          input.contPe.bidPaise > 0 &&
          input.contPe.askPaise > 0 &&
          !input.entryBlockedInstruments?.has(input.contPe.instrumentId) &&
          remainingLots >= 1
        ) {
          const price = input.contPe.bidPaise;
          desired.push({
            instrumentId: input.contPe.instrumentId,
            side: 'BUY',
            qty: 1 * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'TREND_SCALP_BID',
            stopPlan: {
              hardStopPremiumPaise: Math.max(tick, Math.round(price * 0.5)),
              timeStopSec: 86_400,
            },
          });
          plannedByRight['PE'] += 1;
          remainingLots -= 1;
          eligibleEntryInstruments.add(input.contPe.instrumentId);
        }
      }
    } else {
      const rights: Array<{ right: OptionRight; row?: OptionChainRow }> = [
        { right: 'CE', ...(input.atmCe !== undefined ? { row: input.atmCe } : {}) },
        { right: 'PE', ...(input.atmPe !== undefined ? { row: input.atmPe } : {}) },
      ];

      for (const { right, row } of rights) {
        if (
          skip[right] ||
          heldByRight[right] >= p.maxLotsPerSide ||
          row === undefined ||
          input.entryBlockedInstruments?.has(row.instrumentId) === true ||
          this.entryMomentumFalling(row, input.nowMs) ||
          row.bidPaise <= 0 ||
          row.askPaise <= 0
        ) {
          continue;
        }
        const quality = this.entryQuality(row);
        if (!quality.eligible) {
          qualityRejects.set(right, quality);
          continue;
        }
        eligibleEntryInstruments.add(row.instrumentId);
      }

      // A one-lot desk keeps its selected right until a materially better lane
      // remains ahead for long enough. Raw L1 depth flickers on asynchronous CE
      // and PE packets; switching on every score change destroys queue position.
      if (remainingLots === p.lotsPerOrder) {
        this.rankEntryCandidates(rights, eligibleEntryInstruments, input);
      }

      for (let level = 0; level < p.ladderLevels; level++) {
        for (const { right, row } of rights) {
          if (remainingLots < p.lotsPerOrder) break;
          if (
            skip[right] ||
            heldByRight[right] + plannedByRight[right] >= p.maxLotsPerSide ||
            row === undefined ||
            input.entryBlockedInstruments?.has(row.instrumentId) === true ||
            this.entryMomentumFalling(row, input.nowMs)
          ) continue;
          if (row.bidPaise <= 0 || row.askPaise <= 0) continue;
          const quality = this.entryQuality(row);
          if (!quality.eligible) {
            qualityRejects.set(right, quality);
            continue;
          }
          const mid = (row.bidPaise + row.askPaise) / 2;
          const minSpread = this.minSpreadPct(mid);
          const l1 = mid * (1 - minSpread / 200);
          const price = floorTick(l1 * (1 - (p.ladderGapPct / 100) * level), tick);
          if (price < 2 * tick) continue;
          const hardStop = Math.min(price - tick, floorTick(price * (1 - p.hardStopPct / 100), tick));
          if (hardStop <= 0) continue;
          desired.push({
            instrumentId: row.instrumentId,
            side: 'BUY',
            qty: p.lotsPerOrder * lotSize,
            type: 'LIMIT',
            limitPricePaise: price,
            purpose: 'ENTRY',
            reason: 'QUOTE_BID',
            stopPlan: { hardStopPremiumPaise: hardStop, timeStopSec: p.maxHoldSec },
            entryFeatures: this.entryFeatures(row, input, quality),
          });
          plannedByRight[right] += p.lotsPerOrder;
          remainingLots -= p.lotsPerOrder;
        }
      }
    }

    const hasEntry = desired.some((d) => d.purpose === 'ENTRY');
    if (!hasEntry && noDirectionalSetup) {
      return this.result(
        desired,
        'PAUSED_NEUTRAL',
        defences,
        input,
        candidateLotId,
        'directional-only: awaiting trend',
        eligibleEntryInstruments,
      );
    }
    if (!hasEntry && defences.length > 0) {
      const detail = defences.map((d) => `${d.right}:${d.reason}`).join(',');
      return this.result(
        desired,
        'PAUSED_DEFENCE',
        defences,
        input,
        candidateLotId,
        detail,
        eligibleEntryInstruments,
      );
    }
    if (!hasEntry && qualityRejects.size > 0) {
      const detail = [...qualityRejects]
        .map(([right, quality]) =>
          `${right}: spread ${quality.spreadPct.toFixed(3)}%, imbalance ${quality.imbalance.toFixed(2)}`)
        .join('; ');
      return this.result(
        desired,
        'PAUSED_ENTRY_QUALITY',
        defences,
        input,
        candidateLotId,
        `entry quality rejected (${detail})`,
        eligibleEntryInstruments,
      );
    }
    return this.result(
      desired,
      'QUOTING',
      defences,
      input,
      candidateLotId,
      undefined,
      eligibleEntryInstruments,
    );
  }

  private result(
    desired: MmDesiredOrder[],
    phase: MmQuotePhase,
    defences: MmDefenceState[],
    input: MmQuoteInput,
    candidateLotId?: string,
    pauseReason?: string,
    eligibleEntryInstruments: ReadonlySet<InstrumentId> = new Set(),
  ): MmEvaluation {
    const spread = this.representativeSpread(input);
    return {
      desired,
      phase,
      defences,
      trendRegime: this.trendRegime,
      trendDriftPct: this.trendDriftPct,
      lossStreaks: { CE: this.lossStreakCount('CE'), PE: this.lossStreakCount('PE') },
      eligibleEntryInstruments: [...eligibleEntryInstruments],
      ...(this.selectedEntryRight !== undefined ? { selectedEntryRight: this.selectedEntryRight } : {}),
      ...(pauseReason !== undefined ? { pauseReason } : {}),
      ...(spread !== undefined ? { minSpreadPct: spread } : {}),
      ...(candidateLotId !== undefined ? { runnerCandidateLotId: candidateLotId } : {}),
    };
  }

  private computeWingTargets(input: MmQuoteInput): {
    targetStationaryCeLots: number;
    targetStationaryPeLots: number;
    targetShortCeLots: number;
    targetShortPeLots: number;
  } {
    const ceStage = input.ceLadderStage ?? 'STAGE_0';
    const peStage = input.peLadderStage ?? 'STAGE_0';
    const avoidDrag = this.params.wingAvoidStraddleDrag;

    let targetStationaryCeLots = 1;
    if (ceStage === 'STAGE_1_SCALE_IN' || ceStage === 'STAGE_2_WING' || ceStage === 'PATH_2_TREND') {
      targetStationaryCeLots = 2;
    } else if (ceStage === 'PATH_1_PULLBACK') {
      const s0 = input.wingState?.ceBaseStrikePaise ?? 0;
      const scaleInSpot = input.wingState?.ceScaleInSpotPaise ?? (s0 + 2500);
      if (input.spotPaise !== undefined && input.spotPaise <= s0) {
        targetStationaryCeLots = 0;
      } else if (input.spotPaise !== undefined && input.spotPaise <= scaleInSpot) {
        targetStationaryCeLots = 1;
      } else {
        targetStationaryCeLots = 2;
      }
    }

    let targetStationaryPeLots = 1;
    if (peStage === 'STAGE_1_SCALE_IN' || peStage === 'STAGE_2_WING' || peStage === 'PATH_3_TREND') {
      targetStationaryPeLots = 2;
    } else if (peStage === 'PATH_1_PULLBACK') {
      const s0 = input.wingState?.peBaseStrikePaise ?? 0;
      const scaleInSpot = input.wingState?.peScaleInSpotPaise ?? (s0 - 2500);
      if (input.spotPaise !== undefined && input.spotPaise >= s0) {
        targetStationaryPeLots = 0;
      } else if (input.spotPaise !== undefined && input.spotPaise >= scaleInSpot) {
        targetStationaryPeLots = 1;
      } else {
        targetStationaryPeLots = 2;
      }
    }

    if (!avoidDrag) {
      let targetShortCeLots = 1;
      if (ceStage === 'STAGE_1_SCALE_IN' || ceStage === 'STAGE_2_WING' || ceStage === 'PATH_2_TREND') {
        targetShortCeLots = 2;
      } else if (ceStage === 'PATH_1_PULLBACK') {
        targetShortCeLots = targetStationaryCeLots;
      }

      let targetShortPeLots = 1;
      if (peStage === 'STAGE_1_SCALE_IN' || peStage === 'STAGE_2_WING' || peStage === 'PATH_3_TREND') {
        targetShortPeLots = 2;
      } else if (peStage === 'PATH_1_PULLBACK') {
        targetShortPeLots = targetStationaryPeLots;
      }

      return {
        targetStationaryCeLots,
        targetStationaryPeLots,
        targetShortCeLots,
        targetShortPeLots,
      };
    }

    // Straddle-Drag-Elimination mode:
    // Keep 1st Stationary Wing Hold lot anchored across STAGE_0 / PATH_1_PULLBACK around S0 (prevent sawtooth churn).
    if (ceStage === 'STAGE_1_SCALE_IN' || ceStage === 'STAGE_2_WING' || ceStage === 'PATH_2_TREND') {
      targetStationaryCeLots = 2;
    } else if (ceStage === 'PATH_1_PULLBACK') {
      const s0 = input.wingState?.ceBaseStrikePaise ?? 0;
      const scaleInSpot = input.wingState?.ceScaleInSpotPaise ?? (s0 + 2500);
      if (input.spotPaise !== undefined && input.spotPaise <= scaleInSpot - 1000) {
        targetStationaryCeLots = 1;
      } else {
        targetStationaryCeLots = 2;
      }
    } else {
      targetStationaryCeLots = 1;
    }

    if (peStage === 'STAGE_1_SCALE_IN' || peStage === 'STAGE_2_WING' || peStage === 'PATH_3_TREND') {
      targetStationaryPeLots = 2;
    } else if (peStage === 'PATH_1_PULLBACK') {
      const s0 = input.wingState?.peBaseStrikePaise ?? 0;
      const scaleInSpot = input.wingState?.peScaleInSpotPaise ?? (s0 - 2500);
      if (input.spotPaise !== undefined && input.spotPaise >= scaleInSpot + 1000) {
        targetStationaryPeLots = 1;
      } else {
        targetStationaryPeLots = 2;
      }
    } else {
      targetStationaryPeLots = 1;
    }

    // 1. Cut opposite stationary wing when breakout reaches Wing Strike (STAGE_2_WING / PATH_2_TREND / PATH_3_TREND)
    if (ceStage === 'STAGE_2_WING' || ceStage === 'PATH_2_TREND') {
      targetStationaryPeLots = 0;
    }
    if (peStage === 'STAGE_2_WING' || peStage === 'PATH_3_TREND') {
      targetStationaryCeLots = 0;
    }

    // 2. Never scale into the adverse short leg; instead scale the winning/decaying OTM short leg,
    //    and auto-unwind the adverse short leg at Wing Strike arrival (STAGE_2_WING / PATH_2_TREND / PATH_3_TREND).
    let targetShortCeLots = 1;
    if (ceStage === 'STAGE_2_WING' || ceStage === 'PATH_2_TREND') {
      targetShortCeLots = 0;
    } else if (peStage === 'STAGE_1_SCALE_IN' || peStage === 'STAGE_2_WING' || peStage === 'PATH_3_TREND') {
      targetShortCeLots = 2;
    } else if (ceStage === 'PATH_1_PULLBACK') {
      targetShortCeLots = Math.min(1, targetStationaryCeLots);
    }

    let targetShortPeLots = 1;
    if (peStage === 'STAGE_2_WING' || peStage === 'PATH_3_TREND') {
      targetShortPeLots = 0;
    } else if (ceStage === 'STAGE_1_SCALE_IN' || ceStage === 'STAGE_2_WING' || ceStage === 'PATH_2_TREND') {
      targetShortPeLots = 2;
    } else if (peStage === 'PATH_1_PULLBACK') {
      targetShortPeLots = Math.min(1, targetStationaryPeLots);
    }

    return {
      targetStationaryCeLots,
      targetStationaryPeLots,
      targetShortCeLots,
      targetShortPeLots,
    };
  }

  private exitsForBook(
    book: MmBookInput,
    input: MmQuoteInput,
    candidateLotId: string | undefined,
    tick: number,
  ): MmDesiredOrder[] {
    const row = book.row;
    const lots = this.bookLots(book);
    const runner = input.runner?.instrumentId === book.instrumentId ? input.runner : undefined;
    const wingHoldLots = new Set<string>();
    if (input.wingHoldCeLotIds) {
      for (const id of input.wingHoldCeLotIds) wingHoldLots.add(id);
    } else if (input.wingHoldCeLotId) {
      wingHoldLots.add(input.wingHoldCeLotId);
    }
    if (input.wingHoldPeLotIds) {
      for (const id of input.wingHoldPeLotIds) wingHoldLots.add(id);
    } else if (input.wingHoldPeLotId) {
      wingHoldLots.add(input.wingHoldPeLotId);
    }
    const scalpLots = lots.filter((lot) => lot.lotId !== runner?.lotId && !wingHoldLots.has(lot.lotId));
    const bid = row?.bidPaise ?? 0;
    const ask = row?.askPaise ?? 0;

    if (input.latchedStop) {
      return lots.map((lot) => this.urgentExitLot(book.instrumentId, lot, row, 'RISK_EXIT', tick));
    }

    // Mandatory 15:20 IST EOD square-off or explicit wing roll triggered
    if (this.params.wingArchitectureEnabled && (input.nowHHMM >= '15:20' || input.wingRollTriggered)) {
      return lots.map((lot) => this.urgentExitLot(book.instrumentId, lot, row, 'WING_ROLL_EXIT', tick));
    }

    // No hard stops on initial straddles or stationary wings when wingNoStopLossOnBase is active
    const hardStops = (this.params.wingArchitectureEnabled && this.params.wingNoStopLossOnBase)
      ? []
      : scalpLots.filter((lot) => {
          if (lot.entrySide === 'SELL') {
            return ask > 0 && ask >= lot.entryPricePaise * (1 + this.params.hardStopPct / 100);
          } else {
            return bid > 0 && bid <= lot.entryPricePaise * (1 - this.params.hardStopPct / 100);
          }
        });
    const hardIds = new Set(hardStops.map((lot) => lot.lotId));

    // Trend Scalp 50-pt Nifty stop loss
    const trendStops: MmLotInput[] = [];
    if (this.params.wingArchitectureEnabled && input.spotPaise !== undefined) {
      for (const lot of scalpLots) {
        if (lot.tag?.includes('trend_scalp')) {
          const isCe = book.right === 'CE';
          const entrySpot = lot.entrySpotPaise ?? (isCe ? (input.wingState?.ceContinuationStrikePaise ?? 0) : (input.wingState?.peContinuationStrikePaise ?? 0));
          const stopDist = isCe ? (entrySpot - input.spotPaise) : (input.spotPaise - entrySpot);
          if (stopDist >= this.params.trendScalpStopNiftyPoints * 100) {
            trendStops.push(lot);
          }
        }
      }
    }

    // Pullback (Path 1) & Breakout Unwind Exits for Stationary Wings & Base Straddles
    const pullbackExits: MmDesiredOrder[] = [];
    if (this.params.wingArchitectureEnabled) {
      const {
        targetStationaryCeLots: targetCe,
        targetStationaryPeLots: targetPe,
        targetShortCeLots: targetShortCe,
        targetShortPeLots: targetShortPe,
      } = this.computeWingTargets(input);

      if (input.wingCe && book.instrumentId === input.wingCe.instrumentId) {
        const holdCeLots = input.wingHoldCeLotIds ?? (input.wingHoldCeLotId ? [input.wingHoldCeLotId] : []);
        if (holdCeLots.length > targetCe) {
          const excessCount = holdCeLots.length - targetCe;
          const lotsToExit = lots.filter((l) => holdCeLots.includes(l.lotId)).slice(0, excessCount);
          for (const lot of lotsToExit) {
            pullbackExits.push(this.urgentExitLot(book.instrumentId, lot, row, 'WING_HOLD_SELL', tick));
          }
        }
      } else if (input.wingPe && book.instrumentId === input.wingPe.instrumentId) {
        const holdPeLots = input.wingHoldPeLotIds ?? (input.wingHoldPeLotId ? [input.wingHoldPeLotId] : []);
        if (holdPeLots.length > targetPe) {
          const excessCount = holdPeLots.length - targetPe;
          const lotsToExit = lots.filter((l) => holdPeLots.includes(l.lotId)).slice(0, excessCount);
          for (const lot of lotsToExit) {
            pullbackExits.push(this.urgentExitLot(book.instrumentId, lot, row, 'WING_HOLD_SELL', tick));
          }
        }
      } else if (input.atmCe && book.instrumentId === input.atmCe.instrumentId) {
        const shortCeLots = lots.filter((l) => l.entrySide === 'SELL');
        if (shortCeLots.length > targetShortCe) {
          const excessCount = shortCeLots.length - targetShortCe;
          for (const lot of shortCeLots.slice(0, excessCount)) {
            pullbackExits.push(this.urgentExitLot(book.instrumentId, lot, row, 'SCALP_EXIT', tick));
          }
        }
        if (this.params.wingAvoidStraddleDrag && targetShortCe > 0) {
          const longCeLots = scalpLots.filter((l) => l.entrySide !== 'SELL');
          for (const lot of longCeLots) {
            pullbackExits.push(this.urgentExitLot(book.instrumentId, lot, row, 'SCALP_EXIT', tick));
          }
        }
      } else if (input.atmPe && book.instrumentId === input.atmPe.instrumentId) {
        const shortPeLots = lots.filter((l) => l.entrySide === 'SELL');
        if (shortPeLots.length > targetShortPe) {
          const excessCount = shortPeLots.length - targetShortPe;
          for (const lot of shortPeLots.slice(0, excessCount)) {
            pullbackExits.push(this.urgentExitLot(book.instrumentId, lot, row, 'SCALP_EXIT', tick));
          }
        }
        if (this.params.wingAvoidStraddleDrag && targetShortPe > 0) {
          const longPeLots = scalpLots.filter((l) => l.entrySide !== 'SELL');
          for (const lot of longPeLots) {
            pullbackExits.push(this.urgentExitLot(book.instrumentId, lot, row, 'SCALP_EXIT', tick));
          }
        }
      }
    }

    const currentAtmStrike = input.atmCe?.strikePaise ?? input.atmPe?.strikePaise;
    const currentExpiry = input.atmCe?.expiry ?? input.atmPe?.expiry;
    const strikeMigrated = currentAtmStrike !== undefined &&
      row?.strikePaise !== undefined &&
      Math.abs(row.strikePaise - currentAtmStrike) >= this.market.contract.strikeStepPaise;
    const expiryMigrated = currentExpiry !== undefined &&
      row?.expiry !== undefined &&
      row.expiry !== currentExpiry;
    const migrationTimeoutSec = this.params.migrationPanicExit
      ? Math.min(this.params.maxHoldSec, 15)
      : this.params.maxHoldSec;

    // Time Guard: disabled in Wing Architecture mode
    const timedOut = this.params.wingArchitectureEnabled
      ? []
      : scalpLots.filter(
          (lot) => !hardIds.has(lot.lotId) && (
            input.nowMs - lot.openedTs >= this.params.maxHoldSec * 1_000 ||
            ((strikeMigrated || expiryMigrated) && input.nowMs - lot.openedTs >= migrationTimeoutSec * 1_000)
          ),
        );
    const pullbackIds = pullbackExits.flatMap((o) => o.closeLotIds ?? []);
    const defensiveIds = new Set([
      ...pullbackIds,
      ...hardStops.map((lot) => lot.lotId),
      ...trendStops.map((lot) => lot.lotId),
      ...timedOut.map((lot) => lot.lotId),
    ]);
    const exits = [
      ...pullbackExits,
      ...hardStops.map((lot) => this.urgentExitLot(book.instrumentId, lot, row, 'HARD_STOP', tick)),
      ...trendStops.map((lot) => this.urgentExitLot(book.instrumentId, lot, row, 'TREND_SL_EXIT', tick)),
      ...timedOut.map((lot) => this.urgentExitLot(book.instrumentId, lot, row, 'SCALP_TIMEOUT', tick)),
    ];

    if (runner !== undefined) {
      const runnerTrail = bid > 0 && bid <= runner.stopPaise;
      const runnerTimeout = input.nowMs - runner.activatedTs >= this.params.runnerMaxHoldSec * 1_000;
      if (runnerTrail || runnerTimeout) {
        exits.push(this.urgentExitLot(
          book.instrumentId,
          runner,
          row,
          runnerTrail ? 'RUNNER_TRAIL' : 'RUNNER_TIMEOUT',
          tick,
        ));
      }
    }

    if (row === undefined) return exits;
    const normalLots = scalpLots.filter(
      (lot) => lot.lotId !== candidateLotId && !defensiveIds.has(lot.lotId),
    );
    const reservingRunner = candidateLotId !== undefined && lots.some((x) => x.lotId === candidateLotId);
    for (const lot of normalLots) {
      const targetPct = this.params.wingArchitectureEnabled
        ? this.params.wingSpreadPct
        : this.params.takeProfitCostMultiple * this.roundTripCostPct(lot.entryPricePaise);

      if (lot.entrySide === 'SELL') {
        const price = floorTick(lot.entryPricePaise * (1 - targetPct / 100), tick);
        if (price <= 0) continue;
        exits.push({
          instrumentId: book.instrumentId,
          side: 'BUY',
          qty: lot.qty,
          type: 'LIMIT',
          limitPricePaise: price,
          purpose: 'EXIT',
          reason: 'QUOTE_BID',
          closeLotIds: [lot.lotId],
        });
      } else {
        const price = ceilTick(lot.entryPricePaise * (1 + targetPct / 100), tick);
        if (price <= 0) continue;
        exits.push(sellLots(book.instrumentId, [lot], price, reservingRunner ? 'SCALP_EXIT' : 'QUOTE_ASK'));
      }
    }
    return exits;
  }

  private urgentExitLot(
    instrumentId: InstrumentId,
    lot: MmLotInput,
    row: OptionChainRow | undefined,
    reason: MmDesiredReason,
    tick: number,
  ): MmDesiredOrder {
    const isShort = lot.entrySide === 'SELL';
    const protectTicks = this.params.defensiveProtectTicks;
    if (isShort) {
      const askPaise = row?.askPaise ?? 0;
      return {
        instrumentId,
        side: 'BUY',
        qty: lot.qty,
        type: askPaise > 0 ? 'LIMIT' : 'MARKET_PROTECT',
        ...(askPaise > 0 ? { limitPricePaise: askPaise + protectTicks * tick } : {}),
        protectTicks,
        purpose: 'EXIT',
        reason,
        closeLotIds: [lot.lotId],
      };
    } else {
      const bidPaise = row?.bidPaise ?? 0;
      return {
        instrumentId,
        side: 'SELL',
        qty: lot.qty,
        type: bidPaise > 0 ? 'LIMIT' : 'MARKET_PROTECT',
        ...(bidPaise > 0 ? { limitPricePaise: Math.max(tick, bidPaise - protectTicks * tick) } : {}),
        protectTicks,
        purpose: 'EXIT',
        reason,
        closeLotIds: [lot.lotId],
      };
    }
  }

  private urgentSellLot(
    instrumentId: InstrumentId,
    lot: MmLotInput,
    bidPaise: number,
    reason: MmDesiredReason,
    tick: number,
  ): MmDesiredOrder {
    return this.urgentExitLot(instrumentId, lot, { bidPaise } as OptionChainRow, reason, tick);
  }

  private selectRunnerCandidate(input: MmQuoteInput): string | undefined {
    if (
      this.params.runnerLots === 0 ||
      input.runner !== undefined ||
      input.allowRunnerCandidate === false ||
      input.latchedStop ||
      input.nowHHMM < this.params.quoteFrom ||
      input.nowHHMM >= this.params.bidCutoff
    ) {
      return undefined;
    }
    if (
      input.pendingRunnerLotId !== undefined &&
      input.books.some((book) => this.bookLots(book).some((lot) => lot.lotId === input.pendingRunnerLotId))
    ) {
      return input.pendingRunnerLotId;
    }
    const eligible = input.books
      .map((book) => ({ book, lots: this.bookLots(book) }))
      .filter(({ lots }) => lots.length >= 2)
      .sort((a, b) => b.lots.length - a.lots.length);
    const selected = eligible[0];
    if (selected === undefined) return undefined;
    return [...selected.lots]
      .sort((a, b) => a.entryPricePaise - b.entryPricePaise || b.openedTs - a.openedTs)[0]?.lotId;
  }

  private computeDefences(input: MmQuoteInput): MmDefenceState[] {
    const adverse = new Map<OptionRight, MmDefenceState>();
    for (const book of input.books) {
      const bid = book.row?.bidPaise ?? 0;
      if (bid <= 0) continue;
      for (const lot of this.bookLots(book)) {
        if (lot.lotId === input.runner?.lotId || lot.entryPricePaise <= 0) continue;
        const drawdownPct = ((lot.entryPricePaise - bid) / lot.entryPricePaise) * 100;
        if (drawdownPct < this.params.adverseStopPct) continue;
        const current = adverse.get(book.right);
        if (current === undefined || drawdownPct > (current.drawdownPct ?? 0)) {
          adverse.set(book.right, {
            right: book.right,
            reason: 'ADVERSE_BOOK',
            instrumentId: book.instrumentId,
            drawdownPct,
          });
        }
      }
    }

    const result = [...adverse.values()];
    for (const right of ['CE', 'PE'] as const) {
      if (adverse.has(right)) continue;
      const untilTs = this.cooldownUntil.get(right) ?? 0;
      if (untilTs > input.nowMs) {
        const escalated =
          this.params.lossStreakEscalation > 0 &&
          (this.lossStreak.get(right) ?? 0) >= this.params.lossStreakEscalation;
        result.push({ right, reason: escalated ? 'LOSS_STREAK' : 'COOLDOWN', untilTs });
      } else if (untilTs > 0) this.cooldownUntil.delete(right);
    }
    const suppressed = this.trendSuppressedRight();
    if (suppressed !== undefined && !result.some((d) => d.right === suppressed)) {
      result.push({ right: suppressed, reason: 'TREND' });
    }
    return result;
  }

  private bookLots(book: MmBookInput): MmLotInput[] {
    if (book.lots !== undefined) return book.lots.map((lot) => ({ ...lot }));
    const lotSize = this.market.contract.lotSize;
    const count = Math.floor(book.qty / lotSize);
    return Array.from({ length: count }, (_, index) => ({
      lotId: `${String(book.instrumentId)}:legacy:${index}`,
      qty: lotSize,
      entryPricePaise: book.avgEntryPricePaise,
      openedTs: book.openedTs,
    }));
  }

  private bidPause(input: MmQuoteInput): { phase: MmQuotePhase; reason: string } | undefined {
    const p = this.params;
    if (input.latchedStop) return { phase: 'PAUSED_LOCKOUT', reason: 'session stop latched' };
    if (input.nowHHMM < p.quoteFrom) return { phase: 'PAUSED_WINDOW', reason: `bids start ${p.quoteFrom}` };
    if (input.nowHHMM >= p.bidCutoff) return { phase: 'ASK_ONLY', reason: `bid cutoff ${p.bidCutoff}` };
    this.pruneGlobalDefensiveExits(input.nowMs);
    if (input.nowMs < this.globalCooldownUntil) {
      const remainingSec = Math.ceil((this.globalCooldownUntil - input.nowMs) / 1_000);
      const reason = this.globalCooldownReason === 'LOSS_CLUSTER'
        ? `global loss cluster (${this.globalCooldownExitCount} defensive exits); bids resume in ${remainingSec}s`
        : `global defensive cooldown; bids resume in ${remainingSec}s`;
      return { phase: 'PAUSED_DEFENCE', reason };
    }
    if (this.globalCooldownUntil > 0) {
      this.globalCooldownUntil = 0;
      this.globalCooldownReason = undefined;
      this.globalCooldownExitCount = 0;
    }
    if (input.nowMs < this.knifeUntilMs) {
      return { phase: 'PAUSED_KNIFE', reason: `falling knife; bids resume ${new Date(this.knifeUntilMs).toISOString()}` };
    }
    return undefined;
  }

  private pruneGlobalDefensiveExits(nowMs: number): void {
    const cutoff = nowMs - this.params.globalLossClusterWindowSec * 1_000;
    this.globalDefensiveExitTs = this.globalDefensiveExitTs.filter((ts) => ts >= cutoff);
  }

  /** One rolling 5-min spot window feeds both the knife (absolute) and trend (signed) checks. */
  private trackUnderlying(input: MmQuoteInput): void {
    const spot = input.spotPaise;
    if (spot === undefined || spot <= 0) return;
    this.spotHistory.push({ ts: input.nowMs, spotPaise: spot });
    const cutoff = input.nowMs - KNIFE_WINDOW_MS;
    while (this.spotHistory.length > 0 && (this.spotHistory[0] as SpotPoint).ts < cutoff) {
      this.spotHistory.shift();
    }
    const oldest = this.spotHistory[0];
    if (oldest === undefined || oldest.spotPaise <= 0) return;
    const driftPct = ((spot - oldest.spotPaise) / oldest.spotPaise) * 100;
    this.trendDriftPct = driftPct;
    if (Math.abs(driftPct) >= this.params.knifePct) {
      this.knifeUntilMs = input.nowMs + this.params.knifeCooldownMin * 60_000;
    }
    this.updateTrendRegime(driftPct);
  }

  private updateTrendRegime(driftPct: number): void {
    if (this.params.trendPct <= 0) {
      this.trendRegime = 'NEUTRAL';
      return;
    }
    switch (this.trendRegime) {
      case 'NEUTRAL':
        if (driftPct >= this.params.trendPct) this.trendRegime = 'UP';
        else if (driftPct <= -this.params.trendPct) this.trendRegime = 'DOWN';
        break;
      case 'UP':
        if (driftPct <= -this.params.trendPct) this.trendRegime = 'DOWN';
        else if (driftPct < this.params.trendResumePct) this.trendRegime = 'NEUTRAL';
        break;
      case 'DOWN':
        if (driftPct >= this.params.trendPct) this.trendRegime = 'UP';
        else if (driftPct > -this.params.trendResumePct) this.trendRegime = 'NEUTRAL';
        break;
    }
  }

  private trackPremiums(input: MmQuoteInput): void {
    const rows = [input.atmCe, input.atmPe];
    const cutoff = input.nowMs - 60_000;
    for (const row of rows) {
      if (row === undefined || row.bidPaise <= 0) continue;
      const history = this.premiumHistory.get(row.instrumentId) ?? [];
      const last = history.at(-1);
      if (last?.ts !== input.nowMs || last.bidPaise !== row.bidPaise) {
        history.push({ ts: input.nowMs, bidPaise: row.bidPaise });
      }
      while (history.length > 0 && history[0]!.ts < cutoff) history.shift();
      this.premiumHistory.set(row.instrumentId, history);
    }
  }

  private entryMomentumFalling(row: OptionChainRow, nowMs: number): boolean {
    if (this.params.maxEntryFallPct <= 0) return false;
    const history = this.premiumHistory.get(row.instrumentId);
    if (history === undefined || history.length < 2) return false;
    const cutoff = nowMs - this.params.entryMomentumLookbackSec * 1_000;
    const anchor = history.find((point) => point.ts >= cutoff);
    if (anchor === undefined || anchor.bidPaise <= 0) return false;
    const fallPct = ((anchor.bidPaise - row.bidPaise) / anchor.bidPaise) * 100;
    return fallPct >= this.params.maxEntryFallPct;
  }

  private premiumMovePct(
    row: OptionChainRow,
    nowMs: number,
    lookbackSec: number,
    requireFullWindow: boolean,
  ): number | undefined {
    const history = this.premiumHistory.get(row.instrumentId);
    if (history === undefined || history.length < 2) return undefined;
    const windowMs = lookbackSec * 1_000;
    const cutoff = nowMs - windowMs;
    const anchor = history.find((point) => point.ts >= cutoff);
    if (
      anchor === undefined ||
      anchor.bidPaise <= 0 ||
      (requireFullWindow && nowMs - anchor.ts < windowMs * 0.8)
    ) {
      return undefined;
    }
    return ((row.bidPaise - anchor.bidPaise) / anchor.bidPaise) * 100;
  }

  private entryFeatures(
    row: OptionChainRow,
    input: MmQuoteInput,
    quality: { spreadPct: number; imbalance: number },
  ): MmEntryFeatures {
    const features: MmEntryFeatures = {
      spreadPct: quality.spreadPct,
      imbalance: quality.imbalance,
      bidPaise: row.bidPaise,
      askPaise: row.askPaise,
      bidQty: row.bidQty,
      askQty: row.askQty,
      trendDriftPct: this.trendDriftPct,
    };
    for (const lookbackSec of [1, 3, 5, 10, 30] as const) {
      const move = this.premiumMovePct(row, input.nowMs, lookbackSec, true);
      if (move !== undefined) features[`premiumMove${lookbackSec}sPct`] = move;
    }
    return features;
  }

  private entryQuality(row: OptionChainRow): {
    eligible: boolean;
    spreadPct: number;
    imbalance: number;
  } {
    const mid = (row.bidPaise + row.askPaise) / 2;
    const spreadPct = mid > 0 ? ((row.askPaise - row.bidPaise) / mid) * 100 : Infinity;
    const depth = row.bidQty + row.askQty;
    const imbalance = depth > 0 ? (row.bidQty - row.askQty) / depth : -1;
    return {
      eligible:
        depth > 0 &&
        spreadPct <= this.params.maxEntrySpreadPct &&
        imbalance >= this.params.minEntryImbalance,
      spreadPct,
      imbalance,
    };
  }

  /** The right whose entry bids are suppressed by the current trend regime, if any. */
  private trendSuppressedRight(): OptionRight | undefined {
    if (this.trendRegime === 'UP') return 'PE';
    if (this.trendRegime === 'DOWN') return 'CE';
    return undefined;
  }

  private heldLots(books: readonly MmBookInput[], right: OptionRight, lotSize: number): number {
    return books.filter((book) => book.right === right).reduce((sum, book) => sum + Math.max(0, book.qty), 0) / lotSize;
  }

  private compareEntryCandidates(
    left: { right: OptionRight; row?: OptionChainRow },
    right: { right: OptionRight; row?: OptionChainRow },
    input: MmQuoteInput,
  ): number {
    const score = (candidate: { row?: OptionChainRow }): number => {
      const row = candidate.row;
      if (row === undefined || row.bidPaise <= 0 || row.askPaise <= 0) return -Infinity;
      const mid = (row.bidPaise + row.askPaise) / 2;
      const spreadPct = (row.askPaise - row.bidPaise) / mid;
      const depth = row.bidQty + row.askQty;
      const imbalance = depth > 0 ? (row.bidQty - row.askQty) / depth : 0;
      // Prefer tighter markets, then bids supported by displayed depth.
      return imbalance - spreadPct * 10;
    };
    const difference = score(right) - score(left);
    if (Math.abs(difference) > 1e-9) return difference;
    const ceFirst = Math.floor(input.nowMs / 60_000) % 2 === 0;
    if (left.right === right.right) return 0;
    return left.right === (ceFirst ? 'CE' : 'PE') ? -1 : 1;
  }

  private rankEntryCandidates(
    candidates: Array<{ right: OptionRight; row?: OptionChainRow }>,
    eligibleInstruments: ReadonlySet<InstrumentId>,
    input: MmQuoteInput,
  ): void {
    const eligible = candidates.filter(
      (candidate) => candidate.row !== undefined && eligibleInstruments.has(candidate.row.instrumentId),
    );
    if (eligible.length === 0) {
      this.entryChallenger = undefined;
      return;
    }

    const ranked = [...eligible].sort((left, right) => this.compareEntryCandidates(left, right, input));
    const rawBest = ranked[0]!;
    const incumbent = eligible.find((candidate) => candidate.right === this.selectedEntryRight);
    if (incumbent === undefined) {
      this.selectedEntryRight = rawBest.right;
      this.entryChallenger = undefined;
    } else if (rawBest.right === incumbent.right) {
      this.entryChallenger = undefined;
    } else {
      const advantage = this.entryCandidateScore(rawBest) - this.entryCandidateScore(incumbent);
      if (advantage < this.params.entrySwitchScoreMargin) {
        this.entryChallenger = undefined;
      } else if (this.entryChallenger?.right !== rawBest.right) {
        this.entryChallenger = { right: rawBest.right, sinceMs: input.nowMs };
        if (this.params.entrySwitchConfirmMs === 0) {
          this.selectedEntryRight = rawBest.right;
          this.entryChallenger = undefined;
        }
      } else if (input.nowMs - this.entryChallenger.sinceMs >= this.params.entrySwitchConfirmMs) {
        this.selectedEntryRight = rawBest.right;
        this.entryChallenger = undefined;
      }
    }

    const preferred = this.selectedEntryRight;
    candidates.sort((left, right) => {
      if (left.right === preferred && right.right !== preferred) return -1;
      if (right.right === preferred && left.right !== preferred) return 1;
      return this.compareEntryCandidates(left, right, input);
    });
  }

  private entryCandidateScore(candidate: { row?: OptionChainRow }): number {
    const row = candidate.row;
    if (row === undefined || row.bidPaise <= 0 || row.askPaise <= 0) return -Infinity;
    const mid = (row.bidPaise + row.askPaise) / 2;
    const spreadPct = (row.askPaise - row.bidPaise) / mid;
    const depth = row.bidQty + row.askQty;
    const imbalance = depth > 0 ? (row.bidQty - row.askQty) / depth : 0;
    return imbalance - spreadPct * 10;
  }

  private representativeSpread(input: MmQuoteInput): number | undefined {
    const row = input.atmCe ?? input.atmPe;
    if (row === undefined || row.bidPaise <= 0 || row.askPaise <= 0) return undefined;
    return this.minSpreadPct((row.bidPaise + row.askPaise) / 2);
  }
}

function sellLots(
  instrumentId: InstrumentId,
  lots: readonly MmLotInput[],
  pricePaise: number,
  reason: MmDesiredReason,
): MmDesiredOrder {
  return {
    instrumentId,
    side: 'SELL',
    qty: lots.reduce((sum, lot) => sum + lot.qty, 0),
    type: 'LIMIT',
    limitPricePaise: pricePaise,
    purpose: 'EXIT',
    reason,
    closeLotIds: lots.map((lot) => lot.lotId),
  };
}

function floorTick(pricePaise: number, tick: number): number {
  return Math.floor(pricePaise / tick) * tick;
}

function ceilTick(pricePaise: number, tick: number): number {
  return Math.ceil(pricePaise / tick) * tick;
}
