'use strict';

/**
 * Backfill company_name and basic_industry on earnings_calls rows where either
 * field is null, using the NSE symbol → osc_identity.csv mapping.
 *
 * Only updates rows where at least one field is missing; never overwrites
 * non-null values.
 *
 * Run: node scripts/backfillCompanyMeta.js [--dry-run]
 */

const fs     = require('fs');
const path   = require('path');
const prisma = require('../config/prisma');

const DRY_RUN = process.argv.includes('--dry-run');

function parseIdentityMap(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').slice(1).filter(Boolean);
  const map = new Map(); // nse_symbol → { company_name, basic_industry }
  for (const line of lines) {
    const fields = line.split('","');
    const company_name   = fields[0]?.replace(/^"/, '').trim();
    const basic_industry = fields[24]?.trim();
    const nse_symbol     = fields[25]?.trim();
    if (nse_symbol && company_name) {
      map.set(nse_symbol, { company_name, basic_industry: basic_industry || null });
    }
  }
  return map;
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const identityPath = path.join(__dirname, '../lib/osc_identity.csv');
  const identityMap  = parseIdentityMap(identityPath);
  console.log(`osc_identity entries loaded: ${identityMap.size}`);

  // Load only rows that need backfill
  const rows = await prisma.earnings_calls.findMany({
    where:  { OR: [{ company_name: null }, { basic_industry: null }] },
    select: { id: true, company: true, company_name: true, basic_industry: true },
  });
  console.log(`Rows needing backfill: ${rows.length}`);

  let matched = 0, unmatched = 0, skipped = 0;
  const updates = [];

  for (const row of rows) {
    const meta = identityMap.get(row.company);
    if (!meta) { unmatched++; continue; }

    const newName     = row.company_name   ?? meta.company_name;
    const newIndustry = row.basic_industry ?? meta.basic_industry;

    // Nothing to change if both are already set
    if (newName === row.company_name && newIndustry === row.basic_industry) { skipped++; continue; }

    matched++;
    updates.push({ id: row.id, company_name: newName, basic_industry: newIndustry });
  }

  console.log(`  Matched in osc_identity: ${matched}`);
  console.log(`  No match in osc_identity: ${unmatched}`);
  console.log(`  Already complete (skipped): ${skipped}`);

  if (DRY_RUN) {
    console.log('\nSample updates (first 5):');
    updates.slice(0, 5).forEach(u => console.log(' ', u.id, '|', u.company_name, '|', u.basic_industry));
    console.log('\nDry run complete — no changes made.');
    return;
  }

  const BATCH = 50;
  let done = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    await prisma.$transaction(
      batch.map(u => prisma.earnings_calls.update({
        where: { id: u.id },
        data:  { company_name: u.company_name, basic_industry: u.basic_industry },
      }))
    );
    done += batch.length;
    process.stdout.write(`\rUpdated: ${done}/${updates.length}`);
  }
  console.log('');
  console.log('\nDone.');
  console.log(`  Updated: ${done}`);
  console.log(`  No osc_identity match (left null): ${unmatched}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
