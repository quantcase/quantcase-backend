'use strict';

require('dotenv').config();
const prisma = require('../config/prisma');

const JOBS = [
  {
    slug:            'prowess-ohlcv-daily',
    name:            'Prowess OHLCV Daily',
    description:     'Fetches daily OHLCV price data from Prowess API and upserts into nse_equity_new',
    job_type:        'prowess_ohlcv',
    cron_expression: '0 16 * * 1-5',   // 4pm IST weekdays (after NSE market close)
    is_active:       false,             // off until Prowess API is wired up
    config:          { lookback_days: 1 },
  },
  {
    slug:            'prowess-daily-batch',
    name:            'Prowess Daily Batch (SendBatch)',
    description:     'Submits the checked-in daily_ohlcv.bt template via the CMIE Batch API (SendBatch). Submission only -- resolve/ingest the token via the admin frontend\'s per-batch refresh, or by enabling prowess-batch-poll.',
    job_type:        'prowess_daily_batch',
    cron_expression: '0 16 * * 1-5',   // 4pm IST weekdays (after NSE market close) -- editable by admin
    is_active:       false,             // manual-only until admin opts into auto via PUT /admin/scheduler-jobs/prowess-daily-batch
    config:          {},
  },
  {
    slug:            'prowess-quarterly-filings',
    name:            'Prowess Quarterly Filings',
    description:     'Fetches quarterly financial data (P&L, balance sheet, cashflow) from Prowess API',
    job_type:        'prowess_quarterly',
    cron_expression: '0 6 * * *',       // 6am IST daily
    is_active:       false,
    config:          { lookback_days: 7 },
  },
  {
    slug:            'prowess-annual-filings',
    name:            'Prowess Annual Filings',
    description:     'Fetches annual consolidated + standalone financials from Prowess API',
    job_type:        'prowess_annual',
    cron_expression: '0 7 * * 0',       // 7am IST Sunday
    is_active:       false,
    config:          { lookback_days: 30 },
  },
  {
    slug:            'bse-discovery',
    name:            'BSE Document Discovery',
    description:     'Scrapes BSE API for new earnings transcripts, investor presentations, and annual reports, upserts URLs into bse_discovered_urls for admin review. Manual only — admin-triggered via POST /admin/bse-discovery/run, never cron-fires.',
    job_type:        'bse_discovery',
    cron_expression: '0 9 * * 1-5',     // 9am IST weekdays; kept for reference; inactive since discovery now requires admin approval before URLs reach earnings_calls/annual_reports
    is_active:       false,
    config:          { lookback_days: 1 },
  },
  {
    slug:            'pipeline-dispatch',
    name:            'Pipeline Dispatch (L1 Trigger)',
    description:     'Checks for earnings_calls and annual_reports with URLs but no transcript_signals_v2 entries, dispatches L1 summarization jobs for new documents',
    job_type:        'pipeline_dispatch',
    cron_expression: '30 9,18 * * 1-5', // 30 min after BSE discovery runs
    is_active:       true,
    config:          { sources: ['transcript', 'ppt', 'annual_report'], limit: null, force: false },
  },
  {
    slug:            'pipeline-dispatch-l1-multi',
    name:            'Pipeline Dispatch — L1 Multi (manual)',
    description:     'Admin-triggered L1 dispatch (transcript/ppt/annual report) for a chosen ticker set. Manual only — never cron-fires.',
    job_type:        'pipeline_dispatch_l1_multi',
    cron_expression: '0 0 1 1 *', // inert placeholder — is_active:false means it's never registered
    is_active:       false,
    config:          {}, // defaults come from services/pipelineDispatch/targetTickers.js
  },
  {
    slug:            'pipeline-dispatch-l2-multi',
    name:            'Pipeline Dispatch — L2 Multi (manual)',
    description:     'Admin-triggered html-incremental-skill dispatch for a chosen ticker set, one run per ticker. Manual only — never cron-fires.',
    job_type:        'pipeline_dispatch_l2_multi',
    cron_expression: '0 0 1 1 *', // inert placeholder — is_active:false means it's never registered
    is_active:       false,
    config:          {}, // slug/groupSlug/tickers etc. always come from the admin trigger body
  },
  {
    slug:            'pipeline-dispatch-l2-compressed-multi',
    name:            'Pipeline Dispatch — L2 Compressed Multi (manual)',
    description:     'Admin-triggered html-compressed-skill dispatch for a chosen ticker set, one run per ticker. Manual only — never cron-fires.',
    job_type:        'pipeline_dispatch_l2_compressed_multi',
    cron_expression: '0 0 1 1 *', // inert placeholder — is_active:false means it's never registered
    is_active:       false,
    config:          {},
  },
  {
    slug:            'pipeline-dispatch-l3-multi',
    name:            'Pipeline Dispatch — L3 Multi (manual)',
    description:     'Admin-triggered post-html-analysis (L3 management/opportunity/deal, or L4 summary) dispatch for a chosen ticker set, one call per ticker fanning out to every requested type. Manual only — never cron-fires.',
    job_type:        'pipeline_dispatch_l3_multi',
    cron_expression: '0 0 1 1 *', // inert placeholder — is_active:false means it's never registered
    is_active:       false,
    config:          {}, // layerId/types/groupSlug/tickers etc. always come from the admin trigger body
  },
];

async function main() {
  console.log(`Seeding ${JOBS.length} scheduler jobs...\n`);

  for (const job of JOBS) {
    const existing = await prisma.schedulerJob.findUnique({ where: { slug: job.slug } });
    if (existing) {
      console.log(`  SKIP  ${job.slug} (already exists)`);
      continue;
    }
    await prisma.schedulerJob.create({ data: job });
    console.log(`  CREATE ${job.slug}`);
  }

  console.log('\nDone.');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
