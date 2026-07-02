/** Itemized charges for one trade, all integer paise. */
export interface ChargeBreakdown {
  totalPaise: number;
  components: Array<{ name: string; paise: number }>;
}
