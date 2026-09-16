'use strict';

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { ProwessUploader } = require('../prowess_mappers/ProwessUploader');

const DATA_DIR = '/home/anirudh/quantcase/code/Prowess Uploaded Data';

const FILES_TO_INGEST = [
  { file: 'osc_sheet_486_StandaloneQuarterly Insurance3.csv', mode: 'quarterly', desc: 'Insurance Stand QTR FY20' },
  { file: 'osc_sheet_488_ConsolidatedQuarterly Insurance3.csv', mode: 'quarterly', desc: 'Insurance Conso QTR FY20' },
  { file: 'osc_sheet_490_ConsolidatedQuarterly BFSI3.csv', mode: 'quarterly', desc: 'BFSI Conso QTR FY20' },
  { file: 'osc_sheet_492_StandaloneQuarterly BFSI3.csv', mode: 'quarterly', desc: 'BFSI Stand QTR FY20' },
  { file: 'osc_sheet_493_ConsolidatedQTR Non BFSI1_2.csv', mode: 'quarterly', desc: 'Non-BFSI List 1 Conso QTR FY20' },
  { file: 'osc_sheet_494_StandaloneQTR Non BFSI1_2.csv', mode: 'quarterly', desc: 'Non-BFSI List 1 Stand QTR FY20' },
  { file: 'osc_sheet_495_ConsolidatedQTR Non BFSI2_2.csv', mode: 'quarterly', desc: 'Non-BFSI List 2 Conso QTR FY20' },
  { file: 'osc_sheet_496_StandaloneQTR Non BFSI2_2.csv', mode: 'quarterly', desc: 'Non-BFSI List 2 Stand QTR FY20' },
];

async function runHistoricalFY20Ingestion() {
  const prisma = new PrismaClient();
  const startTime = Date.now();

  console.log('================================================================');
  console.log('  PROWESS HISTORICAL FY2020 QUARTERLY INGESTION (8 FILES)');
  console.log('================================================================\n');

  for (const item of FILES_TO_INGEST) {
    const p = path.join(DATA_DIR, item.file);
    if (!fs.existsSync(p)) {
      throw new Error(`Required file missing: ${p}`);
    }
  }
  console.log('✓ All 8 files verified present in Prowess Uploaded Data.\n');

  let totalAttempted = 0;
  let totalInserted = 0;
  let totalSkipped = 0;

  for (let i = 0; i < FILES_TO_INGEST.length; i++) {
    const item = FILES_TO_INGEST[i];
    const filePath = path.join(DATA_DIR, item.file);
    const fileNum = i + 1;
    const progressTag = `[${String(fileNum).padStart(2, '0')}/08]`;

    console.log(`\n${progressTag} Starting ${item.desc} (${item.file}) [mode=${item.mode}]`);

    const uploader = new ProwessUploader({
      table: 'prowess_values_new',
      csvPath: filePath,
      doInsert: true,
      doClear: false, // PRESERVE ALL EXISTING RECORDS
    });

    try {
      const report = await uploader.run(item.mode);
      if (report?.insertStats) {
        totalAttempted += report.insertStats.attempted;
        totalInserted += report.insertStats.inserted;
        totalSkipped += report.insertStats.skipped;
        console.log(`${progressTag} ✓ Done: ${report.insertStats.inserted} newly inserted, ${report.insertStats.skipped} skipped (already present)`);
      }
    } catch (err) {
      console.error(`${progressTag} ✗ FAILED:`, err.message);
      throw err;
    }
  }

  const durationMin = ((Date.now() - startTime) / 60000).toFixed(2);
  console.log('\n================================================================');
  console.log('  HISTORICAL FY2020 INGESTION COMPLETED');
  console.log('================================================================');
  console.log(`Duration          : ${durationMin} minutes`);
  console.log(`Total Attempted   : ${totalAttempted}`);
  console.log(`Newly Inserted    : ${totalInserted}`);
  console.log(`Skipped/Duplicate : ${totalSkipped}`);

  const [{ count: finalCount }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM prowess_values_new`
  );
  console.log(`Total rows in prowess_values_new: ${finalCount}`);

  // Summary by quarter for FY2020
  console.log('\nFY2020 Quarterly breakdown in DB:');
  const q20Counts = await prisma.$queryRawUnsafe(
    `SELECT quarter, source_type, COUNT(*)::int as count 
     FROM prowess_values_new 
     WHERE fiscal_year = 'FY2020' AND call_id LIKE 'prowess_qtr_%'
     GROUP BY quarter, source_type 
     ORDER BY quarter, source_type`
  );
  console.table(q20Counts);

  await prisma.$disconnect();
}

runHistoricalFY20Ingestion().catch((err) => {
  console.error('Fatal ingestion error:', err);
  process.exit(1);
});
