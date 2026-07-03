/**
 * Mission-control panels (01-DESIGN §1.1). Dense, dark, zero component
 * libraries. Everything renders straight off GatewayState — the UI holds no
 * state of its own beyond transient command feedback.
 */
import { useRef, useState } from 'react';
import type { GatewayState } from '@proto';
import type { GatewayClient, ConnStatus, AckResult } from '../lib/gateway-client.js';
import { ageSec, istTime, pct, rupees, strike } from '../lib/format.js';

type Bar = GatewayState['bars'][number];
type JEvent = GatewayState['events'][number];

// ---------------------------------------------------------------- banner

export function ModeBanner({ state }: { state: GatewayState }): JSX.Element {
  const { session, algo } = state;
  return (
    <header className={`banner mode-${session.mode}`} data-testid="mode-banner">
      <span className="banner-mode">{session.mode.toUpperCase()}</span>
      <span className="banner-item">{session.date}</span>
      <span className="banner-item">phase {session.phase}</span>
      <span className="banner-item" data-testid="banner-lifecycle">
        {algo.lifecycle}
      </span>
      <span className="banner-strategy">{algo.strategyId}</span>
    </header>
  );
}

// ---------------------------------------------------------------- health

export function HealthHud({
  state,
  status,
  lastSeq,
}: {
  state: GatewayState;
  status: ConnStatus;
  lastSeq: number;
}): JSX.Element {
  const now = Date.now();
  const h = state.health;
  return (
    <section className="panel" data-testid="health-hud">
      <h2>HEALTH</h2>
      <div className="kv">
        <span>feed</span>
        <b className={`st-${h.feedStatus.toLowerCase()}`}>{h.feedStatus}</b>
        <span>last tick</span>
        <b>{ageSec(h.lastTickTs, now)}</b>
        <span>gateway ws</span>
        <b className={status === 'LIVE' ? 'st-connected' : 'st-stale'}>{status}</b>
        <span>seq</span>
        <b>{lastSeq}</b>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- risk

export function RiskMeters({ state }: { state: GatewayState }): JSX.Element {
  const { snapshot, limits } = state.risk;
  const lossUsed = Math.max(0, -snapshot.realizedNetPnlPaise);
  const lossFrac = Math.min(1, limits.dailyMaxLossPaise > 0 ? lossUsed / limits.dailyMaxLossPaise : 0);
  const tradesFrac = Math.min(1, snapshot.tradesTaken / Math.max(1, limits.maxTradesPerDay));
  return (
    <section className="panel" data-testid="risk-meters">
      <h2>
        RISK{' '}
        {snapshot.latchedStop !== undefined && (
          <span className="latched" data-testid="risk-latched">
            LATCHED: {snapshot.latchedStop}
          </span>
        )}
      </h2>
      <div className="meter-row">
        <span>day P&L</span>
        <b className={snapshot.realizedNetPnlPaise < 0 ? 'neg' : 'pos'}>
          {rupees(snapshot.realizedNetPnlPaise)}
        </b>
      </div>
      <div className="meter">
        <div className="meter-fill loss" style={{ width: `${lossFrac * 100}%` }} />
        <span className="meter-label">
          loss {rupees(lossUsed)} / {rupees(limits.dailyMaxLossPaise)}
        </span>
      </div>
      <div className="meter">
        <div className="meter-fill trades" style={{ width: `${tradesFrac * 100}%` }} />
        <span className="meter-label">
          trades {snapshot.tradesTaken} / {limits.maxTradesPerDay}
        </span>
      </div>
      <div className="kv">
        <span>peak</span>
        <b>{rupees(snapshot.peakNetPnlPaise)}</b>
        <span>loss streak</span>
        <b>{snapshot.lossStreak}</b>
        <span>per-trade cap</span>
        <b>{rupees(limits.perTradeRiskPaise)}</b>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- algo

export function AlgoPanel({ state, client }: { state: GatewayState; client: GatewayClient }): JSX.Element {
  const [ack, setAck] = useState('');
  const cmd = async (type: 'ARM' | 'DISARM'): Promise<void> => {
    const r = await client.command(type);
    setAck(`${type}: ${r.accepted ? 'ok' : 'rejected'}${r.reason !== undefined ? ` (${r.reason})` : ''}`);
  };
  const a = state.algo;
  return (
    <section className="panel" data-testid="algo-panel">
      <h2>ALGO</h2>
      <div className="kv">
        <span>strategy</span>
        <b>{a.strategyId}</b>
        <span>lifecycle</span>
        <b data-testid="algo-lifecycle">{a.lifecycle}</b>
        <span>why not trading</span>
        <b data-testid="no-trade-reason">{a.lastNoTradeReason ?? '—'}</b>
      </div>
      <div className="btn-row">
        <button data-testid="arm-btn" onClick={() => void cmd('ARM')}>
          ARM
        </button>
        <button data-testid="disarm-btn" className="warn" onClick={() => void cmd('DISARM')}>
          DISARM
        </button>
      </div>
      <div className="cmd-result" data-testid="cmd-result">
        {ack}
      </div>
      <details>
        <summary>params (read-only, apply when flat)</summary>
        <div className="kv small">
          {Object.entries(a.params).map(([k, v]) => (
            <span key={k} className="param">
              {k}=<b>{String(v)}</b>
            </span>
          ))}
        </div>
      </details>
    </section>
  );
}

// ---------------------------------------------------------------- kill

export function KillSwitch({ client }: { client: GatewayClient }): JSX.Element {
  const [holding, setHolding] = useState(false);
  const [result, setResult] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const start = (): void => {
    setHolding(true);
    timer.current = setTimeout(() => {
      void client.command('KILL').then((r: AckResult) => {
        setResult(r.accepted ? 'KILLED — TRADING LOCKED' : `REJECTED: ${r.reason ?? 'unknown'}`);
        setHolding(false);
      });
    }, 1_000);
  };
  const cancel = (): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    setHolding(false);
  };

  return (
    <section className="panel kill-panel">
      <button
        data-testid="kill-switch"
        className={holding ? 'kill-btn holding' : 'kill-btn'}
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
      >
        {holding ? 'HOLD TO KILL…' : 'KILL SWITCH'}
      </button>
      <div className="kill-result" data-testid="kill-result">
        {result}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- positions

export function PositionsPanel({ state }: { state: GatewayState }): JSX.Element {
  const open = state.positions.filter((p) => p.state !== 'CLOSED' && p.qty > 0);
  const lastMove = [...state.events].reverse().find((e) => e.type === 'stop.moved');
  return (
    <section className="panel" data-testid="positions-panel">
      <h2>POSITIONS &amp; STOPS</h2>
      {open.length === 0 ? (
        <div className="flat" data-testid="flat-badge">
          FLAT
        </div>
      ) : (
        open.map((p) => {
          const row = state.chain.find((r) => r.instrumentId === p.instrumentId);
          const ltp = row?.ltpPaise ?? 0;
          const unreal = ltp > 0 ? (ltp - p.avgEntryPricePaise) * p.qty : 0;
          const stop =
            lastMove !== undefined && lastMove.type === 'stop.moved' && lastMove.payload.positionId === p.positionId
              ? lastMove.payload.to
              : undefined;
          return (
            <div key={p.positionId} className="position" data-testid="open-position">
              <div className="kv">
                <span>instrument</span>
                <b>{p.instrumentId}</b>
                <span>qty</span>
                <b>{p.qty}</b>
                <span>entry</span>
                <b>{rupees(p.avgEntryPricePaise)}</b>
                <span>ltp</span>
                <b>{ltp > 0 ? rupees(ltp) : '—'}</b>
                <span>open P&L</span>
                <b className={unreal < 0 ? 'neg' : 'pos'}>{rupees(unreal)}</b>
              </div>
              <div className="stop-ladder">
                {stop !== undefined ? (
                  <>
                    <span className="ladder-layer">{stop.layer}</span>
                    <span>
                      stop <b>{rupees(stop.stopPremiumPaise)}</b>
                    </span>
                    <span>
                      hi-water <b>{rupees(stop.highWaterPremiumPaise)}</b>
                    </span>
                  </>
                ) : (
                  <span className="ladder-layer">HARD (initial)</span>
                )}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}

// ---------------------------------------------------------------- chain

export function ChainStrip({ state }: { state: GatewayState }): JSX.Element {
  const held = new Set(state.positions.filter((p) => p.state !== 'CLOSED').map((p) => p.instrumentId));
  return (
    <section className="panel" data-testid="chain-strip">
      <h2>CHAIN</h2>
      <table>
        <thead>
          <tr>
            <th>strike</th>
            <th>side</th>
            <th>bid</th>
            <th>ask</th>
            <th>ltp</th>
            <th>spr%</th>
            <th>oi</th>
          </tr>
        </thead>
        <tbody>
          {state.chain.map((r) => {
            const mid = r.bidPaise > 0 && r.askPaise > 0 ? (r.bidPaise + r.askPaise) / 2 : 0;
            const spr = mid > 0 ? (r.askPaise - r.bidPaise) / mid : 0;
            return (
              <tr key={r.instrumentId} className={held.has(r.instrumentId) ? 'held' : ''}>
                <td>{strike(r.strikePaise)}</td>
                <td>{r.right}</td>
                <td>{rupees(r.bidPaise)}</td>
                <td>{rupees(r.askPaise)}</td>
                <td>{rupees(r.ltpPaise)}</td>
                <td>{pct(spr)}</td>
                <td>{r.oi.toLocaleString()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------- chart

/** SVG candles. TODO(M8b+): upgrade to lightweight-charts if richer interaction is wanted. */
export function UnderlyingChart({ bars }: { bars: Bar[] }): JSX.Element {
  const data = bars.slice(-90);
  if (data.length === 0) {
    return (
      <section className="panel" data-testid="underlying-chart">
        <h2>UNDERLYING 1m</h2>
        <div className="flat">waiting for bars…</div>
      </section>
    );
  }
  const W = 600;
  const H = 150;
  const lo = Math.min(...data.map((b) => b.l));
  const hi = Math.max(...data.map((b) => b.h));
  const span = Math.max(1, hi - lo);
  const y = (v: number): number => H - ((v - lo) / span) * (H - 10) - 5;
  const cw = W / data.length;
  return (
    <section className="panel" data-testid="underlying-chart">
      <h2>
        UNDERLYING 1m <span className="chart-last">{rupees(data[data.length - 1]?.c ?? 0)}</span>
      </h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart">
        {data.map((b, i) => {
          const x = i * cw + cw / 2;
          const up = b.c >= b.o;
          return (
            <g key={b.startTs}>
              <line x1={x} x2={x} y1={y(b.h)} y2={y(b.l)} className={up ? 'wick up' : 'wick down'} />
              <rect
                x={x - Math.max(1, cw * 0.3)}
                width={Math.max(2, cw * 0.6)}
                y={y(Math.max(b.o, b.c))}
                height={Math.max(1, Math.abs(y(b.o) - y(b.c)))}
                className={up ? 'candle up' : 'candle down'}
              />
            </g>
          );
        })}
      </svg>
    </section>
  );
}

// ---------------------------------------------------------------- blotter

export function Blotter({ state }: { state: GatewayState }): JSX.Element {
  const [tab, setTab] = useState<'trades' | 'orders'>('trades');
  const orders = [...state.orders].sort((a, b) => b.updatedTs - a.updatedTs).slice(0, 12);
  const trades = [...state.trades].slice(-12).reverse();
  return (
    <section className="panel" data-testid="blotter">
      <h2>
        BLOTTER
        <span className="tabs">
          <button className={tab === 'trades' ? 'tab on' : 'tab'} onClick={() => setTab('trades')}>
            trades ({state.trades.length})
          </button>
          <button className={tab === 'orders' ? 'tab on' : 'tab'} onClick={() => setTab('orders')}>
            orders ({state.orders.length})
          </button>
        </span>
      </h2>
      {tab === 'trades' ? (
        <table>
          <thead>
            <tr>
              <th>time</th>
              <th>qty</th>
              <th>gross</th>
              <th>charges</th>
              <th>net</th>
              <th>exit</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.tradeId} data-testid="blotter-trade-row">
                <td>{istTime(t.exit.ts)}</td>
                <td>{t.qty}</td>
                <td>{rupees(t.grossPnlPaise)}</td>
                <td>{rupees(t.charges.totalPaise)}</td>
                <td className={t.netPnlPaise < 0 ? 'neg' : 'pos'}>{rupees(t.netPnlPaise)}</td>
                <td>{t.exitReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table>
          <thead>
            <tr>
              <th>time</th>
              <th>side</th>
              <th>qty</th>
              <th>limit</th>
              <th>fill</th>
              <th>state</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.clientOrderId} data-testid="blotter-order-row">
                <td>{istTime(o.updatedTs)}</td>
                <td>{o.side}</td>
                <td>
                  {o.filledQty}/{o.qty}
                </td>
                <td>{o.limitPricePaise !== undefined ? rupees(o.limitPricePaise) : 'MKT'}</td>
                <td>{o.avgFillPricePaise > 0 ? rupees(o.avgFillPricePaise) : '—'}</td>
                <td className={`ost-${o.state.toLowerCase()}`}>{o.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- events

function summarize(e: JEvent): string {
  switch (e.type) {
    case 'strategy.noTrade':
      return e.payload.reason;
    case 'strategy.signal':
      return `${e.payload.direction} ${e.payload.note ?? ''}`;
    case 'risk.verdict':
      return e.payload.verdict.approved ? 'APPROVED' : `REJECTED ${e.payload.verdict.reason ?? ''}`;
    case 'order.updated':
      return `${e.payload.order.side} ${e.payload.order.state}`;
    case 'stop.moved':
      return `stop → ${rupees(e.payload.to.stopPremiumPaise)} (${e.payload.to.layer})`;
    case 'stop.triggered':
      return `${e.payload.layer} @ ${rupees(e.payload.premiumPaise)}`;
    case 'trade.completed':
      return `net ${rupees(e.payload.trade.netPnlPaise)}`;
    case 'command.received':
      return e.payload.kind;
    case 'command.acked':
      return e.payload.accepted ? 'ok' : `rejected ${e.payload.reason ?? ''}`;
    case 'risk.sessionStop':
      return e.payload.kind;
    default:
      return '';
  }
}

export function EventStream({ state }: { state: GatewayState }): JSX.Element {
  const events = [...state.events].slice(-30).reverse();
  return (
    <section className="panel grow" data-testid="event-stream">
      <h2>EVENTS</h2>
      <div className="events">
        {events.map((e) => (
          <div key={e.seq} className="event">
            <span className="ev-time">{istTime(e.ts)}</span>
            <span className="ev-type">{e.type}</span>
            <span className="ev-summary">{summarize(e)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
