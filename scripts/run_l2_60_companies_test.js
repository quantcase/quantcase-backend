'use strict';

const BASE_URL = process.env.API_URL || 'http://localhost:8000';
const TEST_TICKER = process.env.TICKER || 'RELIANCE';

const TARGET_SKILLS = [
  'guidance-credibility',
  'disclosure-honesty',
  'capital-allocation',
  'promoter-activity',
  'customer-distribution',
  'earnings-forecast',
];

const CONCURRENCY = 5;
const DELAY_MS    = 200;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function enqueue(slug, ticker) {
  const res = await fetch(`${BASE_URL}/api/html-skills/${slug}/run`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ticker }),
  });
  const body = await res.json();
  if (!res.ok) return { ok: false, slug, ticker, error: body.error ?? res.status };
  return { ok: true, slug, ticker, jobId: body.job?.id };
}

async function main() {
  console.log(`[TEST] Single-ticker run for: ${TEST_TICKER}`);
  console.log(`Skills: ${TARGET_SKILLS.join(', ')}\n`);

  const tasks = TARGET_SKILLS.map(slug => ({ slug, ticker: TEST_TICKER }));
  console.log(`Queuing ${tasks.length} jobs...\n`);

  const results = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const chunk = tasks.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(chunk.map(({ slug, ticker }) => enqueue(slug, ticker)));
    results.push(...settled);
    if (i + CONCURRENCY < tasks.length) await sleep(DELAY_MS);
  }

  const failed = results.filter(r => !r.ok);
  const queued = results.filter(r => r.ok);

  console.log('Results:');
  for (const r of results) {
    if (r.ok) console.log(`  ✓ ${r.slug} → job ${r.jobId}`);
    else      console.log(`  ✗ ${r.slug} → ${r.error}`);
  }

  console.log(`\nQueued: ${queued.length}  Failed: ${failed.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
