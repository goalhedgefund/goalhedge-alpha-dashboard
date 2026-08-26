import type { MarketProfile } from '../config/schemas.js';
import { computeCharges, computeTradeNet } from '../charges/engine.js';
import type { ClientOrderId, InstrumentId, SessionId, TradeId } from '../domain/ids.js';
import type { OptionRight } from '../domain/instrument.js';
import type { Fill, Order, Side } from '../domain/orders.js';
import type { Position, Trade, TradeLeg } from '../domain/positions.js';
import { IdFactory } from '../domain/ids.js';

/** Resolves option contract labels at trade time (strike/right survive expiry rolls). */
export type InstrumentInfoFn = (id: InstrumentId) => { strikePaise: number; right: OptionRight } | undefined;

export interface OpenPositionLot {
  /** Fill id is unique within the session and survives partial entry fills. */
  lotId: string;
  instrumentId: InstrumentId;
  qty: number;
  pricePaise: number;
  ts: number;
  clientOrderId: ClientOrderId;
  /** Omitted for legacy long lots; SELL identifies a short-entry fill. */
  entrySide?: Side;
}

interface PositionBook {
  position: Position;
  lots: OpenPositionLot[];
}

export interface PositionKeeperUpdate {
  positions: Position[];
  trades: Trade[];
  allocationError?: string;
}

export class PositionKeeper {
  private readonly books = new Map<InstrumentId, PositionBook>();
  private readonly ids: IdFactory;

  constructor(
    private readonly sessionId: SessionId,
    private readonly marketProfile: MarketProfile,
    ids?: IdFactory,
    private readonly instrumentInfo?: InstrumentInfoFn,
  ) {
    this.ids = ids ?? new IdFactory(sessionId);
  }

  onFill(order: Order, fill: Fill): PositionKeeperUpdate {
    if (order.purpose === 'ENTRY') return this.applyEntry(order, fill);
    return this.applyExit(order, fill);
  }

  getPositions(): Position[] {
    return Array.from(this.books.values()).map((b) => b.position);
  }

  getOpenLots(instrumentId?: InstrumentId): OpenPositionLot[] {
    const books = instrumentId === undefined
      ? Array.from(this.books.values())
      : [this.books.get(instrumentId)].filter((b): b is PositionBook => b !== undefined);
    return books.flatMap((book) => book.lots.map((lot) => ({ ...lot })));
  }

  private applyEntry(order: Order, fill: Fill): PositionKeeperUpdate {
    const existing = this.books.get(order.instrumentId);
    if (existing !== undefined && existing.position.side !== order.side) {
      return {
        positions: [],
        trades: [],
        allocationError: `entry fill ${fill.fillId} side ${order.side} conflicts with ${existing.position.side} book`,
      };
    }
    const openedTs = existing?.position.openedTs ?? fill.ts;
    const positionId = existing?.position.positionId ?? this.ids.positionId();
    const lots = [
      ...(existing?.lots ?? []),
      {
        lotId: fill.fillId,
        instrumentId: order.instrumentId,
        qty: fill.qty,
        pricePaise: fill.pricePaise,
        ts: fill.ts,
        clientOrderId: fill.clientOrderId,
        ...(order.side === 'SELL' ? { entrySide: 'SELL' as const } : {}),
      },
    ];
    const qty = lots.reduce((s, l) => s + l.qty, 0);
    const avgEntryPricePaise = Math.round(lots.reduce((s, l) => s + l.qty * l.pricePaise, 0) / qty);
    const position: Position = {
      positionId,
      sessionId: this.sessionId,
      strategyId: order.tag.split(':')[0] ?? order.tag,
      instrumentId: order.instrumentId,
      side: order.side,
      qty,
      avgEntryPricePaise,
      state: 'OPEN',
      realizedGrossPaise: existing?.position.realizedGrossPaise ?? 0,
      openedTs,
      updatedTs: fill.ts,
    };
    this.books.set(order.instrumentId, { position, lots });
    return { positions: [position], trades: [] };
  }

  private applyExit(order: Order, fill: Fill): PositionKeeperUpdate {
    const book = this.books.get(order.instrumentId);
    if (book === undefined) {
      return {
        positions: [],
        trades: [],
        ...(order.closeLotIds !== undefined
          ? { allocationError: `targeted fill ${fill.fillId} has no open book for ${String(order.instrumentId)}` }
          : {}),
      };
    }
    const expectedExitSide: Side = book.position.side === 'BUY' ? 'SELL' : 'BUY';
    if (order.side !== expectedExitSide) {
      return {
        positions: [],
        trades: [],
        allocationError: `exit fill ${fill.fillId} side ${order.side} cannot close ${book.position.side} book`,
      };
    }
    let remaining = fill.qty;
    const trades: Trade[] = [];
    const lots = book.lots.map((lot) => ({ ...lot }));
    const selected = order.closeLotIds === undefined
      ? lots
      : order.closeLotIds.flatMap((lotId) => lots.filter((lot) => lot.lotId === lotId));
    let realized = book.position.realizedGrossPaise;

    while (remaining > 0 && selected.length > 0) {
      const lot = selected.shift() as OpenPositionLot;
      if (lot.qty <= 0) continue;
      const qty = Math.min(remaining, lot.qty);
      const entrySide = lot.entrySide ?? book.position.side;
      const gross = entrySide === 'BUY'
        ? (fill.pricePaise - lot.pricePaise) * qty
        : (lot.pricePaise - fill.pricePaise) * qty;
      const entry: TradeLeg = {
        side: entrySide,
        qty,
        pricePaise: lot.pricePaise,
        ts: lot.ts,
        clientOrderId: lot.clientOrderId,
      };
      const exit: TradeLeg = {
        side: order.side,
        qty,
        pricePaise: fill.pricePaise,
        ts: fill.ts,
        clientOrderId: fill.clientOrderId,
      };
      const charges = computeCharges(
        [
          { side: entrySide, qty, pricePaise: lot.pricePaise, orderId: lot.clientOrderId },
          { side: order.side, qty, pricePaise: fill.pricePaise, orderId: fill.clientOrderId },
        ],
        this.marketProfile,
      );
      const info = this.instrumentInfo?.(order.instrumentId);
      const tagParts = order.tag.split(':');
      const exitReason = (tagParts[1] === 'stop' ? tagParts[2] : tagParts[1])?.toUpperCase() ?? order.purpose;
      const trade: Trade = {
        tradeId: this.ids.tradeId() as TradeId,
        sessionId: this.sessionId,
        strategyId: order.tag.split(':')[0] ?? order.tag,
        instrumentId: order.instrumentId,
        qty,
        entry,
        exit,
        grossPnlPaise: gross,
        charges,
        netPnlPaise: computeTradeNet(gross, charges),
        exitReason,
        holdMs: fill.ts - lot.ts,
        ...(info !== undefined ? { strikePaise: info.strikePaise, right: info.right } : {}),
      };
      trades.push(trade);
      realized += gross;
      lot.qty -= qty;
      remaining -= qty;
    }

    const openLots = lots.filter((lot) => lot.qty > 0);
    const qtyOpen = openLots.reduce((s, l) => s + l.qty, 0);
    const next: Position = {
      ...book.position,
      qty: qtyOpen,
      avgEntryPricePaise: qtyOpen > 0 ? Math.round(openLots.reduce((s, l) => s + l.qty * l.pricePaise, 0) / qtyOpen) : book.position.avgEntryPricePaise,
      state: qtyOpen > 0 ? 'OPEN' : 'CLOSED',
      realizedGrossPaise: realized,
      openedTs: qtyOpen > 0 ? Math.min(...openLots.map((lot) => lot.ts)) : book.position.openedTs,
      updatedTs: fill.ts,
    };
    if (qtyOpen === 0) this.books.delete(order.instrumentId);
    else this.books.set(order.instrumentId, { position: next, lots: openLots });
    return {
      positions: [next],
      trades,
      ...(order.closeLotIds !== undefined && remaining > 0
        ? {
            allocationError: `targeted fill ${fill.fillId} exceeded named lots by ${remaining} units ` +
              `(order ${String(order.clientOrderId)}; lots ${order.closeLotIds.join(',')})`,
          }
        : {}),
    };
  }
}
