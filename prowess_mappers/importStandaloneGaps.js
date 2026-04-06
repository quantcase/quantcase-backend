'use strict';

/**
 * prowess_mappers/importStandaloneGaps.js
 *
 * Inserts standalone CSV rows ONLY for companies that are absent from
 * prowess_values_new (i.e. not covered by the consolidated import).
 * Safe to re-run — duplicates are skipped via ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   node prowess_mappers/importStandaloneGaps.js            # verify only
 *   node prowess_mappers/importStandaloneGaps.js --insert   # write to DB
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { parse }        = require('csv-parse/sync');
const { PrismaClient } = require('@prisma/client');

const prisma    = new PrismaClient();
const DO_INSERT = process.argv.includes('--insert');
const TABLE_NAME = 'prowess_values_new';

const STANDALONE_CSVS = [
  path.join(__dirname, '../tmp/Mar2024_annual.csv'),
  path.join(__dirname, '../tmp/Mar2025_annual.csv'),
];

// ─── reuse same logic as importProwessNew ─────────────────────────────────────

const CSV_UNIT_MAP     = { 'Rs. Crore': 'Cr', '(%)': '%', 'Times': 'x', 'Indian Rupee': 'Rs' };
const UNIT_MULTIPLIER  = { Cr: 10_000_000, '%': 1, x: 1, Rs: 1 };

const SNAPSHOT_ABBRS = new Set([
  'TOTAL_ASSETS','NONCURR_ASSETS','ASSET_PPE','ASSET_CWIP','INV_NONCURR','LOANS_NONCURR',
  'OTH_ASSET_NC','BANK_BAL_OTHER','CURR_ASSETS','INVENTORY','INV_CURR','TRADE_RECV',
  'CASH_EQUIV','LOANS_CURR','ASSET_LAND_NET','ASSET_MINING_NET','ASSET_BIO_NET',
  'ASSET_LEASE_IMP_NET','ASSET_BLDG_NET','ASSET_LAND_GRS','ASSET_PM_NET','ASSET_IT_NET',
  'ASSET_ELEC_NET','ASSET_PM_GRS','ASSET_TRANS_NET','ASSET_FURN_NET',
  'TOTAL_LIAB','NONCURR_LIAB','DEBT_LT','DTL','PROV_LT','CURR_LIAB','DEBT_ST',
  'TRADE_PAY','OTH_LIAB_CURR','PROV_ST','EQ_SHARE_CAP','NET_WORTH',
  'ASSET_GW','ASSET_INTANG','DEP_TOTAL','BORR_TOTAL','LOAN_ADV_TOTAL','INV_BV_TOTAL','WORKING_FUNDS',
]);

const STATEMENT_MAP = {
  TOTAL_INCOME:'pnl', OTH_INC:'pnl', TOTAL_COGS:'pnl', COST_MAT:'pnl', PURCH_STOCK:'pnl',
  INV_CHG:'pnl', TOTAL_OPEX:'pnl', EMP_EXP:'pnl', FIN_COST:'pnl', DEP_AMORT:'pnl',
  OTH_EXP:'pnl', PROV_CONT:'pnl', PBT_PRE_EXC:'pnl', EXC_ITEMS:'pnl', PBT:'pnl',
  TAX_EXP:'pnl', PAT:'pnl', EPS_BASIC:'pnl', EPS_DILUTED:'pnl', NIM_PCT:'pnl', REV_OP:'pnl',
  TOTAL_ASSETS:'balance_sheet', NONCURR_ASSETS:'balance_sheet', ASSET_PPE:'balance_sheet',
  ASSET_CWIP:'balance_sheet', INV_NONCURR:'balance_sheet', LOANS_NONCURR:'balance_sheet',
  OTH_ASSET_NC:'balance_sheet', BANK_BAL_OTHER:'balance_sheet', CURR_ASSETS:'balance_sheet',
  INVENTORY:'balance_sheet', INV_CURR:'balance_sheet', TRADE_RECV:'balance_sheet',
  CASH_EQUIV:'balance_sheet', LOANS_CURR:'balance_sheet', TOTAL_LIAB:'balance_sheet',
  NONCURR_LIAB:'balance_sheet', DEBT_LT:'balance_sheet', DTL:'balance_sheet',
  PROV_LT:'balance_sheet', CURR_LIAB:'balance_sheet', DEBT_ST:'balance_sheet',
  TRADE_PAY:'balance_sheet', OTH_LIAB_CURR:'balance_sheet', PROV_ST:'balance_sheet',
  EQ_SHARE_CAP:'balance_sheet', NET_WORTH:'balance_sheet', ASSET_GW:'balance_sheet',
  ASSET_INTANG:'balance_sheet', DEP_TOTAL:'balance_sheet', BORR_TOTAL:'balance_sheet',
  LOAN_ADV_TOTAL:'balance_sheet', INV_BV_TOTAL:'balance_sheet', WORKING_FUNDS:'balance_sheet',
  CFO:'cashflow', CFI:'cashflow', CFF:'cashflow', NET_CASH_CHANGE:'cashflow',
  ASSET_LAND_NET:'balance_sheet', ASSET_MINING_NET:'balance_sheet', ASSET_BIO_NET:'balance_sheet',
  ASSET_LEASE_IMP_NET:'balance_sheet', ASSET_BLDG_NET:'balance_sheet', ASSET_LAND_GRS:'balance_sheet',
  ASSET_PM_NET:'balance_sheet', ASSET_IT_NET:'balance_sheet', ASSET_ELEC_NET:'balance_sheet',
  ASSET_PM_GRS:'balance_sheet', ASSET_TRANS_NET:'balance_sheet', ASSET_FURN_NET:'balance_sheet',
};

const BASE_COL_MAP = {
  'Total income': 'TOTAL_INCOME', 'Other miscellaneous and irregular income': 'OTH_INC',
  'Cost of goods sold': 'TOTAL_COGS', 'Raw materials, stores & spares': 'COST_MAT',
  'Purchase of finished goods': 'PURCH_STOCK', 'Change in stock': 'INV_CHG',
  'Total expenses': 'TOTAL_OPEX', 'Compensation to employees': 'EMP_EXP',
  'Financial services expenses': 'FIN_COST', 'Amortisation': 'DEP_AMORT',
  'Expenses other than Depreciation, Interest, Taxes, Provisions and Amortizations': 'OTH_EXP',
  'Net profit before tax and extra ordinary items': 'PBT_PRE_EXC',
  'Extra-ordinary expenses': 'EXC_ITEMS', 'PBT': 'PBT',
  'Provision for direct tax': 'TAX_EXP', 'Profit after tax (PAT)': 'PAT',
  'Eps basic, AS 20': 'EPS_BASIC', 'Eps diluted, AS 20': 'EPS_DILUTED',
  'Provisions for NPAs': 'PROV_CONT', 'Net Interest Margin (NIM) (%)': 'NIM_PCT',
  'Total assets': 'TOTAL_ASSETS', 'Non-current assets': 'NONCURR_ASSETS',
  'Net goodwill': 'ASSET_GW', 'Net other intangible assets': 'ASSET_INTANG',
  'Net property, plant and equipment': 'ASSET_PPE',
  'CWIP & Intangible assets under development (net of impairment)': 'ASSET_CWIP',
  'Long term investments': 'INV_NONCURR', 'Total long term loans & advances': 'LOANS_NONCURR',
  'Other long term assets': 'OTH_ASSET_NC', 'Long term bank balance': 'BANK_BAL_OTHER',
  'Current assets (incl. short term investments, loans & advances)': 'CURR_ASSETS',
  'Short term investments': 'INV_CURR', 'Short term inventories': 'INVENTORY',
  'Short term trade receivables & bills receivable': 'TRADE_RECV',
  'Cash & Bank balance (short term)': 'CASH_EQUIV',
  'Total short term loans & advances': 'LOANS_CURR',
  'Total liabilities excluding Capital & Reserves': 'TOTAL_LIAB',
  'Non-current liabilities': 'NONCURR_LIAB',
  'Long term borrowings excl current portion': 'DEBT_LT',
  'Deferred tax liability': 'DTL', 'Long term provisions': 'PROV_LT',
  'Current liabilities': 'CURR_LIAB', 'Short-term borrowings': 'DEBT_ST',
  'Short term trade payables and acceptances': 'TRADE_PAY',
  'Other current liabilities': 'OTH_LIAB_CURR',
  'Provisions outstanding (short term)': 'PROV_ST',
  'Paid up equity capital (net of forfeited equity capital)': 'EQ_SHARE_CAP',
  'Net worth': 'NET_WORTH',
  'Net cash flow from operating activities': 'CFO',
  'Net cash inflow or (outflow) from investing activities': 'CFI',
  'Net cash inflow or (outflow) from financing activities': 'CFF',
  'Net cash inflow or (outflow) due to net increase or (decrease) in cash and cash equivalents': 'NET_CASH_CHANGE',
  'Working funds': 'WORKING_FUNDS', 'Deposits: Total': 'DEP_TOTAL',
  'Borrowings: Total': 'BORR_TOTAL', 'Loan advances: Total': 'LOAN_ADV_TOTAL',
  'Investment at BV: Total': 'INV_BV_TOTAL',
};

const OPTIONAL_COL_MAP = {
  'Return (cash) on capital employed': 'ROCE', 'Capital employed': 'CAP_EMP',
  'Debt to equity ratio (times)': 'DE',
  'Net land and buildings, including bearer plants': 'ASSET_LAND_NET',
  'Net mining / oil & gas properties': 'ASSET_MINING_NET',
  'Net biological assets - bearer plants': 'ASSET_BIO_NET',
  'Net leasehold improvements': 'ASSET_LEASE_IMP_NET',
  'Net buildings': 'ASSET_BLDG_NET',
  'Gross land and buildings, including bearer plants': 'ASSET_LAND_GRS',
  'Net plant & machinery, computers and electrical installations': 'ASSET_PM_NET',
  'Net computers and IT systems': 'ASSET_IT_NET',
  'Net electrical installations & fittings': 'ASSET_ELEC_NET',
  'Gross plant & machinery, computers and electrical installations': 'ASSET_PM_GRS',
  'Net transport & communication equipment and infrastructure': 'ASSET_TRANS_NET',
  'Net furniture and other fixed assets': 'ASSET_FURN_NET',
};

const REV_OP_COL_NON_FIN = 'Operating income for non-financial Cos.';
const REV_OP_COL_FIN     = 'Operating income for financial Cos.';
const COMPANY_COL = 'Company Name';
const YEAR_COL    = 'Year';
const MONTHS_COL  = 'Months';

function normalizeName(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/_+/g,'_')
    .replace(/^_|_$/g,'').slice(0,50);
}
function toIso(dateStr) {
  const [dd,mm,yyyy] = dateStr.split('-');
  if (!dd||!mm||!yyyy) return null;
  return `${yyyy}-${mm}-${dd}`;
}
function deriveFiscalYear(dateStr) {
  const [,,yyyy] = dateStr.split('-');
  return yyyy ? `FY${yyyy}` : null;
}
function startOfPeriod(endIso) {
  if (!endIso) return null;
  const d = new Date(endIso);
  d.setFullYear(d.getFullYear()-1);
  d.setDate(d.getDate()+1);
  return d.toISOString().slice(0,10);
}
function buildColMap(headers) {
  const map = {};
  for (let i=0;i<headers.length;i++) {
    const h=(headers[i]||'').trim();
    if (h&&!(h in map)) map[h]=i;
  }
  return map;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== importStandaloneGaps → ${TABLE_NAME} ===`);
  console.log(DO_INSERT ? '[INSERT MODE]\n' : '[VERIFY MODE — re-run with --insert to write to DB]\n');

  // 1. Get all companies already in DB (from consolidated import)
  const existing = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT company FROM ${TABLE_NAME}`
  );
  const existingSet = new Set(existing.map(r => r.company));
  console.log(`Companies already in DB: ${existingSet.size}`);

  const allRows = [];
  const foundCompanies = {}; // prowessName → ticker (for map output)

  for (const csvPath of STANDALONE_CSVS) {
    if (!fs.existsSync(csvPath)) { console.log(`Skipping (not found): ${csvPath}`); continue; }

    const records  = parse(fs.readFileSync(csvPath), { bom: true, relax_column_count: true });
    const headers  = records[5];
    const unitRow  = records[3];
    const dataRows = records.slice(6).filter(r => (r[0]||'').trim());
    const csvFile  = path.basename(csvPath);

    const colMap = buildColMap(headers);
    const colUnitByName = {};
    for (const [name,idx] of Object.entries(colMap)) {
      const raw = (unitRow[idx]||'').trim();
      colUnitByName[name] = CSV_UNIT_MAP[raw] ?? null;
    }

    let newCount = 0;
    for (const dataRow of dataRows) {
      const company = (dataRow[colMap[COMPANY_COL]]||'').trim();
      if (!company || existingSet.has(company)) continue; // skip already-covered

      const yearRaw = (dataRow[colMap[YEAR_COL]]||'').trim();
      const months  = (dataRow[colMap[MONTHS_COL]]||'').trim();
      if (!yearRaw || (months && months !== '12')) continue;

      const endDate    = toIso(yearRaw);
      const fiscalYear = deriveFiscalYear(yearRaw);
      if (!endDate || !fiscalYear) continue;

      const startDate = startOfPeriod(endDate);
      const callId    = `prowess_new_${normalizeName(company)}_${fiscalYear}_S`;
      foundCompanies[company] = true;
      newCount++;

      function pushRow(colName, abbr) {
        const idx = colMap[colName];
        if (idx == null) return;
        const raw = (dataRow[idx]||'').trim();
        if (!raw) return;
        const num = parseFloat(raw);
        if (isNaN(num)) return;
        const unit   = colUnitByName[colName] ?? 'Cr';
        const mult   = UNIT_MULTIPLIER[unit]  ?? 1;
        const isSnap = SNAPSHOT_ABBRS.has(abbr);
        allRows.push({
          callId, company, fiscal_year: fiscalYear, quarter: 'Q4',
          call_date: endDate, kpi_abbr: abbr,
          value:      parseFloat((num*mult).toFixed(4)),
          raw_value:  raw, unit, multiplier: mult,
          start_date: isSnap ? null : startDate,
          end_date:   endDate,
          period_type: isSnap ? 'snapshot' : 'annual',
          source: 'QE', source_path: `prowess/${csvFile}`,
          statement: STATEMENT_MAP[abbr] ?? null,
        });
      }

      for (const [colName, abbr] of Object.entries(BASE_COL_MAP)) pushRow(colName, abbr);
      for (const [colName, abbr] of Object.entries(OPTIONAL_COL_MAP)) {
        if (colName in colMap) pushRow(colName, abbr);
      }
      const revRaw =
        (dataRow[colMap[REV_OP_COL_NON_FIN]]||'').trim() ||
        (dataRow[colMap[REV_OP_COL_FIN]]||'').trim() || null;
      if (revRaw) {
        const col = (dataRow[colMap[REV_OP_COL_NON_FIN]]||'').trim()
          ? REV_OP_COL_NON_FIN : REV_OP_COL_FIN;
        pushRow(col, 'REV_OP');
      }
    }
    console.log(`${csvFile}: ${newCount} new companies found`);
  }

  // Deduplicate
  const seen = new Set();
  const finalRows = [];
  for (const row of allRows) {
    const key = `${row.callId}|${row.kpi_abbr}`;
    if (!seen.has(key)) { seen.add(key); finalRows.push(row); }
  }

  const newCompanies = Object.keys(foundCompanies).sort();
  console.log(`\nNew companies to insert (${newCompanies.length}):`);
  for (const c of newCompanies) console.log(`  ${c}`);
  console.log(`\nTotal KPI rows: ${finalRows.length}`);

  if (!DO_INSERT) {
    console.log('\n[VERIFY ONLY] Re-run with --insert to write to DB.\n');
    await prisma.$disconnect();
    return;
  }

  // Batch insert
  const batchSize = 500;
  let attempted = 0;
  const countBefore = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${TABLE_NAME}`);
  const before = countBefore[0].n;

  for (let i=0; i<finalRows.length; i+=batchSize) {
    const batch = finalRows.slice(i, i+batchSize);
    const params = [];
    const placeholders = batch.map((row, j) => {
      const b = j*16;
      params.push(
        row.callId, row.company, row.fiscal_year, row.quarter,
        row.call_date, row.kpi_abbr, row.value, row.raw_value,
        row.unit, row.multiplier, row.start_date, row.end_date,
        row.period_type, row.source, row.source_path, row.statement,
      );
      return `(gen_random_uuid(),$${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14}::"KpiSource",$${b+15},$${b+16},NOW(),NOW())`;
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TABLE_NAME} (id,call_id,company,fiscal_year,quarter,call_date,kpi_abbr,value,raw_value,unit,multiplier,start_date,end_date,period_type,source,source_path,statement,created_at,updated_at)
       VALUES ${placeholders.join(',\n')}
       ON CONFLICT ON CONSTRAINT pnv_call_kpi_unique DO NOTHING`,
      ...params
    );
    attempted += batch.length;
    process.stdout.write(`  Progress: ${attempted}/${finalRows.length}\r`);
  }

  const countAfter = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM ${TABLE_NAME}`);
  const inserted = countAfter[0].n - before;
  console.log(`\n✓ Attempted ${attempted} rows — ${inserted} actually inserted (${attempted-inserted} skipped as duplicates)`);
  console.log(`\nAdd these to prowessResolver.js TICKER_MAP:`);
  for (const c of newCompanies) console.log(`  // ${c}`);

  await prisma.$disconnect();
}

main().catch(async err => {
  console.error('\n✗ Error:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
