'use strict';

/**
 * Import concall rows from scripts/concalls.csv into earnings_calls.
 *
 * Strategy:
 * - Only process document_type === 'concall' rows.
 * - Derive fiscal_year and quarter from call_date (Indian FY: Apr-Mar).
 * - Group by company+fiscal_year+quarter; merge multiple CSV rows per group
 *   by preferring the row that has both transcript+ppt URLs. When two rows
 *   both have a transcript (or both have a ppt), keep the URL from the row
 *   that has more URLs overall (more complete filing).
 * - For existing DB rows: overwrite transcript_url and ppt_url with CSV values
 *   (if CSV has them).
 * - For new rows: insert with derived fiscal_year, quarter, call_date.
 * - ID format: {COMPANY}_{FY}_{Q}  (same as existing rows).
 *
 * Run: node scripts/importConcalls.js [--dry-run]
 */

const fs      = require('fs');
const path    = require('path');
const prisma  = require('../config/prisma');
const { randomUUID } = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  Jan: { q: 'Q3', fyOffset: 0 }, Feb: { q: 'Q3', fyOffset: 0 }, Mar: { q: 'Q4', fyOffset: 0 },
  Apr: { q: 'Q4', fyOffset: 0 }, May: { q: 'Q4', fyOffset: 0 }, Jun: { q: 'Q1', fyOffset: 1 },
  Jul: { q: 'Q1', fyOffset: 1 }, Aug: { q: 'Q1', fyOffset: 1 }, Sep: { q: 'Q2', fyOffset: 1 },
  Oct: { q: 'Q2', fyOffset: 1 }, Nov: { q: 'Q2', fyOffset: 1 }, Dec: { q: 'Q3', fyOffset: 1 },
};

function deriveQuarterFY(callDate) {
  if (!callDate) return null;
  const [mon, yr] = callDate.trim().split(' ');
  const year = parseInt(yr, 10);
  const m = MONTH_MAP[mon];
  if (!m || isNaN(year)) return null;
  return { quarter: m.q, fiscal_year: 'FY' + (year + m.fyOffset) };
}

// Score a row by completeness — higher = prefer this row's URLs when conflict
function rowScore(row) {
  return (row.transcriptUrl ? 2 : 0) + (row.pptUrl ? 1 : 0);
}

// Merge multiple CSV rows for the same company+FY+Q into one record.
// For each URL type, pick the URL from the highest-scoring row that has it.
function mergeRows(rows) {
  // Sort descending by completeness so the best row is first
  const sorted = [...rows].sort((a, b) => rowScore(b) - rowScore(a));
  const merged = { transcriptUrl: '', pptUrl: '', callDate: sorted[0].callDate };
  for (const r of sorted) {
    if (!merged.transcriptUrl && r.transcriptUrl) merged.transcriptUrl = r.transcriptUrl;
    if (!merged.pptUrl && r.pptUrl) merged.pptUrl = r.pptUrl;
    if (merged.transcriptUrl && merged.pptUrl) break;
  }
  return merged;
}

// ─── Parse CSV ───────────────────────────────────────────────────────────────

function parseCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').slice(1).filter(Boolean);
  const groups = new Map(); // key: company|fiscal_year|quarter → rows[]

  for (const line of lines) {
    const parts = line.split(',');
    const company      = parts[1]?.trim();
    const documentType = parts[2]?.trim();
    const callDate     = parts[5]?.trim();
    const transcriptUrl = parts[6]?.trim() || '';
    const pptUrl        = parts[7]?.trim() || '';

    if (documentType !== 'concall') continue;
    if (!company || !callDate) continue;

    const derived = deriveQuarterFY(callDate);
    if (!derived) {
      console.warn(`Could not derive FY/Q from call_date "${callDate}" for ${company} — skipping`);
      continue;
    }

    const key = `${company}|${derived.fiscal_year}|${derived.quarter}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ company, callDate, fiscal_year: derived.fiscal_year, quarter: derived.quarter, transcriptUrl, pptUrl });
  }

  // Merge each group into one record
  const records = [];
  for (const [key, rows] of groups) {
    const merged = mergeRows(rows);
    const [company, fiscal_year, quarter] = key.split('|');
    records.push({ company, fiscal_year, quarter, call_date: merged.callDate, transcript_url: merged.transcriptUrl || null, ppt_url: merged.pptUrl || null });
  }

  return records;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  const csvPath = path.join(__dirname, 'concalls.csv');
  console.log('Parsing CSV...');
  const csvRecords = parseCsv(csvPath);
  console.log(`CSV concall groups (after merge): ${csvRecords.length}`);

  // Load all existing DB rows keyed by company+fiscal_year+quarter
  console.log('Loading existing DB rows...');
  const dbRows = await prisma.earnings_calls.findMany({
    select: { id: true, company: true, fiscal_year: true, quarter: true, transcript_url: true, ppt_url: true },
  });
  const dbMap = new Map(dbRows.map(r => [`${r.company}|${r.fiscal_year}|${r.quarter}`, r]));
  console.log(`DB rows loaded: ${dbRows.length}`);

  const toInsert = [];
  const toUpdate = [];

  for (const rec of csvRecords) {
    const key = `${rec.company}|${rec.fiscal_year}|${rec.quarter}`;
    const existing = dbMap.get(key);

    if (existing) {
      // Only update if CSV provides a URL for that field
      const newTranscript = rec.transcript_url || existing.transcript_url;
      const newPpt        = rec.ppt_url        || existing.ppt_url;
      const changed = newTranscript !== existing.transcript_url || newPpt !== existing.ppt_url;
      if (changed) {
        toUpdate.push({ id: existing.id, transcript_url: newTranscript, ppt_url: newPpt });
      }
    } else {
      const id = `${rec.company}_${rec.fiscal_year}_${rec.quarter}`;
      toInsert.push({ id, company: rec.company, fiscal_year: rec.fiscal_year, quarter: rec.quarter, call_date: rec.call_date, transcript_url: rec.transcript_url, ppt_url: rec.ppt_url });
    }
  }

  console.log(`\nRecords to INSERT: ${toInsert.length}`);
  console.log(`Records to UPDATE: ${toUpdate.length}`);

  if (DRY_RUN) {
    console.log('\n-- INSERT sample (first 5):');
    toInsert.slice(0, 5).forEach(r => console.log(' ', r.id, '| T:', (r.transcript_url || '-').slice(0, 60), '| P:', (r.ppt_url || '-').slice(0, 60)));
    console.log('\n-- UPDATE sample (first 5):');
    toUpdate.slice(0, 5).forEach(r => console.log(' ', r.id, '| T:', (r.transcript_url || '-').slice(0, 60), '| P:', (r.ppt_url || '-').slice(0, 60)));
    console.log('\nDry run complete — no changes made.');
    return;
  }

  // INSERT in batches of 500
  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    // Handle ID collisions (same company+FY+Q already in DB from a concurrent run) gracefully
    await prisma.earnings_calls.createMany({ data: batch, skipDuplicates: true });
    inserted += batch.length;
    process.stdout.write(`\rInserted: ${inserted}/${toInsert.length}`);
  }
  console.log('');

  // UPDATE one by one (prisma doesn't support bulk update with different values per row)
  let updated = 0;
  for (const upd of toUpdate) {
    await prisma.earnings_calls.update({
      where: { id: upd.id },
      data:  { transcript_url: upd.transcript_url, ppt_url: upd.ppt_url },
    });
    updated++;
    if (updated % 50 === 0) process.stdout.write(`\rUpdated: ${updated}/${toUpdate.length}`);
  }
  console.log(`\rUpdated: ${updated}/${toUpdate.length}`);

  console.log('\nDone.');
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Updated:  ${updated}`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
