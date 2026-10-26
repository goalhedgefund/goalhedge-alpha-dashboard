import { runAllOpReplay } from './replay-allop.js';

interface ResultRow {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: string;
  grossPaise: number;
  chargesPaise: number;
  netPaise: number;
  openLots: number;
  byExitReason: Array<{ reason: string; count: number; netPaise: number }>;
}

async function main() {
  const dates = [
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-12',
    '2026-10-13',
    '2026-10-14',
  ];

  console.log('=== RUNNING MULTI-DAY OUT-OF-SAMPLE TEST ===\n');
  const results: ResultRow[] = [];

  for (const date of dates) {
    try {
      process.stdout.write(`Replaying ${date}... `);
      const res = await runAllOpReplay(date);
      const winRate = res.trades > 0 ? ((res.wins / res.trades) * 100).toFixed(1) + '%' : '0.0%';
      results.push({
        date,
        trades: res.trades,
        wins: res.wins,
        losses: res.losses,
        winRate,
        grossPaise: res.grossPaise,
        chargesPaise: res.chargesPaise,
        netPaise: res.netPaise,
        openLots: res.openLots,
        byExitReason: res.byExitReason,
      });
      console.log(`Done. Trades: ${res.trades}, WinRate: ${winRate}, Net: ₹${(res.netPaise / 100).toFixed(2)}, Open: ${res.openLots} lots`);
    } catch (err) {
      console.error(`FAILED for ${date}:`, err);
    }
  }

  console.log('\n======================================= SUMMARY TABLE =======================================');
  console.log('| Date       | Trades | Wins | Losses | Win Rate | Gross P&L   | Charges    | Net P&L     | Open Lots |');
  console.log('|------------|--------|------|--------|----------|-------------|------------|-------------|-----------|');
  let totalTrades = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalGross = 0;
  let totalCharges = 0;
  let totalNet = 0;

  for (const r of results) {
    totalTrades += r.trades;
    totalWins += r.wins;
    totalLosses += r.losses;
    totalGross += r.grossPaise;
    totalCharges += r.chargesPaise;
    totalNet += r.netPaise;

    const gross = (r.grossPaise / 100).toFixed(2).padStart(11);
    const charges = (r.chargesPaise / 100).toFixed(2).padStart(10);
    const net = (r.netPaise / 100).toFixed(2).padStart(11);
    console.log(`| ${r.date} | ${String(r.trades).padStart(6)} | ${String(r.wins).padStart(4)} | ${String(r.losses).padStart(6)} | ${r.winRate.padStart(8)} | ₹${gross} | ₹${charges} | ₹${net} | ${String(r.openLots).padStart(9)} |`);
  }
  console.log('|------------|--------|------|--------|----------|-------------|------------|-------------|-----------|');
  const totWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) + '%' : '0.0%';
  const totGross = (totalGross / 100).toFixed(2).padStart(11);
  const totCharges = (totalCharges / 100).toFixed(2).padStart(10);
  const totNet = (totalNet / 100).toFixed(2).padStart(11);
  console.log(`| TOTAL      | ${String(totalTrades).padStart(6)} | ${String(totalWins).padStart(4)} | ${String(totalLosses).padStart(6)} | ${totWinRate.padStart(8)} | ₹${totGross} | ₹${totCharges} | ₹${totNet} |           |`);

  console.log('\n=== EXIT REASON BREAKDOWN PER DAY ===');
  for (const r of results) {
    console.log(`\n--- ${r.date} ---`);
    for (const er of r.byExitReason) {
      console.log(`  ${er.reason.padEnd(16)}: ${er.count} trades | Net ₹${(er.netPaise / 100).toFixed(2)}`);
    }
  }
}

main().catch(console.error);
