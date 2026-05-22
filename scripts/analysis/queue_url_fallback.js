#!/usr/bin/env node
'use strict';

/**
 * Queue calls that were skipped by queue_remaining.js because they had no
 * transcript_text / ppt_text, but DO have a transcript_url or ppt_url that the
 * API's URL-fallback path can fetch at job time.
 *
 * Mirrors the analyze_L1_all.js cap of 12 calls per company (latest by
 * fiscal_year desc, quarter desc) to avoid processing stale history.
 *
 * Excludes calls that already have at least one valid signal in extracted_signals.
 *
 * Usage:
 *   node scripts/analysis/queue_url_fallback.js               # dry-run (shows count)
 *   node scripts/analysis/queue_url_fallback.js --dispatch
 *   node scripts/analysis/queue_url_fallback.js --dispatch --base-url http://localhost:9000
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const args     = process.argv.slice(2);
const dispatch = args.includes('--dispatch');
const buIdx    = args.indexOf('--base-url');
const baseUrl  = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';

const STAGGER_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJob(callId) {
  const url = `${baseUrl}/api/calls/${callId}/summarize`;
  try {
    const res  = await fetch(url, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`  [OK]  ${callId}  jobId=${body.job?.id ?? 'n/a'}`);
    } else {
      console.warn(`  [${res.status}] ${callId}  ${JSON.stringify(body)}`);
    }
  } catch (err) {
    console.error(`  [ERR] ${callId}  ${err.message}`);
  }
}

const CALLS_PER_COMPANY = 12;

async function main() {
  // Single query: latest 12 URL-only calls per company, excluding already-extracted ones.
  //
  // ROW_NUMBER() partitions by company and orders by fiscal_year desc, quarter desc so
  // we keep the most recent calls. The NOT EXISTS subquery replaces the two-step
  // "fetch covered IDs then filter in JS" approach.
  const rows = await prisma.$queryRaw`
    WITH ranked AS (
      SELECT
        ec.id,
        ec.company,
        ec.company_name,
        ec.fiscal_year,
        ec.quarter,
        ec.basic_industry,
        ROW_NUMBER() OVER (
          PARTITION BY ec.company
          ORDER BY ec.fiscal_year DESC, ec.quarter DESC
        ) AS rn
      FROM earnings_calls ec
      WHERE
        COALESCE(ec.transcript_text, '') = ''
        AND COALESCE(ec.ppt_text, '')     = ''
        AND (ec.transcript_url IS NOT NULL OR ec.ppt_url IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM extracted_signals es
          WHERE es.call_id = ec.id
            AND es.is_invalidated = false
        )
    )
    SELECT id, company, company_name, fiscal_year, quarter, basic_industry
    FROM ranked
    WHERE rn <= ${CALLS_PER_COMPANY}
    ORDER BY company ASC, fiscal_year ASC, quarter ASC
  `;

  const remaining = rows;

  // Count distinct companies for reporting
  const companyCount = new Set(remaining.map((r) => r.company)).size;
  console.log(`Distinct companies with URL-only calls: ${companyCount}`);
  console.log(`Total candidates (latest ${CALLS_PER_COMPANY} per company): ${remaining.length}`);
  console.log(`Remaining to dispatch:                 ${remaining.length}\n`);

  // Summary by industry
  const byIndustry = {};
  for (const c of remaining) {
    const ind = c.basic_industry || 'Unknown';
    byIndustry[ind] = (byIndustry[ind] ?? 0) + 1;
  }
  console.log('Breakdown by industry:');
  for (const [ind, count] of Object.entries(byIndustry).sort()) {
    console.log(`  ${ind.padEnd(45)} ${count}`);
  }

  if (!dispatch) {
    console.log('\n[DRY RUN] Pass --dispatch to queue these jobs.');
    return;
  }

  console.log(`\nDispatching to ${baseUrl} (${STAGGER_MS}ms stagger)...\n`);
  for (let i = 0; i < remaining.length; i++) {
    const c = remaining[i];
    if (i % 50 === 0) {
      console.log(`\n[${i + 1}/${remaining.length}] ${c.company} ${c.fiscal_year} ${c.quarter} — ${c.basic_industry}`);
    }
    await postJob(c.id);
    if (i < remaining.length - 1) await sleep(STAGGER_MS);
  }

  console.log('\nDone.\n');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
