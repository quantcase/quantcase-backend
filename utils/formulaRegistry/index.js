'use strict';

module.exports = {
  ...require('./financial'),          // REGISTRY, resolveMetric, resolveKpi
  ...require('./technical'),          // TECHNICAL_REGISTRY, resolveTechnicalIndicators, resolveIndicatorSeries
  ...require('./seriesResolver'),     // SOURCE_ABBRS, computeRegistryDerivedSeries
  ...require('./dataFetcher'),        // resolveProwessName, fetchKpiMap, fetchKpiMaps, fetchKpiMapsMulti, fetchTimeSeries, fetchTimeSeriesBatch, fetchProwessTimeSeries
  ...require('./dataFetcherMarket'),  // aggregateBars, aggregateIndexBars, fetchOhlcvBars, fetchMarketSnapshot, fetchMarketSnapshots, fetchPeTimeSeries, fetchMonthlyClose, fetchMonthlyOhlcv, fetchIndexBars
};
