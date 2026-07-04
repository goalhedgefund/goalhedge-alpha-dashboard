import type { MarketProfile } from '../config/schemas.js';
import type { JournalEventType, JournalPayloads } from '../domain/events.js';
import type { ClientOrderId, IdFactory, InstrumentId } from '../domain/ids.js';
import type { Order, OrderIntent } from '../domain/orders.js';
import type { RiskVerdict } from '../domain/risk.js';
import { systemClock, type Clock } from '../domain/time.js';
import type { SubmitResult } from './oms.js';
import type { RiskGate, RiskGateContext } from '../risk/risk-gate.js';

type JournalSink = <K extends JournalEventType>(type: K, payload: JournalPayloads[K]) => void;

export interface EscalatorOmsPort {
  getOrder(clientOrderId: ClientOrderId): Order | undefined;
  cancel(clientOrderId: ClientOrderId): Promise<void>;
  submit(intent: OrderIntent, verdict: RiskVerdict): Promise<SubmitResult>;
}

export interface ExitEscalatorOptions {
  oms: EscalatorOmsPort;
  gate: RiskGate;
  gateContext: () => RiskGateContext;
  ids: IdFactory;
  market: MarketProfile;
  markPrice: (instrumentId: InstrumentId) => number | undefined;
  clock?: Clock;
  journal?: JournalSink;
  /** Per-stage patience before escalating (PROTECT→REPRICE, REPRICE→MARKET). */
  stageTimeoutMs?: number;
  /** How many ticks worse the REPRICE stage bids. */
  repriceTicks?: number;
}

type Stage = 'PROTECT' | 'REPRICE' | 'MARKET';

interface TrackedExit {
  clientOrderId: ClientOrderId;
  intent: OrderIntent;
  stage: Stage;
  stageStartMs: number;
}

/**
 * Exit escalation ladder (01-DESIGN §4): a stop/square-off/kill exit that
 * does not fill within stageTimeoutMs is cancelled and chased —
 * PROTECT-limit → worse REPRICE limit → pure MARKET. Only the REMAINING
 * quantity is chased after partial fills, and a fill that lands during the
 * cancel race is detected before resubmitting (no oversell).
 *
 * Entries are never escalated — chasing an entry is how scalpers bleed;
 * chasing an exit is how they survive.
 */
export class ExitEscalator {
  private readonly tracked = new Map<ClientOrderId, TrackedExit>();
  private readonly clock: Clock;
  private readonly stageTimeoutMs: number;
  private readonly repriceTicks: number;
  private polling = false;

  constructor(private readonly opts: ExitEscalatorOptions) {
    this.clock = opts.clock ?? systemClock;
    this.stageTimeoutMs = opts.stageTimeoutMs ?? 750;
    this.repriceTicks = opts.repriceTicks ?? 10;
  }

  /** Track a submitted exit order. Entries are ignored by design. */
  track(order: Order, intent: OrderIntent): void {
    if (intent.purpose === 'ENTRY') return;
    this.tracked.set(order.clientOrderId, {
      clientOrderId: order.clientOrderId,
      intent,
      stage: intent.type === 'MARKET_PROTECT' ? 'MARKET' : 'PROTECT',
      stageStartMs: this.clock.now(),
    });
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  /** Drive the ladder; call on the timer cadence. Re-entrant safe. */
  async poll(nowMs = this.clock.now()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const t of [...this.tracked.values()]) {
        await this.check(t, nowMs);
      }
    } finally {
      this.polling = false;
    }
  }

  private async check(t: TrackedExit, nowMs: number): Promise<void> {
    const order = this.opts.oms.getOrder(t.clientOrderId);
    if (order === undefined) {
      this.tracked.delete(t.clientOrderId);
      return;
    }
    if (order.state === 'FILLED') {
      this.tracked.delete(t.clientOrderId);
      return;
    }

    const terminalUnfilled =
      order.state === 'REJECTED' || order.state === 'CANCELLED' || order.state === 'EXPIRED';
    const expired = nowMs - t.stageStartMs >= this.stageTimeoutMs;
    if (!terminalUnfilled && !expired) return;

    if (t.stage === 'MARKET') {
      // Nothing worse than market exists. A dead market order is an
      // emergency for the reconciler/kill switch, not this ladder.
      if (terminalUnfilled) {
        this.tracked.delete(t.clientOrderId);
        this.opts.journal?.('diag.error', {
          where: 'escalation.market',
          message: `market exit ${order.clientOrderId} ended ${order.state} unfilled`,
        });
      }
      return;
    }

    // Cancel (unless already terminal), then re-read: a fill may have landed
    // during the race — never chase quantity that no longer exists.
    if (!terminalUnfilled) {
      try {
        await this.opts.oms.cancel(order.clientOrderId);
      } catch {
        /* cancel best-effort; re-read decides */
      }
    }
    const fresh = this.opts.oms.getOrder(t.clientOrderId) ?? order;
    this.tracked.delete(t.clientOrderId);
    const remaining = fresh.qty - fresh.filledQty;
    if (fresh.state === 'FILLED' || remaining <= 0) return;

    const nextStage: Stage = t.stage === 'PROTECT' ? 'REPRICE' : 'MARKET';
    const intent = this.nextIntent(t.intent, nextStage, remaining, nowMs);
    this.opts.journal?.('exit.escalated', {
      clientOrderId: fresh.clientOrderId,
      stage: nextStage,
      remainingQty: remaining,
      newIntentId: intent.intentId,
    });
    this.opts.journal?.('intent.proposed', { intent });
    const verdict = this.opts.gate.evaluate(intent, this.opts.gateContext());
    this.opts.journal?.('risk.verdict', { verdict });
    if (!verdict.approved) {
      this.opts.journal?.('diag.error', {
        where: 'escalation.gate',
        message: `gate rejected escalated exit: ${verdict.reason ?? 'unknown'}`,
      });
      return;
    }
    const result = await this.opts.oms.submit(intent, verdict);
    if (result.accepted) {
      this.tracked.set(result.order.clientOrderId, {
        clientOrderId: result.order.clientOrderId,
        intent,
        stage: nextStage,
        stageStartMs: nowMs,
      });
    }
  }

  private nextIntent(prev: OrderIntent, stage: Stage, remainingQty: number, nowMs: number): OrderIntent {
    const base: Omit<OrderIntent, 'type' | 'limitPricePaise'> = {
      intentId: this.opts.ids.intentId(),
      sessionId: prev.sessionId,
      strategyId: prev.strategyId,
      ts: nowMs,
      side: prev.side,
      instrumentId: prev.instrumentId,
      qty: remainingQty,
      ttlMs: 2_000,
      tag: `${prev.tag}:esc-${stage.toLowerCase()}`,
      purpose: prev.purpose,
      ...(prev.protectTicks !== undefined ? { protectTicks: prev.protectTicks } : {}),
    };
    if (stage === 'MARKET') {
      return { ...base, type: 'MARKET_PROTECT' };
    }
    const tick = this.opts.market.tickSizePaise;
    const mark = this.opts.markPrice(prev.instrumentId);
    const anchor = mark !== undefined && mark > 0 ? mark : prev.limitPricePaise ?? tick;
    const worse = Math.max(tick, anchor - this.repriceTicks * tick);
    return { ...base, type: 'LIMIT', limitPricePaise: worse };
  }
}
