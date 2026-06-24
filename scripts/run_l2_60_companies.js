'use strict';

const BASE_URL = process.env.API_URL || 'http://localhost:8000';

const TARGET_TICKERS = [
  'NMDC', 'MOIL', 'GRAVITA',
  'BAJAJ-AUTO', 'TVSMOTOR', 'EICHERMOT',
  'ASIANPAINT', 'BERGEPAINT', 'KANSAINER',
  'RELIANCE', 'IOC', 'BPCL',
  'HATSUN', 'HERITGFOOD', 'PARAGMILK',
  'DABUR', 'GODREJCP', 'COLPAL',
  'HDFCAMC', 'NAM-INDIA', 'UTIAMC',
  'SBIN', 'BANKBARODA', 'CANBK',
  'BAJFINANCE', 'SHRIRAMFIN', 'CHOLAFIN',
  'APOLLOHOSP', 'MAXHEALTH', 'FORTIS',
  'HAL', 'BEL', 'BDL',
  'CUMMINSIND', 'KSB', 'KIRLOSBROS',
  'MAZDOCK', 'COCHINSHIP', 'SWANDEF',
  'TCS', 'INFY', 'HCLTECH',
  'SCI', 'GESHIP', 'TRANSWORLD',
  'BHARTIARTL', 'TATACOMM', 'TTML',
  'INDUSTOWER', 'HFCL', 'VINDHYATEL',
  'TATAPOWER', 'ADANIPOWER', 'TORNTPOWER',
  'WABAG', 'IONEXCHANG', 'JITFINFRA',
  'HDFCBANK', 'AXISBANK', 'IDBI',
  'INDIGOPNTS', 'MSUMI', 'IEX',
];

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

async function runBatch(tasks) {
  const results = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const chunk = tasks.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(chunk.map(({ slug, ticker }) => enqueue(slug, ticker)));
    results.push(...settled);
    const done = Math.min(i + CONCURRENCY, tasks.length);
    process.stdout.write(`\r  Queued ${done}/${tasks.length}...`);
    if (done < tasks.length) await sleep(DELAY_MS);
  }
  return results;
}

async function main() {
  console.log(`Skills: ${TARGET_SKILLS.join(', ')}\n`);

  const tasks = [];
  for (const ticker of TARGET_TICKERS) {
    for (const slug of TARGET_SKILLS) {
      tasks.push({ slug, ticker });
    }
  }

  console.log(`Queuing ${tasks.length} jobs (${TARGET_TICKERS.length} tickers × ${TARGET_SKILLS.length} skills)...\n`);
  const results = await runBatch(tasks);
  console.log('\n');

  const failed = results.filter(r => !r.ok);
  const queued = results.filter(r => r.ok);

  console.log(`Done.`);
  console.log(`  Queued:  ${queued.length}`);
  console.log(`  Failed:  ${failed.length}`);

  if (failed.length) {
    console.log('\nFailed jobs:');
    for (const f of failed) console.log(`  ${f.ticker} / ${f.slug} — ${f.error}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
