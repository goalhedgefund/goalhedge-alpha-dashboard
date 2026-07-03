import type { MarketProfile } from '../config/schemas.js';
import { computeCharges, computeTradeNet } from '../charges/engine.js';
import type { ClientOrderId, InstrumentId, SessionId, TradeId } from '../domain/ids.js';
import type { Fill, Order } from '../domain/orders.js';
import type { Position, Trade, TradeLeg } from '../domain/positions.js';
import { IdFactory } from '../domain/ids.js';

interface OpenLot {
  qty: number;
  pricePaise: number;
  ts: number;
  clientOrderId: ClientOrderId;
}

interface PositionBook {
  position: Position;
  lots: OpenLot[];
}

export class PositionKeeper {
  private readonly books = new Map<InstrumentId, PositionBook>();
  private readonly ids: IdFactory;

  constructor(
    private readonly sessionId: SessionId,
    private readonly marketProfile: MarketProfile,
    ids?: IdFactory,
  ) {
    this.ids = ids ?? new IdFactory(sessionId);
  }

  onFill(order: Order, fill: Fill): { positions: Position[]; trades: Trade[] } {
    if (order.side === 'BUY') return { positions: [this.applyBuy(order, fill)], trades: [] };
    return this.applySell(order, fill);
  }

  getPositions(): Position[] {
    return Array.from(this.books.values()).map((b) => b.position);
  }

  private applyBuy(order: Order, fill: Fill): Position {
    const existing = this.books.get(order.instrumentId);
    const openedTs = existing?.position.openedTs ?? fill.ts;
    const positionId = existing?.position.positionId ?? this.ids.positionId();
    const lots = [...(existing?.lots ?? []), { qty: fill.qty, pricePaise: fill.pricePaise, ts: fill.ts, clientOrderId: fill.clientOrderId }];
    const qty = lots.reduce((s, l) => s + l.qty, 0);
    const avgEntryPricePaise = Math.round(lots.reduce((s, l) => s + l.qty * l.pricePaise, 0) / qty);
    const position: Position = {
      positionId,
      sessionId: this.sessionId,
      strategyId: order.tag.split(':')[0] ?? order.tag,
      instrumentId: order.instrumentId,
      side: 'BUY',
      qty,
      avgEntryPricePaise,
      state: 'OPEN',
      realizedGrossPaise: existing?.position.realizedGrossPaise ?? 0,
      openedTs,
      updatedTs: fill.ts,
    };
    this.books.set(order.instrumentId, { position, lots });
    return position;
  }

  private applySell(order: Order, fill: Fill): { positions: Position[]; trades: Trade[] } {
    const book = this.books.get(order.instrumentId);
    if (book === undefined) return { positions: [], trades: [] };
    let remaining = fill.qty;
    const trades: Trade[] = [];
    const lots = [...book.lots];
    let realized = book.position.realizedGrossPaise;

    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0] as OpenLot;
      const qty = Math.min(remaining, lot.qty);
      const gross = (fill.pricePaise - lot.pricePaise) * qty;
      const entry: TradeLeg = {
        side: 'BUY',
        qty,
        pricePaise: lot.pricePaise,
        ts: lot.ts,
        clientOrderId: lot.clientOrderId,
      };
      const exit: TradeLeg = {
        side: 'SELL',
        qty,
        pricePaise: fill.pricePaise,
        ts: fill.ts,
        clientOrderId: fill.clientOrderId,
      };
      const charges = computeCharges(
        [
          { side: 'BUY', qty, pricePaise: lot.pricePaise, orderId: lot.clientOrderId },
          { side: 'SELL', qty, pricePaise: fill.pricePaise, orderId: fill.clientOrderId },
        ],
        this.marketProfile,
      );
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
        exitReason: order.purpose,
        holdMs: fill.ts - lot.ts,
      };
      trades.push(trade);
      realized += gross;
      lot.qty -= qty;
      remaining -= qty;
      if (lot.qty === 0) lots.shift();
    }

    const qtyOpen = lots.reduce((s, l) => s + l.qty, 0);
    const next: Position = {
      ...book.position,
      qty: qtyOpen,
      avgEntryPricePaise: qtyOpen > 0 ? Math.round(lots.reduce((s, l) => s + l.qty * l.pricePaise, 0) / qtyOpen) : book.position.avgEntryPricePaise,
      state: qtyOpen > 0 ? 'OPEN' : 'CLOSED',
      realizedGrossPaise: realized,
      updatedTs: fill.ts,
    };
    if (qtyOpen === 0) this.books.delete(order.instrumentId);
    else this.books.set(order.instrumentId, { position: next, lots });
    return { positions: [next], trades };
  }
}
