module.exports = [
  {
    key: '1',
    label: '1',
    timeframe: '1m',
    interval: '1',
    workbookName: 'live-trades-1min.xlsx',
    refreshMs: 60 * 1000,
    candlesRequired: 120
  },
  {
    key: '5',
    label: '5',
    timeframe: '5m',
    interval: '5',
    workbookName: 'live-trades-5min.xlsx',
    refreshMs: 2 * 60 * 1000,
    candlesRequired: 120
  },
  {
    key: '15',
    label: '15',
    timeframe: '15m',
    interval: '15',
    workbookName: 'live-trades-15min.xlsx',
    refreshMs: 5 * 60 * 1000,
    candlesRequired: 140
  },
  {
    key: '60',
    label: '60',
    timeframe: '60m',
    interval: '60',
    workbookName: 'live-trades-60min.xlsx',
    refreshMs: 20 * 60 * 1000,
    candlesRequired: 180
  },
  {
    key: 'D',
    label: 'D',
    timeframe: 'D',
    interval: 'D',
    workbookName: 'live-trades-daily.xlsx',
    refreshMs: 60 * 60 * 1000,
    candlesRequired: 250
  }
];
