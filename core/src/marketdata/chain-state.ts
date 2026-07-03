import type { InstrumentId } from '../domain/ids.js';
import type { Instrument, OptionRight } from '../domain/instrument.js';
import type { OptionChainRow, Tick } from '../domain/marketdata.js';
import { AtmTracker } from './atm-tracker.js';
import { black76Greeks, impliedVolBlack76 } from './black76.js';

export interface ChainStateOptions {
  instruments: Instrument[];
  strikeStepPaise: number;
  depth?: number;
  atmHysteresisRatio?: number;
}

export interface AnalyticsContext {
  forwardPaise: number;
  timeToExpiryYears: number;
  riskFreeRate?: number;
}

interface OptionMeta {
  instrumentId: InstrumentId;
  strikePaise: number;
  right: OptionRight;
  expiry: string;
}

function emptyRow(meta: OptionMeta): OptionChainRow {
  return {
    instrumentId: meta.instrumentId,
    strikePaise: meta.strikePaise,
    right: meta.right,
    expiry: meta.expiry,
    ltpPaise: 0,
    bidPaise: 0,
    askPaise: 0,
    bidQty: 0,
    askQty: 0,
    volume: 0,
    oi: 0,
    updatedTs: 0,
  };
}

export class OptionChainState {
  private readonly metaByInstrument = new Map<InstrumentId, OptionMeta>();
  private readonly rows = new Map<InstrumentId, OptionChainRow>();
  private readonly atm: AtmTracker;
  private readonly depth: number;

  constructor(opts: ChainStateOptions) {
    this.depth = opts.depth ?? 5;
    this.atm = new AtmTracker({
      strikeStepPaise: opts.strikeStepPaise,
      ...(opts.atmHysteresisRatio !== undefined ? { hysteresisRatio: opts.atmHysteresisRatio } : {}),
    });

    for (const instr of opts.instruments) {
      if (instr.kind !== 'OPTION') continue;
      if (instr.strikePaise === undefined || instr.right === undefined || instr.expiry === undefined) continue;
      const meta: OptionMeta = {
        instrumentId: instr.id,
        strikePaise: instr.strikePaise,
        right: instr.right,
        expiry: instr.expiry,
      };
      this.metaByInstrument.set(instr.id, meta);
      this.rows.set(instr.id, emptyRow(meta));
    }
  }

  updateSpot(spotPaise: number): ReturnType<AtmTracker['update']> {
    return this.atm.update(spotPaise);
  }

  updateTick(tick: Tick): OptionChainRow | undefined {
    const meta = this.metaByInstrument.get(tick.instrumentId);
    if (meta === undefined) return undefined;
    const prev = this.rows.get(tick.instrumentId) ?? emptyRow(meta);
    const next: OptionChainRow = {
      ...prev,
      ltpPaise: tick.ltpPaise,
      bidPaise: tick.bidPaise,
      askPaise: tick.askPaise,
      bidQty: tick.bidQty,
      askQty: tick.askQty,
      volume: tick.volume,
      oi: tick.oi ?? prev.oi,
      updatedTs: tick.ts,
    };
    this.rows.set(tick.instrumentId, next);
    return next;
  }

  applyAnalytics(ctx: AnalyticsContext): void {
    const forward = ctx.forwardPaise / 100;
    for (const row of this.rows.values()) {
      const pricePaise = row.ltpPaise > 0
        ? row.ltpPaise
        : row.bidPaise > 0 && row.askPaise > 0
          ? (row.bidPaise + row.askPaise) / 2
          : 0;
      if (pricePaise <= 0 || ctx.timeToExpiryYears <= 0 || ctx.forwardPaise <= 0) continue;
      const strike = row.strikePaise / 100;
      const marketPrice = pricePaise / 100;
      const iv = impliedVolBlack76(
        row.right,
        marketPrice,
        forward,
        strike,
        ctx.timeToExpiryYears,
        ctx.riskFreeRate !== undefined ? { riskFreeRate: ctx.riskFreeRate } : {},
      );
      const greeks = black76Greeks({
        right: row.right,
        forward,
        strike,
        timeToExpiryYears: ctx.timeToExpiryYears,
        volatility: iv,
        ...(ctx.riskFreeRate !== undefined ? { riskFreeRate: ctx.riskFreeRate } : {}),
      });
      this.rows.set(row.instrumentId, {
        ...row,
        iv,
        delta: greeks.delta,
        gamma: greeks.gamma,
        theta: greeks.theta,
        vega: greeks.vega,
      });
    }
  }

  row(instrumentId: InstrumentId): OptionChainRow | undefined {
    return this.rows.get(instrumentId);
  }

  allRows(): OptionChainRow[] {
    return Array.from(this.rows.values()).sort((a, b) => a.strikePaise - b.strikePaise || a.right.localeCompare(b.right));
  }

  visibleRows(): OptionChainRow[] {
    const atm = this.atm.currentAtm();
    if (atm === undefined) return this.allRows();
    const strikes = Array.from(new Set(this.allRows().map((r) => r.strikePaise))).sort((a, b) => a - b);
    let atmIdx = 0;
    let best = Infinity;
    for (let i = 0; i < strikes.length; i++) {
      const d = Math.abs((strikes[i] as number) - atm);
      if (d < best) {
        best = d;
        atmIdx = i;
      }
    }
    const allowed = new Set(strikes.slice(Math.max(0, atmIdx - this.depth), Math.min(strikes.length, atmIdx + this.depth + 1)));
    return this.allRows().filter((r) => allowed.has(r.strikePaise));
  }
}
