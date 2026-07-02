import Database from 'better-sqlite3';
import type { SessionId } from '../domain/ids.js';
import type { Order } from '../domain/orders.js';
import type { Position, Trade } from '../domain/positions.js';
import type { SessionPhase, SessionState } from '../domain/session.js';

export interface TableCounts {
  sessions: number;
  configHashes: number;
  orders: number;
  orderEvents: number;
  positions: number;
  trades: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  date TEXT NOT NULL,
  phase TEXT NOT NULL,
  started_ts INTEGER NOT NULL,
  closed_ts INTEGER
);
CREATE TABLE IF NOT EXISTS config_hashes (
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (session_id, name)
);
CREATE TABLE IF NOT EXISTS orders (
  client_order_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER NOT NULL,
  filled_qty INTEGER NOT NULL,
  avg_fill_price_paise INTEGER NOT NULL,
  type TEXT NOT NULL,
  limit_price_paise INTEGER,
  trigger_price_paise INTEGER,
  state TEXT NOT NULL,
  purpose TEXT NOT NULL,
  tag TEXT NOT NULL,
  broker_order_id TEXT,
  reject_reason TEXT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE TABLE IF NOT EXISTS order_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  client_order_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(client_order_id);
CREATE TABLE IF NOT EXISTS positions (
  position_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER NOT NULL,
  avg_entry_price_paise INTEGER NOT NULL,
  state TEXT NOT NULL,
  realized_gross_paise INTEGER NOT NULL,
  opened_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_session ON positions(session_id);
CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  entry_ts INTEGER NOT NULL,
  entry_price_paise INTEGER NOT NULL,
  exit_ts INTEGER NOT NULL,
  exit_price_paise INTEGER NOT NULL,
  gross_pnl_paise INTEGER NOT NULL,
  charges_paise INTEGER NOT NULL,
  charges_json TEXT NOT NULL,
  net_pnl_paise INTEGER NOT NULL,
  exit_reason TEXT NOT NULL,
  hold_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id);
`;

/**
 * SQLite mirror of the journal for querying/reporting. The journal remains
 * the source of truth; this database can always be rebuilt from it.
 */
export class Persistence {
  private readonly db: Database.Database;
  private readonly stmts: Record<string, Database.Statement>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this.stmts = {
      upsertSession: this.db.prepare(`
        INSERT INTO sessions (session_id, mode, date, phase, started_ts, closed_ts)
        VALUES (@sessionId, @mode, @date, @phase, @startedTs, @closedTs)
        ON CONFLICT(session_id) DO UPDATE SET
          mode = excluded.mode, date = excluded.date, phase = excluded.phase,
          started_ts = excluded.started_ts, closed_ts = excluded.closed_ts`),
      setSessionPhase: this.db.prepare(
        'UPDATE sessions SET phase = @phase WHERE session_id = @sessionId',
      ),
      closeSession: this.db.prepare(
        "UPDATE sessions SET phase = 'CLOSED', closed_ts = @closedTs WHERE session_id = @sessionId",
      ),
      recordConfigHash: this.db.prepare(`
        INSERT INTO config_hashes (session_id, name, hash, path)
        VALUES (@sessionId, @name, @hash, @path)
        ON CONFLICT(session_id, name) DO UPDATE SET hash = excluded.hash, path = excluded.path`),
      upsertOrder: this.db.prepare(`
        INSERT INTO orders (
          client_order_id, session_id, intent_id, instrument_id, side, qty,
          filled_qty, avg_fill_price_paise, type, limit_price_paise,
          trigger_price_paise, state, purpose, tag, broker_order_id,
          reject_reason, created_ts, updated_ts
        ) VALUES (
          @clientOrderId, @sessionId, @intentId, @instrumentId, @side, @qty,
          @filledQty, @avgFillPricePaise, @type, @limitPricePaise,
          @triggerPricePaise, @state, @purpose, @tag, @brokerOrderId,
          @rejectReason, @createdTs, @updatedTs
        )
        ON CONFLICT(client_order_id) DO UPDATE SET
          filled_qty = excluded.filled_qty,
          avg_fill_price_paise = excluded.avg_fill_price_paise,
          state = excluded.state,
          broker_order_id = excluded.broker_order_id,
          reject_reason = excluded.reject_reason,
          updated_ts = excluded.updated_ts`),
      insertOrderEvent: this.db.prepare(`
        INSERT INTO order_events (session_id, seq, client_order_id, ts, kind, detail)
        VALUES (@sessionId, @seq, @clientOrderId, @ts, @kind, @detail)`),
      upsertPosition: this.db.prepare(`
        INSERT INTO positions (
          position_id, session_id, strategy_id, instrument_id, side, qty,
          avg_entry_price_paise, state, realized_gross_paise, opened_ts, updated_ts
        ) VALUES (
          @positionId, @sessionId, @strategyId, @instrumentId, @side, @qty,
          @avgEntryPricePaise, @state, @realizedGrossPaise, @openedTs, @updatedTs
        )
        ON CONFLICT(position_id) DO UPDATE SET
          qty = excluded.qty,
          avg_entry_price_paise = excluded.avg_entry_price_paise,
          state = excluded.state,
          realized_gross_paise = excluded.realized_gross_paise,
          updated_ts = excluded.updated_ts`),
      markPositionClosed: this.db.prepare(
        "UPDATE positions SET state = 'CLOSED' WHERE position_id = @positionId",
      ),
      insertTrade: this.db.prepare(`
        INSERT INTO trades (
          trade_id, session_id, strategy_id, instrument_id, qty,
          entry_ts, entry_price_paise, exit_ts, exit_price_paise,
          gross_pnl_paise, charges_paise, charges_json, net_pnl_paise,
          exit_reason, hold_ms
        ) VALUES (
          @tradeId, @sessionId, @strategyId, @instrumentId, @qty,
          @entryTs, @entryPricePaise, @exitTs, @exitPricePaise,
          @grossPnlPaise, @chargesPaise, @chargesJson, @netPnlPaise,
          @exitReason, @holdMs
        )`),
    } as Record<string, Database.Statement>;
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  journalMode(): string {
    return this.db.pragma('journal_mode', { simple: true }) as string;
  }

  upsertSession(s: SessionState, closedTs?: number): void {
    this.stmts.upsertSession!.run({
      sessionId: s.sessionId,
      mode: s.mode,
      date: s.date,
      phase: s.phase,
      startedTs: s.startedTs,
      closedTs: closedTs ?? null,
    });
  }

  setSessionPhase(sessionId: SessionId, phase: SessionPhase): void {
    this.stmts.setSessionPhase!.run({ sessionId, phase });
  }

  closeSession(sessionId: SessionId, closedTs: number): void {
    this.stmts.closeSession!.run({ sessionId, closedTs });
  }

  recordConfigHash(sessionId: SessionId, name: string, hash: string, path: string): void {
    this.stmts.recordConfigHash!.run({ sessionId, name, hash, path });
  }

  upsertOrder(o: Order): void {
    this.stmts.upsertOrder!.run({
      clientOrderId: o.clientOrderId,
      sessionId: o.sessionId,
      intentId: o.intentId,
      instrumentId: o.instrumentId,
      side: o.side,
      qty: o.qty,
      filledQty: o.filledQty,
      avgFillPricePaise: o.avgFillPricePaise,
      type: o.type,
      limitPricePaise: o.limitPricePaise ?? null,
      triggerPricePaise: o.triggerPricePaise ?? null,
      state: o.state,
      purpose: o.purpose,
      tag: o.tag,
      brokerOrderId: o.brokerOrderId ?? null,
      rejectReason: o.rejectReason ?? null,
      createdTs: o.createdTs,
      updatedTs: o.updatedTs,
    });
  }

  insertOrderEvent(
    sessionId: SessionId,
    seq: number,
    clientOrderId: string,
    ts: number,
    kind: string,
    detail: string,
  ): void {
    this.stmts.insertOrderEvent!.run({ sessionId, seq, clientOrderId, ts, kind, detail });
  }

  upsertPosition(p: Position): void {
    this.stmts.upsertPosition!.run({
      positionId: p.positionId,
      sessionId: p.sessionId,
      strategyId: p.strategyId,
      instrumentId: p.instrumentId,
      side: p.side,
      qty: p.qty,
      avgEntryPricePaise: p.avgEntryPricePaise,
      state: p.state,
      realizedGrossPaise: p.realizedGrossPaise,
      openedTs: p.openedTs,
      updatedTs: p.updatedTs,
    });
  }

  markPositionClosed(positionId: string): void {
    this.stmts.markPositionClosed!.run({ positionId });
  }

  insertTrade(t: Trade): void {
    this.stmts.insertTrade!.run({
      tradeId: t.tradeId,
      sessionId: t.sessionId,
      strategyId: t.strategyId,
      instrumentId: t.instrumentId,
      qty: t.qty,
      entryTs: t.entry.ts,
      entryPricePaise: t.entry.pricePaise,
      exitTs: t.exit.ts,
      exitPricePaise: t.exit.pricePaise,
      grossPnlPaise: t.grossPnlPaise,
      chargesPaise: t.charges.totalPaise,
      chargesJson: JSON.stringify(t.charges),
      netPnlPaise: t.netPnlPaise,
      exitReason: t.exitReason,
      holdMs: t.holdMs,
    });
  }

  getOrderState(clientOrderId: string): string | undefined {
    const row = this.db
      .prepare('SELECT state FROM orders WHERE client_order_id = ?')
      .get(clientOrderId) as { state: string } | undefined;
    return row?.state;
  }

  getTradeNet(tradeId: string): number | undefined {
    const row = this.db
      .prepare('SELECT net_pnl_paise AS net FROM trades WHERE trade_id = ?')
      .get(tradeId) as { net: number } | undefined;
    return row?.net;
  }

  counts(sessionId: SessionId): TableCounts {
    const one = (sql: string): number =>
      (this.db.prepare(sql).get(sessionId) as { n: number }).n;
    return {
      sessions: one('SELECT COUNT(*) n FROM sessions WHERE session_id = ?'),
      configHashes: one('SELECT COUNT(*) n FROM config_hashes WHERE session_id = ?'),
      orders: one('SELECT COUNT(*) n FROM orders WHERE session_id = ?'),
      orderEvents: one('SELECT COUNT(*) n FROM order_events WHERE session_id = ?'),
      positions: one('SELECT COUNT(*) n FROM positions WHERE session_id = ?'),
      trades: one('SELECT COUNT(*) n FROM trades WHERE session_id = ?'),
    };
  }

  close(): void {
    this.db.close();
  }
}
