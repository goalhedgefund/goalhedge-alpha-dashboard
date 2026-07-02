import type { MarketProfile } from '../config/schemas.js';
import type { ChargeBreakdown } from '../domain/charges.js';
import type { Side } from '../domain/orders.js';

export interface FillForCharges {
  side: Side;
  qty: number;
  /** Premium price per unit, integer paise. */
  pricePaise: number;
}

/**
 * Compute itemized statutory + broker charges for a set of fills against a
 * market profile. All arithmetic stays in integer paise; each component is
 * rounded to the nearest paisa (matching typical broker contract-note practice).
 *
 * GST is computed on the pre-GST sum of all gstApplicable components, then
 * appended as its own line item — so the GST line covers brokerage too (even
 * when brokerage is zero, the base is correctly zero).
 */
export function computeCharges(
  fills: FillForCharges[],
  profile: MarketProfile,
): ChargeBreakdown {
  let buyTurnover = 0;
  let sellTurnover = 0;

  for (const f of fills) {
    const t = f.qty * f.pricePaise;
    if (f.side === 'BUY') buyTurnover += t;
    else sellTurnover += t;
  }
  const bothTurnover = buyTurnover + sellTurnover;
  const orderCount = fills.length;

  let gstBase = 0;
  const components: Array<{ name: string; paise: number }> = [];

  for (const comp of profile.charges.components) {
    let paise: number;

    if (comp.rate !== undefined) {
      let turnover: number;
      switch (comp.basis) {
        case 'buy_premium':
          turnover = buyTurnover;
          break;
        case 'sell_premium':
          turnover = sellTurnover;
          break;
        case 'both_premium':
          turnover = bothTurnover;
          break;
        default:
          turnover = 0;
      }
      paise = Math.round(turnover * comp.rate);
    } else {
      paise = (comp.flatPaise ?? 0) * orderCount;
    }

    if (comp.gstApplicable) gstBase += paise;
    components.push({ name: comp.name, paise });
  }

  const gstPaise = Math.round(gstBase * profile.charges.gstRate);
  components.push({ name: 'gst', paise: gstPaise });

  const totalPaise = components.reduce((s, c) => s + c.paise, 0);
  return { totalPaise, components };
}

/**
 * Net P&L from gross P&L and the charge breakdown.
 * Net can be negative (charges exceed profit or amplify loss).
 */
export function computeTradeNet(grossPnlPaise: number, charges: ChargeBreakdown): number {
  return grossPnlPaise - charges.totalPaise;
}

/** Aggregate charges across multiple trades in a session. */
export function aggregateCharges(breakdowns: ChargeBreakdown[]): ChargeBreakdown {
  if (breakdowns.length === 0) return { totalPaise: 0, components: [] };

  const byName = new Map<string, number>();
  for (const bd of breakdowns) {
    for (const c of bd.components) {
      byName.set(c.name, (byName.get(c.name) ?? 0) + c.paise);
    }
  }
  const components = Array.from(byName.entries()).map(([name, paise]) => ({ name, paise }));
  const totalPaise = components.reduce((s, c) => s + c.paise, 0);
  return { totalPaise, components };
}
