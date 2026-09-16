'use strict';

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { ProwessUploader } = require('../prowess_mappers/ProwessUploader');
const cache = require('../lib/cache');

const CSV_FILE = '/home/anirudh/quantcase/code/osc_sheet_534_Peer Table Data Set(1).csv';

async function main() {
  const prisma = new PrismaClient();
  const startTime = Date.now();

  console.log('================================================================');
  console.log('  PROWESS PEER DATASET INGESTION PIPELINE (osc_sheet_534)');
  console.log('================================================================\n');

  if (!fs.existsSync(CSV_FILE)) {
    throw new Error(`Required file missing: ${CSV_FILE}`);
  }
  console.log(`✓ CSV file verified present: ${CSV_FILE}\n`);

  const [{ count: beforeTotal }] = await prisma.$queryRawUnsafe(
    'SELECT count(*)::int as count FROM prowess_values_new'
  );
  console.log(`Initial rows in prowess_values_new: ${beforeTotal.toLocaleString()}`);

  const uploader = new ProwessUploader({
    table: 'prowess_values_new',
    csvPath: CSV_FILE,
    doInsert: true,
    doClear: false, // CRITICAL: NEVER clear existing rows!
    sourceType: 'S',
  });

  console.log('\n--- Step 1: Running quarterly ingestion ---');
  const report = await uploader.run('quarterly');
  const attempted = report.insertStats ? report.insertStats.attempted : report.totalRows;
  const inserted = report.insertStats ? report.insertStats.inserted : report.totalRows;
  const skipped = report.insertStats ? report.insertStats.skipped : 0;

  console.log(`\n✓ Ingestion complete:`);
  console.log(`  Attempted : ${attempted.toLocaleString()}`);
  console.log(`  Inserted  : ${inserted.toLocaleString()}`);
  console.log(`  Skipped   : ${skipped.toLocaleString()}`);

  const [{ count: afterTotal }] = await prisma.$queryRawUnsafe(
    'SELECT count(*)::int as count FROM prowess_values_new'
  );
  console.log(`\nNew total rows in prowess_values_new: ${afterTotal.toLocaleString()} (+${(afterTotal - beforeTotal).toLocaleString()})`);

  console.log('\n--- Step 2: Clearing Redis Cache for Peers ---');
  try {
    const deletedPeerKeys = await cache.delByPattern('qc:stock:*:peers');
    console.log(`✓ Deleted ${deletedPeerKeys} peer cache keys from Redis.`);
    const deletedIndKeys = await cache.delByPattern('qc:peers:industry:*');
    console.log(`✓ Deleted ${deletedIndKeys} industry peer cache keys from Redis.`);
  } catch (err) {
    console.warn('Notice: Redis deletion encountered an issue:', err.message);
  }

  console.log('\n--- Step 3: Verifying KPI row counts in prowess_values_new ---');
  const kpisToCheck = [
    'PEG_OVERVIEW', 'ROA_OVERVIEW', 'PRICE_BOOK_OVERVIEW', 'PAT_OVERVIEW',
    'CFO_PAT_OVERVIEW', 'RES_SURPLUS', 'DEBT_OVERVIEW', 'ROCE_OVERVIEW', 'ROCE',
    'IND_PE_OVERVIEW', 'EV_OVERVIEW', 'CASH_OVERVIEW', 'DIV_RATE'
  ];
  const kpiCounts = await prisma.$queryRawUnsafe(
    `SELECT kpi_abbr, count(*)::int as count FROM prowess_values_new WHERE kpi_abbr IN (${kpisToCheck.map(k => `'${k}'`).join(',')}) GROUP BY kpi_abbr ORDER BY count DESC`
  );
  console.table(kpiCounts);

  const elapsedMins = ((Date.now() - startTime) / 60000).toFixed(2);
  console.log(`\n✓ Ingestion pipeline finished in ${elapsedMins} minutes.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal ingestion error:', err);
  process.exit(1);
});
