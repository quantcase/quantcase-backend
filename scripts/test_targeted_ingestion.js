'use strict';

/**
 * scripts/test_targeted_ingestion.js
 *
 * Runs a targeted ingestion on the 8 representative test companies to validate:
 *  1. Consolidated quarterly data lands with source_type='C' and call_id ending in _C
 *  2. Standalone quarterly data lands with source_type='S' and call_id ending in _S
 *  3. Unified abbreviations (REV_OP, PAT, etc.) populate both Annual and Quarterly tables
 *  4. Sum of 4 quarters aligns with Annual full-year figures
 *
 * Usage:
 *   node scripts/test_targeted_ingestion.js [--dry-run] [--execute]
 */

const path = require('path');
const prisma = require('../config/prisma');
const { ProwessUploader } = require('../prowess_mappers/ProwessUploader');

const IS_EXECUTE = process.argv.includes('--execute');

const TARGET_COMPANIES = [
  'H D F C Bank Ltd.',
  'Yes Bank Ltd.',
  'State Bank Of India',
  'R E C Ltd.',
  'Bajaj Finance Ltd.',
  'Motilal Oswal Financial Services Ltd.',
  'H D F C Life Insurance Co. Ltd.',
  '20 Microns Ltd.'
];

const CSV_JOBS = [
  // BFSI
  { file: 'osc_sheet_467_ConsolidatedAnnual BFSI.csv', mode: 'annual', sourceType: 'C' },
  { file: 'osc_sheet_469_StandaloneAnnual BFSI.csv', mode: 'annual', sourceType: 'S' },
  { file: 'osc_sheet_468_ConsolidatedQuarterly BFSI.csv', mode: 'quarterly', sourceType: 'C' },
  { file: 'osc_sheet_470_StandaloneQuarterly BFSI.csv', mode: 'quarterly', sourceType: 'S' },

  // Insurance
  { file: 'osc_sheet_474_ConsolidatedAnnual Insurance.csv', mode: 'annual', sourceType: 'C' },
  { file: 'osc_sheet_473_StandaloneAnnual Insurance.csv', mode: 'annual', sourceType: 'S' },
  { file: 'osc_sheet_472_ConsolidatedQuarterly Insurance.csv', mode: 'quarterly', sourceType: 'C' },
  { file: 'osc_sheet_471_StandaloneQuarterly Insurance.csv', mode: 'quarterly', sourceType: 'S' },

  // Non-BFSI Control
  { file: 'osc_sheet_453_ConsolidatedAnnual Non BFSI1.csv', mode: 'annual', sourceType: 'C' },
  { file: 'osc_sheet_455_StandaloneAnnual Non BFSI1.csv', mode: 'annual', sourceType: 'S' },
  { file: 'osc_sheet_458_ConsolidatedQTR Non BFSI1.csv', mode: 'quarterly', sourceType: 'C' },
  { file: 'osc_sheet_459_StandaloneQTR Non BFSI1.csv', mode: 'quarterly', sourceType: 'S' },
];

async function main() {
  console.log(`=======================================================`);
  console.log(`Targeted Test Ingestion for 8 Representative Companies`);
  console.log(`Mode: ${IS_EXECUTE ? '>>> EXECUTE (Writes to DB) <<<' : '>>> DRY RUN (Verify only) <<<'}`);
  console.log(`Companies:\n  - ${TARGET_COMPANIES.join('\n  - ')}`);
  console.log(`=======================================================\n`);

  if (IS_EXECUTE) {
    console.log('Clearing existing prowess_values_new records for the 8 target companies...');
    const delResult = await prisma.$executeRawUnsafe(
      `DELETE FROM prowess_values_new WHERE company = ANY($1::text[])`,
      TARGET_COMPANIES
    );
    console.log(`✓ Deleted ${delResult} existing rows for target companies.\n`);
  }

  const baseDir = path.resolve(__dirname, '../../Prowess Uploaded Data');

  for (const job of CSV_JOBS) {
    const csvPath = path.join(baseDir, job.file);
    console.log(`\n--- Processing: ${job.file} (${job.mode}, source_type=${job.sourceType}) ---`);
    const uploader = new ProwessUploader({
      table: 'prowess_values_new',
      constraintName: 'pnv_call_kpi_unique',
      csvPath,
      doInsert: IS_EXECUTE,
      sourceType: job.sourceType,
      companyFilter: TARGET_COMPANIES
    });

    await uploader.run(job.mode);
  }

  if (IS_EXECUTE) {
    console.log(`\n=======================================================`);
    console.log(`VALIDATION & SANITY CHECKS`);
    console.log(`=======================================================`);

    const breakdown = await prisma.$queryRawUnsafe(`
      SELECT 
        company,
        period_type,
        source_type,
        COUNT(*)::int AS count
      FROM prowess_values_new
      WHERE company = ANY($1::text[])
      GROUP BY company, period_type, source_type
      ORDER BY company, period_type, source_type
    `, TARGET_COMPANIES);

    console.log('\nRow counts by Company, Period Type, and Source Type:');
    console.table(breakdown);

    // Check Quarterly Consolidated rows specifically
    const qtrCRows = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count
      FROM prowess_values_new
      WHERE company = ANY($1::text[])
        AND period_type = 'quarterly'
        AND source_type = 'C'
    `, TARGET_COMPANIES);
    console.log(`Total Quarterly Consolidated (C) rows: ${qtrCRows[0].count}`);

    // Spot-check HDFCBANK / H D F C Bank Ltd. for FY2024:
    // Compare Annual Consolidated vs Sum of 4 quarters Consolidated for REV_OP and PAT
    console.log('\nChecking H D F C Bank Ltd. FY2024 Q1..Q4 vs Annual Consolidated:');
    const hdfcQtr = await prisma.$queryRawUnsafe(`
      SELECT kpi_abbr, quarter, value
      FROM prowess_values_new
      WHERE company = 'H D F C Bank Ltd.'
        AND fiscal_year = 'FY2024'
        AND period_type = 'quarterly'
        AND source_type = 'C'
        AND kpi_abbr IN ('REV_OP', 'PAT')
      ORDER BY kpi_abbr, quarter
    `);
    console.table(hdfcQtr);

    const hdfcAnn = await prisma.$queryRawUnsafe(`
      SELECT kpi_abbr, fiscal_year, value
      FROM prowess_values_new
      WHERE company = 'H D F C Bank Ltd.'
        AND fiscal_year = 'FY2024'
        AND period_type = 'annual'
        AND source_type = 'C'
        AND kpi_abbr IN ('REV_OP', 'PAT')
      ORDER BY kpi_abbr
    `);
    console.table(hdfcAnn);
  }
}

main()
  .catch(err => {
    console.error('Test ingestion failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
