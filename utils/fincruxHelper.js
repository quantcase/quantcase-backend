//least priority

require("dotenv").config();

const FINCRUX_BASE_URL =
  process.env.FINCRUX_BASE_URL || "https://api.fincrux.org/api";
const FINCRUX_API_KEY = process.env.FINCRUX_API_KEY;

// ─── Parsing Utilities ────────────────────────────────────────────────────────

function parseNumericValue(val) {
  if (val === null || val === undefined || val === "") return null;
  return parseFloat(String(val).replace(/,/g, ""));
}

/** "₹2,82,771Cr." → 282771 (number in Cr) */
function parseMarketCap(mcStr) {
  if (!mcStr) return null;
  const cleaned = mcStr.replace(/[₹,]/g, "").replace("Cr.", "").trim();
  return parseFloat(cleaned);
}

/** "20%" → 20.0  |  "37.6%" → 37.6 */
function parsePercent(val) {
  if (!val) return null;
  return parseFloat(String(val).replace("%", "").trim());
}

// ─── Table Helpers ────────────────────────────────────────────────────────────

/** Find a row in a fin-crux 2-D table by its category name. */
function findRow(table, categoryName) {
  return table.find((row) => row[0] === categoryName) || null;
}

/**
 * Resolve the column indices for "last date" and "3 years ago" in an
 * annual table whose header row is  ["Category", "Mar 2014", ..., "TTM"].
 * "TTM" is not a real year — the column before it is treated as "last date".
 */
function resolveDateIndices(headers) {
  const dates = headers.slice(1); // drop "Category"
  let lastPos = dates.length - 1;
  if (dates[lastPos] === "TTM") lastPos--;
  const threeYearsAgoPos = lastPos - 3;
  return {
    lastDate: dates[lastPos] ?? null,
    lastColIdx: lastPos + 1, // +1 because row[0] = category name
    threeYearsAgoDate: threeYearsAgoPos >= 0 ? dates[threeYearsAgoPos] : null,
    threeYearsAgoColIdx: threeYearsAgoPos >= 0 ? threeYearsAgoPos + 1 : null,
  };
}

// ─── API Fetching ─────────────────────────────────────────────────────────────

/**
 * Fetch the full financials for a single ticker from the fin-crux API.
 *
 * @returns {{ ticker, company, tradingSymbol, data }}
 *   where `data` is the complete `data` object from the API response.
 */
async function fetchTickerFinancials(ticker, options = {}) {
  const { forceUpdate = false } = options;

  const params = new URLSearchParams({ api_key: FINCRUX_API_KEY });
  if (forceUpdate) params.set("force_update", "true");

  const url = `${FINCRUX_BASE_URL}/financials/${ticker}?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} for ticker ${ticker}: ${response.statusText}`
    );
  }

  const body = await response.json();

  if (body.success !== "true" && body.success !== true) {
    throw new Error(`fin-crux API returned failure for ticker ${ticker}`);
  }

  return {
    ticker,
    company: body.company,
    tradingSymbol: body.trading_symbol,
    data: body.data, // full raw data object
  };
}

/**
 * Fetch full financials for multiple tickers in parallel.
 * Failed tickers return `{ ticker, error }` — one failure won't abort the batch.
 *
 * @param {string[]} tickers
 * @param {{ forceUpdate?: boolean }} options
 * @returns {Promise<Array<{ ticker, company, tradingSymbol, data } | { ticker, error }>>}
 */
async function fetchMultipleTickerFinancials(tickers, options = {}) {
  const results = [];
  for (const ticker of tickers) {
    try {
      results.push(await fetchTickerFinancials(ticker, options));
    } catch (err) {
      results.push({ ticker, error: err.message ?? "Unknown error" });
    }
  }
  return results;
}

// ─── Industry Metrics Calculation ────────────────────────────────────────────

/** CAGR = (end / start)^(1/n) - 1 */
function calcCagr(start, end, n) {
  if (!start || !end || start <= 0 || n <= 0) return null;
  return Math.pow(end / start, 1 / n) - 1;
}

/**
 * Pull all numbers needed for industry metrics out of one ticker result.
 *
 * Revenue = "Sales" row in profit_and_loss (screener.in labels top-line as Sales).
 *
 * @returns {{
 *   marketCap,
 *   revenueYear0, revenueYear3,   // Sales 3 yrs ago & last date
 *   epsYear0,     epsYear3,        // EPS 3 yrs ago & last date
 *   roceYear0,    roceYear3,       // ROCE % 3 yrs ago & last date (from ratios table)
 *   opm,                           // current OPM % (point-in-time, not CAGR)
 * }}
 */
function extractMetricsFromTickerResult(tickerResult) {
  const { data } = tickerResult;

  // Market Cap
  const marketCap = parseMarketCap(data.top_ratios?.["Market Cap"]);

  // ── profit_and_loss: Revenue (Sales), EPS, OPM ──────────────────────────
  let revenueYear3 = null, revenueYear0 = null;
  let epsYear3     = null, epsYear0     = null;
  let opm          = null;

  const pl = data.profit_and_loss;
  if (pl && pl.length >= 2) {
    const { lastColIdx, threeYearsAgoColIdx } = resolveDateIndices(pl[0]);
    const pick = (row) => ({
      last:  row ? parseNumericValue(row[lastColIdx]) : null,
      prior: row && threeYearsAgoColIdx != null
               ? parseNumericValue(row[threeYearsAgoColIdx])
               : null,
    });

    const rev = pick(findRow(pl, "Sales"));
    revenueYear3 = rev.last;
    revenueYear0 = rev.prior;

    const eps = pick(findRow(pl, "EPS in Rs"));
    epsYear3 = eps.last;
    epsYear0 = eps.prior;

    const opmRow = findRow(pl, "OPM %");
    if (opmRow) opm = parsePercent(opmRow[lastColIdx]);
  }

  // ── ratios: ROCE % — both last date and 3 years ago ─────────────────────
  let roceYear3 = null, roceYear0 = null;

  const ratios = data.ratios;
  if (ratios && ratios.length >= 2) {
    const { lastColIdx, threeYearsAgoColIdx } = resolveDateIndices(ratios[0]);
    const roceRow = findRow(ratios, "ROCE %");
    if (roceRow) {
      roceYear3 = parsePercent(roceRow[lastColIdx]);
      roceYear0 = threeYearsAgoColIdx != null
        ? parsePercent(roceRow[threeYearsAgoColIdx])
        : null;
    }
  }
  // fallback: top_ratios only gives current ROCE, so only use for roceYear3
  if (roceYear3 === null && data.top_ratios?.["ROCE"]) {
    roceYear3 = parsePercent(data.top_ratios["ROCE"]);
  }

  return {
    marketCap,
    revenueYear0, revenueYear3,
    epsYear0,     epsYear3,
    roceYear0,    roceYear3,
    opm,
  };
}

/**
 * Calculate industry-level market-cap-weighted metrics from the results
 * returned by fetchMultipleTickerFinancials().
 *
 * CAGRs (all over n years, default 3):
 *  - weightedRevenueCagrPct  MC-weighted revenue (Sales) CAGR   (%)
 *  - weightedEpsCagrPct      MC-weighted EPS CAGR               (%)
 *  - weightedRoceCagrPct     MC-weighted ROCE CAGR              (%)
 *
 * Point-in-time weighted averages:
 *  - weightedOpmPct          MC-weighted current OPM            (%)
 *  - weightedRocePct         MC-weighted current ROCE           (%)
 *
 * Note: "Sales" in the screener.in data IS the revenue / top-line figure.
 *
 * Tickers with errors or missing market cap are skipped with a warning.
 *
 * @param {Array}  tickerResults  Output of fetchMultipleTickerFinancials()
 * @param {number} [n=3]          Number of years between Year 0 and Year 3
 */
function calculateIndustryMetrics(tickerResults, n = 3) {
  // Step 1: extract per-company numbers and compute individual CAGRs
  const companies = tickerResults
    .filter((r) => {
      if (r.error) {
        console.warn(`[industry-metrics] Skipping ${r.ticker}: ${r.error}`);
        return false;
      }
      return true;
    })
    .map((r) => {
      const {
        marketCap,
        revenueYear0, revenueYear3,
        epsYear0,     epsYear3,
        roceYear0,    roceYear3,
        opm,
      } = extractMetricsFromTickerResult(r);

      if (!marketCap) {
        console.warn(
          `[industry-metrics] ${r.ticker} has no market cap — excluded from weights`
        );
      }

      return {
        ticker:      r.ticker,
        company:     r.company,
        marketCap:   marketCap ?? 0,
        revenueCagr: calcCagr(revenueYear0, revenueYear3, n), // decimal
        epsCagr:     calcCagr(epsYear0,     epsYear3,     n), // decimal
        roceCagr:    calcCagr(roceYear0,    roceYear3,    n), // decimal
        opm,      // current OPM %  (point-in-time)
        roce:     roceYear3, // current ROCE % (point-in-time)
      };
    });

  // Step 2: total market cap
  const totalMarketCap = companies.reduce((s, c) => s + c.marketCap, 0);
  if (totalMarketCap === 0) {
    throw new Error("Cannot calculate industry metrics: no valid market cap data");
  }

  // Steps 3 & 4: weights × individual metrics → industry aggregates
  let weightedRevenueCagr = 0;
  let weightedEpsCagr     = 0;
  let weightedRoceCagr    = 0;
  let weightedOpm         = 0;
  let weightedRoce        = 0;

  const breakdown = companies.map((c) => {
    const weight = c.marketCap / totalMarketCap;

    const wRev  = c.revenueCagr != null ? weight * c.revenueCagr : 0;
    const wEps  = c.epsCagr     != null ? weight * c.epsCagr     : 0;
    const wRoceC= c.roceCagr    != null ? weight * c.roceCagr    : 0;
    const wOpm  = c.opm         != null ? weight * c.opm         : 0;
    const wRoce = c.roce        != null ? weight * c.roce        : 0;

    weightedRevenueCagr += wRev;
    weightedEpsCagr     += wEps;
    weightedRoceCagr    += wRoceC;
    weightedOpm         += wOpm;
    weightedRoce        += wRoce;

    return {
      ticker:          c.ticker,
      company:         c.company,
      marketCap:       c.marketCap,
      weightPct:       round(weight * 100, 4),
      // CAGRs in %
      revenueCagrPct:  c.revenueCagr != null ? round(c.revenueCagr * 100, 4) : null,
      epsCagrPct:      c.epsCagr     != null ? round(c.epsCagr     * 100, 4) : null,
      roceCagrPct:     c.roceCagr    != null ? round(c.roceCagr    * 100, 4) : null,
      // point-in-time
      opm:             c.opm,
      roce:            c.roce,
      // weighted contributions (for auditability)
      wRevenueCagrPct: round(wRev   * 100, 4),
      wEpsCagrPct:     round(wEps   * 100, 4),
      wRoceCagrPct:    round(wRoceC * 100, 4),
      wOpmPct:         round(wOpm,         4),
      wRocePct:        round(wRoce,        4),
    };
  });

  return {
    totalMarketCap,
    companies: breakdown,
    industry: {
      weightedRevenueCagrPct: round(weightedRevenueCagr * 100, 4),
      weightedEpsCagrPct:     round(weightedEpsCagr     * 100, 4),
      weightedRoceCagrPct:    round(weightedRoceCagr    * 100, 4),
      weightedOpmPct:         round(weightedOpm,              4),
      weightedRocePct:        round(weightedRoce,             4),
    },
  };
}

function round(val, decimals) {
  return parseFloat(val.toFixed(decimals));
}

module.exports = {
  fetchMultipleTickerFinancials,
  fetchTickerFinancials,
  calculateIndustryMetrics,
};
