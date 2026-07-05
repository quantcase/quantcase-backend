'use strict';

const prisma = require('../config/prisma');
const {
  suggestFiscalYearQuarter, loadCompanyTickerMap, matchCompanyTicker, approveCandidate,
} = require('../services/bseDiscoveryApproval.service');

const SLUG = 'bse-discovery';

// Scraping + PDF resolution is heavy (network + pdf.js) and runs on the
// scheduler process (Server 2), not here. This process only talks to it over
// the scheduler's internal HTTP API — same convention as notifyScheduler()
// in admin.scheduler.controller.js.
const SCHEDULER_PORT = parseInt(process.env.SCHEDULER_PORT ?? '8001', 10);
const SCHEDULER_HOST = process.env.SCHEDULER_HOST || '127.0.0.1';

// POST /admin/bse-discovery/run — fire-and-forget trigger on Server 2
const triggerRun = async (req, res, next) => {
  try {
    const resp = await fetch(`http://${SCHEDULER_HOST}:${SCHEDULER_PORT}/trigger/${SLUG}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ config: req.body?.config ?? {} }),
      signal:  AbortSignal.timeout(5000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json({ success: true, message: 'BSE discovery triggered', ...data });
  } catch (err) {
    res.status(502).json({ error: `Scheduler process unreachable at ${SCHEDULER_HOST}:${SCHEDULER_PORT} — ${err.message}` });
  }
};

// GET /admin/bse-discovery/runs — run history (reads shared DB, no Server 2 call needed)
const getRuns = async (req, res, next) => {
  try {
    const job = await prisma.schedulerJob.findUnique({ where: { slug: SLUG }, select: { id: true } });
    if (!job) return res.status(404).json({ error: 'Scheduler job not found' });

    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    const runs = await prisma.schedulerRun.findMany({
      where:   { job_id: job.id },
      orderBy: { started_at: 'desc' },
      take:    limit,
    });
    res.json({ count: runs.length, runs });
  } catch (err) {
    next(err);
  }
};

// GET /admin/bse-discovery/urls?days=14 — flattens bse_discovered_urls'
// array columns into one row per URL, with suggested company/fiscal_year/
// quarter for the admin to confirm or override on approve.
const listUrls = async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days ?? '14', 10), 90);

    const rows = await prisma.$queryRaw`
      SELECT scrip_cd, company_name, scrape_date, 'transcript' AS doc_type, unnest(transcript_urls) AS url
      FROM bse_discovered_urls WHERE scrape_date >= (CURRENT_DATE - ${days}::int)
      UNION ALL
      SELECT scrip_cd, company_name, scrape_date, 'ppt' AS doc_type, unnest(ppt_urls) AS url
      FROM bse_discovered_urls WHERE scrape_date >= (CURRENT_DATE - ${days}::int)
      UNION ALL
      SELECT scrip_cd, company_name, scrape_date, 'annual_report' AS doc_type, unnest(annual_report_urls) AS url
      FROM bse_discovered_urls WHERE scrape_date >= (CURRENT_DATE - ${days}::int)
      ORDER BY scrape_date DESC, company_name ASC
    `;

    const companyTickerMap = await loadCompanyTickerMap();

    const urls = rows.map(r => {
      const { fiscal_year, quarter } = suggestFiscalYearQuarter(r.scrape_date);
      return {
        scrip_cd:     r.scrip_cd,
        company_name: r.company_name,
        scrape_date:  r.scrape_date,
        doc_type:     r.doc_type,
        url:          r.url,
        source:       r.url.includes('bseindia.com') ? 'bse_original' : 'resolved',
        suggested: {
          company:     matchCompanyTicker(companyTickerMap, r.company_name),
          fiscal_year,
          quarter: r.doc_type === 'annual_report' ? null : quarter,
        },
      };
    });

    res.json({ count: urls.length, urls });
  } catch (err) {
    next(err);
  }
};

// POST /admin/bse-discovery/approve
// body: { docType, url, company, fiscal_year, quarter?, call_date? }
const approve = async (req, res, next) => {
  try {
    const { docType, url, company, fiscal_year, quarter, call_date } = req.body ?? {};
    const record = await approveCandidate({ docType, url, company, fiscal_year, quarter, call_date });
    res.json({ success: true, record });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
};

module.exports = { triggerRun, getRuns, listUrls, approve };
