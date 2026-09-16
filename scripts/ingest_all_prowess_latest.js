'use strict';

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { ProwessUploader } = require('../prowess_mappers/ProwessUploader');
const cache = require('../lib/cache');
const financials = require('../lib/financials');

const DATA_DIR = '/home/anirudh/quantcase/code/prowessLatestData';

// The 36 files organized in optimal dependency sequence
const FILES_TO_INGEST = [
  // 1. Annual Balance Sheets
  { file: 'osc_sheet_499_INS_Conso_BalanceSheet_Annual.csv', mode: 'annual', desc: 'INS Conso Balance Sheet Annual' },
  { file: 'osc_sheet_500_INS_Stand_BalanceSheet_Annual.csv', mode: 'annual', desc: 'INS Stand Balance Sheet Annual' },
  { file: 'osc_sheet_512_BFSI&NONBFSI_Conso_BalanceSheet_Annual.csv', mode: 'annual', desc: 'Combined Conso Balance Sheet Annual' },
  { file: 'osc_sheet_513_BFSI&NONBFSI_Stand_BalanceSheet_Annual.csv', mode: 'annual', desc: 'Combined Stand Balance Sheet Annual' },

  // 2. Annual Cash Flows
  { file: 'osc_sheet_531_INS_Conso_CashFlow_Annual.csv', mode: 'annual', desc: 'INS Conso Cash Flow Annual' },
  { file: 'osc_sheet_532_INS_Stand_CashFlow_Annual.csv', mode: 'annual', desc: 'INS Stand Cash Flow Annual' },
  { file: 'osc_sheet_514_BFSI&NONBFSI_Conso_CashFlow_Annual.csv', mode: 'annual', desc: 'Combined Conso Cash Flow Annual' },
  { file: 'osc_sheet_515_BFSI&NONBFSI_Stand_CashFlow_Annual.csv', mode: 'annual', desc: 'Combined Stand Cash Flow Annual' },

  // 3. Annual P&L
  { file: 'osc_sheet_497_INS_Conso_P&L_Annual.csv', mode: 'annual', desc: 'INS Conso P&L Annual' },
  { file: 'osc_sheet_498_INS_Stand_P&L_Annual.csv', mode: 'annual', desc: 'INS Stand P&L Annual' },
  { file: 'osc_sheet_505_BFSI_Conso_P&L_Annual.csv', mode: 'annual', desc: 'BFSI Conso P&L Annual' },
  { file: 'osc_sheet_506_BFSI_Stand_P&L_Annual.csv', mode: 'annual', desc: 'BFSI Stand P&L Annual' },
  { file: 'osc_sheet_516_NonBFSI_Conso_P&L_Annual_1.csv', mode: 'annual', desc: 'NonBFSI Conso P&L Annual (Part 1)' },
  { file: 'osc_sheet_517_NonBFSI_Stand_P&L_Annual_1.csv', mode: 'annual', desc: 'NonBFSI Stand P&L Annual (Part 1)' },
  { file: 'osc_sheet_518_NonBFSI_Conso_P&L_Annual_2.csv', mode: 'annual', desc: 'NonBFSI Conso P&L Annual (Part 2)' },
  { file: 'osc_sheet_519_NonBFSI_Stand_P&L_Annual_2.csv', mode: 'annual', desc: 'NonBFSI Stand P&L Annual (Part 2)' },

  // 4. Annual EPS
  { file: 'osc_sheet_481Standalone_Annual_EPS_all.csv', mode: 'annual', desc: 'All Companies Stand EPS Annual' },
  { file: 'osc_sheet_482Consolidated_Annual_EPS_all.csv', mode: 'annual', desc: 'All Companies Conso EPS Annual' },

  // 5. Quarterly P&L
  { file: 'osc_sheet_501_INS_Conso_P&L_QTR_1.csv', mode: 'quarterly', desc: 'INS Conso P&L QTR 1' },
  { file: 'osc_sheet_502_INS_Conso_P&L_QTR_2.csv', mode: 'quarterly', desc: 'INS Conso P&L QTR 2' },
  { file: 'osc_sheet_503_INS_Stand_P&L_QTR_1.csv', mode: 'quarterly', desc: 'INS Stand P&L QTR 1' },
  { file: 'osc_sheet_504_INS_Stand_P&L_QTR_2.csv', mode: 'quarterly', desc: 'INS Stand P&L QTR 2' },
  { file: 'osc_sheet_507_BFSI_Conso_P&L_QTR_1.csv', mode: 'quarterly', desc: 'BFSI Conso P&L QTR 1' },
  { file: 'osc_sheet_508_BFSI_Conso_P&L_QTR_2.csv', mode: 'quarterly', desc: 'BFSI Conso P&L QTR 2' },
  { file: 'osc_sheet_509_BFSI_Stand_P&L_QTR_1.csv', mode: 'quarterly', desc: 'BFSI Stand P&L QTR 1' },
  { file: 'osc_sheet_510_BFSI_Stand_P&L_QTR_2.csv', mode: 'quarterly', desc: 'BFSI Stand P&L QTR 2' },
  { file: 'osc_sheet_520_NonBFSI_Conso_P&L_QTR_1_1.csv', mode: 'quarterly', desc: 'NonBFSI Conso P&L QTR (Part 1.1)' },
  { file: 'osc_sheet_521_NonBFSI_Conso_P&L_QTR_1_2.csv', mode: 'quarterly', desc: 'NonBFSI Conso P&L QTR (Part 1.2)' },
  { file: 'osc_sheet_522_NonBFSI_Stand_P&L_QTR_1_1.csv', mode: 'quarterly', desc: 'NonBFSI Stand P&L QTR (Part 1.1)' },
  { file: 'osc_sheet_524_NonBFSI_Conso_P&L_QTR_2_1.csv', mode: 'quarterly', desc: 'NonBFSI Conso P&L QTR (Part 2.1)' },
  { file: 'osc_sheet_525_NonBFSI_Conso_P&L_QTR_2_2.csv', mode: 'quarterly', desc: 'NonBFSI Conso P&L QTR (Part 2.2)' },
  { file: 'osc_sheet_526_NonBFSI_Stand_P&L_QTR_2_1.csv', mode: 'quarterly', desc: 'NonBFSI Stand P&L QTR (Part 2.1)' },
  { file: 'osc_sheet_527_NonBFSI_Stand_P&L_QTR_1_2.csv', mode: 'quarterly', desc: 'NonBFSI Stand P&L QTR (Part 1.2)' },
  { file: 'osc_sheet_528_NonBFSI_Stand_P&L_QTR_2_2.csv', mode: 'quarterly', desc: 'NonBFSI Stand P&L QTR (Part 2.2)' },

  // 6. Quarterly EPS
  { file: 'osc_sheet_479Standalone_QTR_EPS_all.csv', mode: 'quarterly', desc: 'All Companies Stand EPS QTR' },
  { file: 'osc_sheet_480Consolidated_QTR_EPS_all.csv', mode: 'quarterly', desc: 'All Companies Conso EPS QTR' },
];

async function runFullIngestion() {
  const prisma = new PrismaClient();
  const startTime = Date.now();

  console.log('================================================================');
  console.log('  PROWESS MASTER INGESTION PIPELINE (36 FILES)');
  console.log('================================================================\n');

  // Verify all 36 files exist
  console.log('Checking files in', DATA_DIR, '...');
  for (const item of FILES_TO_INGEST) {
    const p = path.join(DATA_DIR, item.file);
    if (!fs.existsSync(p)) {
      throw new Error(`Required file missing: ${p}`);
    }
  }
  console.log('✓ All 36 files verified present.\n');

  // Step 1: Clean old data from prowess_values_new
  console.log('--- Step 1: Cleaning existing records in prowess_values_new ---');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE prowess_values_new');
  console.log('✓ TRUNCATE completed. prowess_values_new is now empty.\n');

  // Step 2: Ingest each file sequentially
  console.log('--- Step 2: Ingesting 36 CSV files ---');
  let totalAttempted = 0;
  let totalInserted = 0;
  let totalSkipped = 0;

  for (let i = 0; i < FILES_TO_INGEST.length; i++) {
    const item = FILES_TO_INGEST[i];
    const filePath = path.join(DATA_DIR, item.file);
    const fileNum = i + 1;
    const progressTag = `[${String(fileNum).padStart(2, '0')}/36]`;

    console.log(`\n${progressTag} Starting ${item.desc} (${item.file}) [mode=${item.mode}]`);

    const uploader = new ProwessUploader({
      table: 'prowess_values_new',
      csvPath: filePath,
      doInsert: true,
      doClear: false, // CRITICAL: NEVER clear per file!
    });

    const report = await uploader.run(item.mode);
    const attempted = report.insertStats ? report.insertStats.attempted : report.totalRows;
    const inserted = report.insertStats ? report.insertStats.inserted : report.totalRows;
    const skipped = report.insertStats ? report.insertStats.skipped : 0;

    totalAttempted += attempted;
    totalInserted += inserted;
    totalSkipped += skipped;

    console.log(`${progressTag} ✓ Done: ${inserted.toLocaleString()} inserted (${skipped.toLocaleString()} dupes skipped)`);
  }

  const elapsedMins = ((Date.now() - startTime) / 60000).toFixed(2);
  console.log('\n================================================================');
  console.log(`✓ All 36 files successfully ingested in ${elapsedMins} minutes!`);
  console.log(`  Total attempted: ${totalAttempted.toLocaleString()}`);
  console.log(`  Total inserted : ${totalInserted.toLocaleString()}`);
  console.log(`  Total skipped  : ${totalSkipped.toLocaleString()}`);
  console.log('================================================================\n');

  // Step 3: Clear Redis Cache
  console.log('--- Step 3: Clearing Redis Stock Cache ---');
  try {
    const deletedFinKeys = await cache.delByPattern('qc:stock:*:financials:*');
    console.log(`✓ Deleted ${deletedFinKeys} financial cache keys from Redis.`);
    const deletedInfoKeys = await cache.delByPattern('qc:stock:*:info');
    console.log(`✓ Deleted ${deletedInfoKeys} info cache keys from Redis.`);
  } catch (err) {
    console.warn('Notice: Redis deletion encountered an issue (will rely on TTL / manual flush):', err.message);
  }

  // Step 4: Verification
  console.log('\n--- Step 4: Verifying Ingested Data in prowess_values_new ---');
  const summaryByPeriod = await prisma.$queryRawUnsafe(
    `SELECT period_type, source_type, count(*)::int as count FROM prowess_values_new GROUP BY period_type, source_type ORDER BY period_type, source_type`
  );
  console.log('Row counts by period and source type:');
  console.table(summaryByPeriod);

  const testTickers = ['HDFCBANK', 'YESBANK', 'SBIN', 'BAJFINANCE', '20MICRONS', 'HDFCLIFE'];
  console.log(`\nSpot-checking sample tickers: ${testTickers.join(', ')} ...`);
  for (const sym of testTickers) {
    try {
      const data = await financials.analyze(sym);
      const periods = data.periods || [];
      const pnlRows = (data.tables && data.tables.pnl && data.tables.pnl.rows) ? data.tables.pnl.rows.length : 0;
      const epsRow = data.tables && data.tables.pnl && data.tables.pnl.rows ? data.tables.pnl.rows.find(r => r.key === 'EPS_BASIC' || r.key === 'EPS_AFTER_EXTRA' || (r.label && r.label.toLowerCase().includes('eps'))) : null;
      const bsRows = (data.tables && data.tables.balance_sheet && data.tables.balance_sheet.rows) ? data.tables.balance_sheet.rows.length : 0;
      const cfRows = (data.tables && data.tables.cashflow && data.tables.cashflow.rows) ? data.tables.cashflow.rows.length : 0;

      const epsPopulated = epsRow && epsRow.series && epsRow.series.some(v => v !== null && v !== undefined && v !== '');

      console.log(`  ✓ ${sym.padEnd(12)}: ${periods.length} periods | P&L: ${pnlRows} rows (EPS: ${epsPopulated ? 'YES' : 'NO'}) | BS: ${bsRows} rows | CF: ${cfRows} rows`);
    } catch (err) {
      console.log(`  ✗ ${sym.padEnd(12)}: Error generating financials: ${err.message}`);
    }
  }

  console.log('\nMaster ingestion pipeline finished successfully!');
  await prisma.$disconnect();
}

runFullIngestion().catch(e => {
  console.error('FATAL INGESTION ERROR:', e);
  process.exit(1);
});
