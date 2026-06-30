const { env } = require('./env');

module.exports = {
  rr: 3,
  capital: env.capital,
  riskPerTrade: env.riskPerTrade,
  kellyCap: env.kellyCap,
  maxRiskPerSymbol: 0.05,
  minKellyFraction: 0.02
};
