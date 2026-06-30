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
    description:     'Scrapes BSE API for new earnings transcripts and investor presentations for Nifty50 companies, upserts URLs into earnings_calls table',
    job_type:        'bse_discovery',
    cron_expression: '0 9,18 * * 1-5',  // 9am + 6pm IST weekdays
    is_active:       true,
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
