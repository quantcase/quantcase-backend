const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ─── QE KPIs ──────────────────────────────────────────────────────────────────

const QE_KPIS = [
  // Assets
  { abbr: 'TOTAL_ASSETS',       full_form: 'Total Assets',                                                                  kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'NONCURR_ASSETS',     full_form: 'Total Non-Current Assets',                                                      kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'ASSET_PPE',          full_form: 'Property, Plant and Equipment',                                                 kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'ASSET_CWIP',         full_form: 'Capital Work-in-Progress',                                                      kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'INV_NONCURR',        full_form: 'Non-Current Investments',                                                       kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'LOANS_NONCURR',      full_form: 'Long-Term Loans and Advances',                                                  kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'OTH_ASSET_NC',       full_form: 'Other Non-Current Assets',                                                     kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'CURR_ASSETS',        full_form: 'Total Current Assets',                                                          kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'INVENTORY',          full_form: 'Inventories',                                                                   kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'INV_CURR',           full_form: 'Current Investments',                                                           kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'TRADE_RECV',         full_form: 'Trade Receivables',                                                             kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'CASH_EQUIV',         full_form: 'Cash and Cash Equivalents',                                                     kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'BANK_BAL_OTHER',     full_form: 'Other Bank Balances',                                                           kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'LOANS_CURR',         full_form: 'Short-Term Loans and Advances',                                                 kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'TOTAL_FIN_ASSETS',   full_form: 'Total Financial Assets',                                                        kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'TOTAL_NONFIN_ASSETS',full_form: 'Total Non-Financial Assets',                                                    kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'BANK_BAL',           full_form: 'Bank Balances Other Than Cash and Cash Equivalents',                            kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'LOANS_ADV',          full_form: 'Financial Assets - Loans',                                                      kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'ASSET_GW',           full_form: 'Goodwill',                                                                      kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'ASSET_INTANG',       full_form: 'Other Intangible Assets',                                                       kpi_type: 'assets',              denomination: 'rupee' },

  // Liabilities
  { abbr: 'TOTAL_LIAB',         full_form: 'Total Liabilities',                                                             kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'NONCURR_LIAB',       full_form: 'Total Non-Current Liabilities',                                                 kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'DEBT_LT',            full_form: 'Long-Term Borrowings',                                                          kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'DTL',                full_form: 'Deferred Tax Liabilities (Net)',                                                 kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'PROV_LT',            full_form: 'Long-Term Provisions',                                                          kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'CURR_LIAB',          full_form: 'Total Current Liabilities',                                                     kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'DEBT_ST',            full_form: 'Short-Term Borrowings',                                                         kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'TRADE_PAY',          full_form: 'Trade Payables',                                                                kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'OTH_LIAB_CURR',      full_form: 'Other Current Liabilities',                                                    kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'PROV_ST',            full_form: 'Short-Term Provisions',                                                         kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'TOTAL_FIN_LIAB',     full_form: 'Total Financial Liabilities',                                                   kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'TOTAL_NONFIN_LIAB',  full_form: 'Total Non-Financial Liabilities',                                               kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'DEBT_NONCURR',       full_form: 'Financial Liabilities - Borrowings',                                            kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'OTHER_FIN_LIAB',     full_form: 'Other Financial Liabilities',                                                   kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'PROVISIONS',         full_form: 'Provisions',                                                                    kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'OTHER_NONFIN_LIAB',  full_form: 'Other Non-Financial Liabilities',                                               kpi_type: 'liabilities',         denomination: 'rupee' },

  // Equity
  { abbr: 'NET_WORTH',          full_form: 'Total Equity / Net Worth',                                                      kpi_type: 'equity',              denomination: 'rupee' },
  { abbr: 'EQ_SHARE_CAP',       full_form: 'Equity Share Capital',                                                          kpi_type: 'equity',              denomination: 'rupee' },
  { abbr: 'RES_SURPLUS',        full_form: 'Other Equity / Reserves and Surplus',                                           kpi_type: 'equity',              denomination: 'rupee' },
  { abbr: 'SHARE_WARRANTS',     full_form: 'Money Received Against Share Warrants',                                         kpi_type: 'equity',              denomination: 'rupee' },
  { abbr: 'MINORITY_INT',       full_form: 'Non-Controlling Interests / Minority Interest',                                 kpi_type: 'equity',              denomination: 'rupee' },

  // Revenue
  { abbr: 'TOTAL_INCOME',       full_form: 'Total Income',                                                                  kpi_type: 'revenue',             denomination: 'rupee' },
  { abbr: 'REV_OP',             full_form: 'Revenue from Operations',                                                       kpi_type: 'revenue',             denomination: 'rupee' },
  { abbr: 'OTH_INC',            full_form: 'Other Income',                                                                  kpi_type: 'revenue',             denomination: 'rupee' },

  // COGS
  { abbr: 'TOTAL_COGS',         full_form: 'Total Cost of Goods Sold',                                                      kpi_type: 'cogs',                denomination: 'rupee' },
  { abbr: 'COST_MAT',           full_form: 'Cost of Materials Consumed',                                                    kpi_type: 'cogs',                denomination: 'rupee' },
  { abbr: 'PURCH_STOCK',        full_form: 'Purchases of Stock-in-Trade',                                                   kpi_type: 'cogs',                denomination: 'rupee' },
  { abbr: 'INV_CHG',            full_form: 'Changes in Inventories of Finished Goods, WIP and Stock-in-Trade',             kpi_type: 'cogs',                denomination: 'rupee' },
  { abbr: 'FIN_COST',           full_form: 'Finance Costs / Interest Expense',                                              kpi_type: 'cogs',                denomination: 'rupee' },

  // Operating expenses
  { abbr: 'TOTAL_OPEX',         full_form: 'Total Operating Expenses',                                                      kpi_type: 'operating_expenses',  denomination: 'rupee' },
  { abbr: 'EMP_EXP',            full_form: 'Employee Benefit Expense',                                                      kpi_type: 'operating_expenses',  denomination: 'rupee' },
  { abbr: 'DEP_AMORT',          full_form: 'Depreciation and Amortisation',                                                 kpi_type: 'operating_expenses',  denomination: 'rupee' },
  { abbr: 'OTH_EXP',            full_form: 'Other Expenses',                                                                kpi_type: 'operating_expenses',  denomination: 'rupee' },
  { abbr: 'PROV_CONT',          full_form: 'Provisions and Contingencies',                                                  kpi_type: 'operating_expenses',  denomination: 'rupee' },

  // Profit lines
  { abbr: 'TOTAL_TAX_EXP',      full_form: 'Total Tax Expense',                                                             kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'PBT_PRE_EXC',        full_form: 'Profit Before Exceptional Items and Tax',                                       kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'EXC_ITEMS',          full_form: 'Exceptional Items',                                                             kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'PBT',                full_form: 'Profit Before Tax',                                                             kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'TAX_EXP',            full_form: 'Tax Expense',                                                                   kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'PAT',                full_form: 'Profit After Tax',                                                              kpi_type: 'profit_lines',        denomination: 'rupee' },

  // Cashflow
  { abbr: 'NET_CASH_CHANGE',    full_form: 'Net Change in Cash and Cash Equivalents',                                       kpi_type: 'cashflow',            denomination: 'rupee' },
  { abbr: 'CFO',                full_form: 'Cash Flow from Operating Activities',                                           kpi_type: 'cashflow',            denomination: 'rupee' },
  { abbr: 'CFI',                full_form: 'Cash Flow from Investing Activities',                                           kpi_type: 'cashflow',            denomination: 'rupee' },
  { abbr: 'CFF',                full_form: 'Cash Flow from Financing Activities',                                           kpi_type: 'cashflow',            denomination: 'rupee' },
];

// ─── Seed function ────────────────────────────────────────────────────────────

async function seed() {
  console.log('Seeding KPI table...');
  let inserted = 0, failed = 0;

  for (const kpi of QE_KPIS) {
    try {
      await prisma.kpi.upsert({
        where:  { abbr: kpi.abbr },
        update: {},
        create: { ...kpi, source: 'QE' },
      });
      inserted++;
    } catch (err) {
      console.error(`Failed to seed ${kpi.abbr}:`, err.message);
      failed++;
    }
  }
  console.log(`QE KPIs: ${inserted} upserted, ${failed} failed`);
  console.log('Seeding complete.');
}

seed()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
