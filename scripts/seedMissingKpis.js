require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const GROUP_INDUSTRIES = {
  BANKS:             ['Private Sector Bank', 'Public Sector Bank', 'Other Bank'],
  NBFC_LENDING:      ['NBFC', 'Housing Finance Company', 'Microfinance Institutions', 'Financial Institution'],
  INSURANCE:         ['Life Insurance', 'General Insurance'],
  TELECOM:           ['Telecom - Cellular & Fixed line services', 'Telecom - Equipment & Accessories', 'Telecom - Infrastructure', 'Other Telecom Services'],
  AIRLINE:           ['Airline'],
  HOSPITALITY:       ['Hotels & Resorts', 'Amusement Parks/ Other Recreation', 'Restaurants', 'Tour, Travel Related Services'],
  REAL_ESTATE:       ['Residential, Commercial Projects', 'Civil Construction'],
  RETAIL:            ['Diversified Retail', 'Speciality Retail', 'E-Retail/ E-Commerce', 'Pharmacy Retail', 'Internet & Catalogue Retail'],
  IT_SERVICES:       ['Computers - Software & Consulting', 'Software Products', 'IT Enabled Services', 'BPO/KPO', 'Healthcare Research, Analytics & Technology', 'Financial Technology (Fintech)'],
  POWER:             ['Integrated Power Utilities', 'Power Generation', 'Power Distribution', 'Power - Transmission', 'Power Trading'],
  PHARMA_HEALTHCARE: ['Pharmaceuticals', 'Hospital', 'Healthcare Service Provider', 'Biotechnology'],
};

function resolveIndustries(appliesTo) {
  if (!appliesTo || appliesTo === 'default') return [];
  return appliesTo
    .split(',')
    .map(s => s.trim())
    .flatMap(part => GROUP_INDUSTRIES[part] ?? [part])
    .filter((v, i, a) => a.indexOf(v) === i);
}

// ── Standalone KPIs ───────────────────────────────────────────────────────────
const STANDALONE = [
  // cross-industry (default framework gaps)
  { abbr: 'NETDEBT',      full_form: 'Net Debt',                               denomination: 'INR',        applies_to: 'default',                 source: 'QE' },
  // banking / nbfc
  { abbr: 'NIM',          full_form: 'Net Interest Margin',                    denomination: 'percentage', applies_to: 'BANKS, NBFC_LENDING',     source: 'QE' },
  { abbr: 'GNPA',         full_form: 'Gross Non-Performing Assets Ratio',      denomination: 'percentage', applies_to: 'BANKS, NBFC_LENDING',     source: 'QE' },
  { abbr: 'NNPA',         full_form: 'Net Non-Performing Assets Ratio',        denomination: 'percentage', applies_to: 'BANKS, NBFC_LENDING',     source: 'QE' },
  { abbr: 'CAR',          full_form: 'Capital Adequacy Ratio',                 denomination: 'percentage', applies_to: 'BANKS, NBFC_LENDING',     source: 'QE' },
  { abbr: 'CASA',         full_form: 'CASA Ratio',                             denomination: 'percentage', applies_to: 'BANKS',                   source: 'QE' },
  { abbr: 'PCR',          full_form: 'Provision Coverage Ratio',               denomination: 'percentage', applies_to: 'BANKS, NBFC_LENDING',     source: 'QE' },
  { abbr: 'CREDITCOST',   full_form: 'Credit Cost',                            denomination: 'percentage', applies_to: 'BANKS, NBFC_LENDING',     source: 'QE' },
  { abbr: 'NETINTINC',    full_form: 'Net Interest Income',                    denomination: 'INR',        applies_to: 'BANKS, NBFC_LENDING',     source: 'QE' },
  // insurance
  { abbr: 'GWP',          full_form: 'Gross Written Premium',                  denomination: 'INR',        applies_to: 'INSURANCE',               source: 'QE' },
  { abbr: 'LR',           full_form: 'Loss Ratio',                             denomination: 'percentage', applies_to: 'General Insurance',       source: 'QE' },
  { abbr: 'COMBR',        full_form: 'Combined Ratio',                         denomination: 'percentage', applies_to: 'General Insurance',       source: 'QE' },
  { abbr: 'SOLVR',        full_form: 'Solvency Ratio',                         denomination: 'percentage', applies_to: 'INSURANCE',               source: 'QE' },
  { abbr: 'VNB',          full_form: 'Value of New Business',                  denomination: 'INR',        applies_to: 'Life Insurance',          source: 'transcript' },
  { abbr: 'NBM',          full_form: 'New Business Margin',                    denomination: 'percentage', applies_to: 'Life Insurance',          source: 'transcript' },
  { abbr: 'PERSISTENCY',  full_form: 'Policy Persistency Ratio',               denomination: 'percentage', applies_to: 'Life Insurance',          source: 'transcript' },
  // telecom
  { abbr: 'ARPU',         full_form: 'Average Revenue Per User',               denomination: 'INR',        applies_to: 'TELECOM',                 source: 'transcript' },
  { abbr: 'CHURN',        full_form: 'Churn Rate',                             denomination: 'percentage', applies_to: 'TELECOM',                 source: 'transcript' },
  { abbr: 'DATA_VOL',     full_form: 'Data Consumption per User',              denomination: 'units',      applies_to: 'TELECOM',                 source: 'transcript' },
  // airline
  { abbr: 'PLF',          full_form: 'Passenger Load Factor',                  denomination: 'percentage', applies_to: 'AIRLINE',                 source: 'transcript' },
  { abbr: 'RASK',         full_form: 'Revenue per Available Seat Kilometer',   denomination: 'INR',        applies_to: 'AIRLINE',                 source: 'transcript' },
  { abbr: 'CASK',         full_form: 'Cost per Available Seat Kilometer',      denomination: 'INR',        applies_to: 'AIRLINE',                 source: 'transcript' },
  // hospitality
  { abbr: 'REVPAR',       full_form: 'Revenue Per Available Room',             denomination: 'INR',        applies_to: 'HOSPITALITY',             source: 'transcript' },
  { abbr: 'ADR',          full_form: 'Average Daily Rate',                     denomination: 'INR',        applies_to: 'HOSPITALITY',             source: 'transcript' },
  { abbr: 'OCC',          full_form: 'Occupancy Rate',                         denomination: 'percentage', applies_to: 'HOSPITALITY',             source: 'transcript' },
  // cement
  { abbr: 'EBITDA_T',     full_form: 'EBITDA per Tonne',                       denomination: 'INR',        applies_to: 'Cement & Cement Products',source: 'QE' },
  { abbr: 'REALIZ_T',     full_form: 'Realization per Tonne',                  denomination: 'INR',        applies_to: 'Cement & Cement Products',source: 'QE' },
  // oil & gas
  { abbr: 'GRM',          full_form: 'Gross Refining Margin',                  denomination: 'USD',        applies_to: 'Refineries & Marketing',  source: 'transcript' },
  // real estate
  { abbr: 'PRESALES',     full_form: 'Pre-Sales / Bookings Value',             denomination: 'INR',        applies_to: 'REAL_ESTATE',             source: 'transcript' },
  { abbr: 'COLLN',        full_form: 'Collections',                            denomination: 'INR',        applies_to: 'REAL_ESTATE',             source: 'transcript' },
  { abbr: 'AREABKD',      full_form: 'Area Booked',                            denomination: 'units',      applies_to: 'REAL_ESTATE',             source: 'transcript' },
  // retail
  { abbr: 'SSSG',         full_form: 'Same-Store Sales Growth',                denomination: 'percentage', applies_to: 'RETAIL',                  source: 'transcript' },
  { abbr: 'SQFT',         full_form: 'Revenue per Square Foot',                denomination: 'INR',        applies_to: 'RETAIL',                  source: 'transcript' },
  // it services
  { abbr: 'ATT',          full_form: 'Attrition Rate',                         denomination: 'percentage', applies_to: 'IT_SERVICES',             source: 'transcript' },
  { abbr: 'UTIL',         full_form: 'Utilization Rate',                       denomination: 'percentage', applies_to: 'IT_SERVICES',             source: 'transcript' },
  // power
  { abbr: 'PLF_POWER',    full_form: 'Plant Load Factor',                      denomination: 'percentage', applies_to: 'POWER',                   source: 'transcript' },
  { abbr: 'CAPACITY_MW',  full_form: 'Installed Capacity',                     denomination: 'units',      applies_to: 'POWER',                   source: 'transcript' },
  // pharma
  { abbr: 'RND_PCT',      full_form: 'R&D Expense as Percentage of Revenue',   denomination: 'percentage', applies_to: 'PHARMA_HEALTHCARE',       source: 'transcript' },
];

// ── Ratio KPIs (numerator/denominator must exist in DB first) ─────────────────
const RATIOS = [
  { abbr: 'EBITDA_MARGIN',  full_form: 'EBITDA Margin',            numerator: 'EBITDA',  denominator: 'REV',    applies_to: 'default',     source: 'QE' },
  { abbr: 'FCF_CONV',       full_form: 'FCF Conversion Ratio',     numerator: 'FCF',     denominator: 'PAT',    applies_to: 'default',     source: 'QE' },
  { abbr: 'OCF_EBITDA',     full_form: 'OCF to EBITDA Ratio',      numerator: 'OCF',     denominator: 'EBITDA', applies_to: 'default',     source: 'QE' },
  { abbr: 'NETDEBT_EBITDA', full_form: 'Net Debt to EBITDA Ratio', numerator: 'NETDEBT', denominator: 'EBITDA', applies_to: 'default',     source: 'QE' },
  { abbr: 'REV_EMP',        full_form: 'Revenue per Employee',     numerator: 'REV',     denominator: 'EMP',    applies_to: 'IT_SERVICES', source: 'transcript' },
];

async function main() {
  let inserted = 0, skipped = 0;

  // 1. Insert standalone KPIs
  for (const k of STANDALONE) {
    const exists = await prisma.kpi.findUnique({ where: { abbr: k.abbr } });
    if (exists) { console.log(`SKIP  ${k.abbr}`); skipped++; continue; }
    await prisma.kpi.create({
      data: {
        abbr:         k.abbr,
        full_form:    k.full_form,
        type:         'standalone',
        denomination: k.denomination,
        industry:     resolveIndustries(k.applies_to),
        source:       k.source,
      }
    });
    console.log(`OK    ${k.abbr}`);
    inserted++;
  }

  // 2. Insert ratio KPIs (look up num/denom IDs)
  const lookupId = async (abbr) => {
    const row = await prisma.kpi.findUnique({ where: { abbr } });
    if (!row) throw new Error(`KPI not found for ratio: ${abbr}`);
    return row.id;
  };

  for (const k of RATIOS) {
    const exists = await prisma.kpi.findUnique({ where: { abbr: k.abbr } });
    if (exists) { console.log(`SKIP  ${k.abbr}`); skipped++; continue; }
    await prisma.kpi.create({
      data: {
        abbr:           k.abbr,
        full_form:      k.full_form,
        type:           'ratio',
        numerator_id:   await lookupId(k.numerator),
        denominator_id: await lookupId(k.denominator),
        industry:       resolveIndustries(k.applies_to),
        source:         k.source,
      }
    });
    console.log(`OK    ${k.abbr}`);
    inserted++;
  }

  console.log(`\nDone. Inserted: ${inserted}  Skipped (already existed): ${skipped}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
