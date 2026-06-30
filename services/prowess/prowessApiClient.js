'use strict';

/**
 * Prowess API client — STUB.
 *
 * Will be implemented once Prowess API credentials and documentation are provided.
 * The ingestion handlers (prowessOhlcv.js, prowessFilings.js) call these functions;
 * currently they throw a descriptive error so the scheduler run records the failure
 * cleanly rather than silently doing nothing.
 *
 * Expected return shapes:
 *
 *   fetchOhlcv(date: string) → Array<{
 *     symbol: string, datetime: Date,
 *     open: number, high: number, low: number, close: number,
 *     volume: number|null, pe: number|null, market_cap_cr: number|null
 *   }>
 *
 *   fetchQuarterlyFilings(since: Date) → Array<{
 *     call_id: string, ticker: string, company: string,
 *     fiscal_year: string, quarter: string, call_date: string,
 *     kpi_abbr: string, value: number, raw_value: string,
 *     unit: string, multiplier: number, statement: string,
 *     start_date: string, end_date: string, period_type: string
 *   }>
 *
 *   fetchAnnualFilings(since: Date) → same shape as quarterly, quarter=null
 */

async function fetchOhlcv(_date) {
  throw new Error('Prowess API client not implemented — awaiting API credentials');
}

async function fetchQuarterlyFilings(_since) {
  throw new Error('Prowess API client not implemented — awaiting API credentials');
}

async function fetchAnnualFilings(_since) {
  throw new Error('Prowess API client not implemented — awaiting API credentials');
}

module.exports = { fetchOhlcv, fetchQuarterlyFilings, fetchAnnualFilings };
