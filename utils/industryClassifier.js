/**
 * BFSI industries collected from earnings_calls.basic_industry (distinct values).
 * All other industries are treated as non-BFSI.
 */
const BFSI_INDUSTRIES = new Set([
  // Banking
  'Private Sector Bank',
  'Public Sector Bank',
  'Other Bank',

  // Financial Institutions & Lending
  'Financial Institution',
  'Housing Finance Company',
  'Microfinance Institutions',
  'NBFC',

  // Asset Management & Investment
  'Asset Management Company',
  'Investment Company',

  // Insurance
  'General Insurance',
  'Life Insurance',

  // Financial Services & Infrastructure
  'Financial Products Distributor',
  'Other Financial Services',
  'Stockbroking & Allied',
  'Dep, Clrng Houses and Other Interm',
  'Exchange and Data Platform',
  'Financial Technology (Fintech)',
]);

/**
 * Returns true if the given industry string falls under BFSI.
 * @param {string | null | undefined} industry
 * @returns {boolean}
 */
function isBFSI(industry) {
  if (!industry) return false;
  return BFSI_INDUSTRIES.has(industry);
}

module.exports = { isBFSI, BFSI_INDUSTRIES };
