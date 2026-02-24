const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();


// ─── Standalone KPIs ─────────────────────────────────────────────────────────
// These have no dependencies, so they're inserted first.

const STANDALONE_KPIS = [
  // Income statement
  { abbr: 'REV',    full_form: 'Revenue',                          denomination: 'INR' },
  { abbr: 'EBITDA', full_form: 'Earnings Before Interest Tax Depreciation and Amortization', denomination: 'INR' },
  { abbr: 'EBIT',   full_form: 'Earnings Before Interest and Tax', denomination: 'INR' },
  { abbr: 'PBT',    full_form: 'Profit Before Tax',                denomination: 'INR' },
  { abbr: 'PAT',    full_form: 'Profit After Tax',                 denomination: 'INR' },
  { abbr: 'GP',     full_form: 'Gross Profit',                     denomination: 'INR' },
  { abbr: 'COGS',   full_form: 'Cost of Goods Sold',               denomination: 'INR' },
  { abbr: 'OPEX',   full_form: 'Operating Expenditure',            denomination: 'INR' },
  { abbr: 'CAPEX',  full_form: 'Capital Expenditure',              denomination: 'INR' },
  { abbr: 'D&A',    full_form: 'Depreciation and Amortization',    denomination: 'INR' },
  { abbr: 'INTEXP', full_form: 'Interest Expense',                 denomination: 'INR' },
  { abbr: 'TAX',    full_form: 'Tax Expense',                      denomination: 'INR' },

  // Balance sheet
  { abbr: 'TA',     full_form: 'Total Assets',                     denomination: 'INR' },
  { abbr: 'TL',     full_form: 'Total Liabilities',                denomination: 'INR' },
  { abbr: 'EQ',     full_form: 'Shareholders Equity',              denomination: 'INR' },
  { abbr: 'DEBT',   full_form: 'Total Debt',                       denomination: 'INR' },
  { abbr: 'CASH',   full_form: 'Cash and Cash Equivalents',        denomination: 'INR' },
  { abbr: 'WC',     full_form: 'Working Capital',                  denomination: 'INR' },
  { abbr: 'INV',    full_form: 'Inventory',                        denomination: 'INR' },
  { abbr: 'AR',     full_form: 'Accounts Receivable',              denomination: 'INR' },
  { abbr: 'AP',     full_form: 'Accounts Payable',                 denomination: 'INR' },

  // Cash flow
  { abbr: 'OCF',    full_form: 'Operating Cash Flow',              denomination: 'INR' },
  { abbr: 'FCF',    full_form: 'Free Cash Flow',                   denomination: 'INR' },

  // Per-share
  { abbr: 'EPS',    full_form: 'Earnings Per Share',               denomination: 'INR' },
  { abbr: 'BV',     full_form: 'Book Value Per Share',             denomination: 'INR' },
  { abbr: 'DPS',    full_form: 'Dividend Per Share',               denomination: 'INR' },

  // Percentages (standalone — denomination = percentage)
  { abbr: 'GPM',    full_form: 'Gross Profit Margin',              denomination: 'percentage' },
  { abbr: 'OPM',    full_form: 'Operating Profit Margin',          denomination: 'percentage' },
  { abbr: 'NPM',    full_form: 'Net Profit Margin',                denomination: 'percentage' },
  { abbr: 'ROE',    full_form: 'Return on Equity',                 denomination: 'percentage' },
  { abbr: 'ROA',    full_form: 'Return on Assets',                 denomination: 'percentage' },
  { abbr: 'ROCE',   full_form: 'Return on Capital Employed',       denomination: 'percentage' },
  { abbr: 'ROIC',   full_form: 'Return on Invested Capital',       denomination: 'percentage' },

  // Operational
  { abbr: 'UNITS',  full_form: 'Units Sold',                       denomination: 'units' },
  { abbr: 'EMP',    full_form: 'Number of Employees',              denomination: 'units' },
  { abbr: 'STORES', full_form: 'Number of Stores or Outlets',      denomination: 'units' },
  { abbr: 'CUST',   full_form: 'Number of Customers',              denomination: 'units' },
  { abbr: 'SUBSC',  full_form: 'Number of Subscribers',            denomination: 'units' },

  // Days-based
  { abbr: 'DSO',    full_form: 'Days Sales Outstanding',           denomination: 'days' },
  { abbr: 'DIO',    full_form: 'Days Inventory Outstanding',       denomination: 'days' },
  { abbr: 'DPO',    full_form: 'Days Payable Outstanding',         denomination: 'days' },
  { abbr: 'CCC',    full_form: 'Cash Conversion Cycle',            denomination: 'days' },

  // Industry / macro
  { abbr: 'TAM',    full_form: 'Total Addressable Market',         denomination: 'INR' },
  { abbr: 'SAM',    full_form: 'Serviceable Addressable Market',   denomination: 'INR' },
  { abbr: 'CAGR',   full_form: 'Compound Annual Growth Rate',      denomination: 'percentage' },
  { abbr: 'MKTSHR', full_form: 'Market Share',                     denomination: 'percentage' },
  { abbr: 'INFL',   full_form: 'Inflation Rate',                   denomination: 'percentage' },
  { abbr: 'GDPG',   full_form: 'GDP Growth Rate',                  denomination: 'percentage' },
];

// ─── Ratio KPIs ──────────────────────────────────────────────────────────────
// References other abbrs — both numerator and denominator must exist first.

const RATIO_KPIS = [
  { abbr: 'PE',     full_form: 'Price to Earnings Ratio',          numerator_abbr: 'BV',   denominator_abbr: 'EPS'  },
  { abbr: 'PB',     full_form: 'Price to Book Ratio',              numerator_abbr: 'BV',   denominator_abbr: 'BV'   },
  { abbr: 'DE',     full_form: 'Debt to Equity Ratio',             numerator_abbr: 'DEBT', denominator_abbr: 'EQ'   },
  { abbr: 'CR',     full_form: 'Current Ratio',                    numerator_abbr: 'WC',   denominator_abbr: 'TL'   },
  { abbr: 'AT',     full_form: 'Asset Turnover Ratio',             numerator_abbr: 'REV',  denominator_abbr: 'TA'   },
  { abbr: 'IT',     full_form: 'Inventory Turnover Ratio',         numerator_abbr: 'COGS', denominator_abbr: 'INV'  },
  { abbr: 'IC',     full_form: 'Interest Coverage Ratio',          numerator_abbr: 'EBIT', denominator_abbr: 'INTEXP'},
  { abbr: 'EVEBITDA',full_form:'EV to EBITDA',                     numerator_abbr: 'TA',   denominator_abbr: 'EBITDA'},
];

// ─── Seed function ────────────────────────────────────────────────────────────

async function seed() {
  console.log('Seeding KPI table...');
  let inserted = 0, skipped = 0, failed = 0;

  // Pass 1 — standalones
  for (const kpi of STANDALONE_KPIS) {
    try {
      await prisma.kpi.upsert({
        where:  { abbr: kpi.abbr },
        update: {},                          // don't overwrite if exists
        create: { ...kpi, type: 'standalone' }
      });
      inserted++;
    } catch (err) {
      console.error(`Failed to seed ${kpi.abbr}:`, err.message);
      failed++;
    }
  }
  console.log(`Standalones: ${inserted} upserted, ${failed} failed`);

  // Pass 2 — ratios
  inserted = 0; failed = 0;
  for (const kpi of RATIO_KPIS) {
    try {
      const numerator   = await prisma.kpi.findUnique({ where: { abbr: kpi.numerator_abbr } });
      const denominator = await prisma.kpi.findUnique({ where: { abbr: kpi.denominator_abbr } });

      if (!numerator)   { console.warn(`Skipping ${kpi.abbr}: numerator ${kpi.numerator_abbr} not found`);   skipped++; continue; }
      if (!denominator) { console.warn(`Skipping ${kpi.abbr}: denominator ${kpi.denominator_abbr} not found`); skipped++; continue; }

      await prisma.kpi.upsert({
        where:  { abbr: kpi.abbr },
        update: {},
        create: {
          abbr:           kpi.abbr,
          full_form:      kpi.full_form,
          type:           'ratio',
          numerator_id:   numerator.id,
          denominator_id: denominator.id
        }
      });
      inserted++;
    } catch (err) {
      console.error(`Failed to seed ${kpi.abbr}:`, err.message);
      failed++;
    }
  }
  console.log(`Ratios: ${inserted} upserted, ${skipped} skipped (missing ref), ${failed} failed`);
  console.log('Seeding complete.');
}

seed()
  .catch(console.error)
  .finally(() => prisma.$disconnect());