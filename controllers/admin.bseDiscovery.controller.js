'use strict';

const prisma = require('../config/prisma');
const {
  suggestFiscalYearQuarter, loadCompanyTickerMap, matchCompanyTicker, loadExistingUrls, approveCandidate,
} = require('../services/bseDiscoveryApproval.service');
const { fetchBuffer, extractPdfPageText } = require('../services/bseResolver.service');
const { TtlCache } = require('../services/pipelineDispatch/cache');

const SLUG = 'bse-discovery';

// Raw PDF bytes, keyed by candidate URL — lets an admin page through 1→2→3
// of the same document (GET .../preview?url=&page=N) without re-downloading
// it on every page turn. Short TTL: this is just absorbing one review
// session, not meant to serve stale content once a doc is re-scraped.
const previewBufferCache  = new TtlCache();
const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000;

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

// GET /admin/bse-discovery/urls?days=14&hideApproved=false
// Flattens bse_discovered_urls' array columns into one row per URL, with:
//   - suggested company/fiscal_year/quarter for the admin to confirm/override
//   - alreadyApproved: whether this exact URL is already stored on
//     earnings_calls/annual_reports (fixes it silently reappearing forever
//     with no way to tell it was already handled)
//   - existingUrl/willOverwrite: what's currently in that (company,
//     fiscal_year, quarter) slot, if anything, so approving doesn't silently
//     clobber a different document
// PDF content preview is deliberately NOT bundled here (was, briefly — see
// git history) — downloading+parsing every not-yet-approved candidate's PDF
// on every list call didn't scale and a fixed paragraph-count snippet mostly
// showed BSE letterhead boilerplate. Use GET .../preview?url=&page= on-demand
// per-row instead (paginated by real PDF page).
const listUrls = async (req, res, next) => {
  try {
    const days          = Math.min(parseInt(req.query.days ?? '14', 10), 90);
    const hideApproved  = req.query.hideApproved === 'true';

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

    let urls = rows.map(r => {
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

    // ── alreadyApproved: does this exact URL already sit in earnings_calls/annual_reports? ──
    const candidateUrls = urls.map(u => u.url);
    const approvedUrlSet = new Set();
    if (candidateUrls.length) {
      const [ecRows, arRows] = await Promise.all([
        prisma.earnings_calls.findMany({
          where:  { OR: [{ transcript_url: { in: candidateUrls } }, { ppt_url: { in: candidateUrls } }] },
          select: { transcript_url: true, ppt_url: true },
        }),
        prisma.annual_reports.findMany({
          where:  { annual_report_url: { in: candidateUrls } },
          select: { annual_report_url: true },
        }),
      ]);
      for (const r of ecRows) {
        if (r.transcript_url) approvedUrlSet.add(r.transcript_url);
        if (r.ppt_url)        approvedUrlSet.add(r.ppt_url);
      }
      for (const r of arRows) {
        if (r.annual_report_url) approvedUrlSet.add(r.annual_report_url);
      }
    }
    for (const u of urls) u.alreadyApproved = approvedUrlSet.has(u.url);

    if (hideApproved) urls = urls.filter(u => !u.alreadyApproved);

    // ── existingUrl / willOverwrite: what's currently in that slot, via suggested fields ──
    const transcriptPptKeySet = new Map();
    const annualReportKeySet  = new Map();
    for (const u of urls) {
      if (!u.suggested.company) continue;
      if (u.doc_type === 'annual_report') {
        annualReportKeySet.set(`${u.suggested.company}|${u.suggested.fiscal_year}`, { company: u.suggested.company, fiscal_year: u.suggested.fiscal_year });
      } else if (u.suggested.quarter) {
        transcriptPptKeySet.set(`${u.suggested.company}|${u.suggested.fiscal_year}|${u.suggested.quarter}`, { company: u.suggested.company, fiscal_year: u.suggested.fiscal_year, quarter: u.suggested.quarter });
      }
    }
    const { transcriptPptMap, annualReportMap } = await loadExistingUrls({
      transcriptPptKeys: [...transcriptPptKeySet.values()],
      annualReportKeys:  [...annualReportKeySet.values()],
    });

    for (const u of urls) {
      let existingUrl = null;
      if (u.suggested.company) {
        if (u.doc_type === 'annual_report') {
          existingUrl = annualReportMap.get(`${u.suggested.company}|${u.suggested.fiscal_year}`) ?? null;
        } else if (u.suggested.quarter) {
          const slot = transcriptPptMap.get(`${u.suggested.company}|${u.suggested.fiscal_year}|${u.suggested.quarter}`);
          existingUrl = (u.doc_type === 'transcript' ? slot?.transcript_url : slot?.ppt_url) ?? null;
        }
      }
      u.existingUrl   = existingUrl;
      u.willOverwrite = !!existingUrl && existingUrl !== u.url;
    }

    res.json({ count: urls.length, urls });
  } catch (err) {
    next(err);
  }
};

// GET /admin/bse-discovery/preview?url=<candidateUrl>&page=1
// On-demand, single-document PDF text preview, paginated by real PDF page —
// lets the admin page past a letterhead/cover page instead of being stuck
// with a fixed snippet. Only ever downloads the one document being reviewed
// (not the whole candidate list), and caches the raw bytes briefly so paging
// 1→2→3 through the same doc doesn't re-download it each time.
const previewDocument = async (req, res, next) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const page = Math.max(parseInt(req.query.page ?? '1', 10) || 1, 1);

    const buf = await previewBufferCache.wrap(url, PREVIEW_CACHE_TTL_MS, () => fetchBuffer(url));
    const { text, page: resolvedPage, totalPages } = await extractPdfPageText(buf, page);

    res.json({ url, page: resolvedPage, totalPages, text });
  } catch (err) {
    res.status(502).json({ error: `Could not preview PDF: ${err.message}` });
  }
};

// POST /admin/bse-discovery/approve
// body: { docType, url, company, fiscal_year, quarter?, call_date? }
const approve = async (req, res, next) => {
  try {
    const { docType, url, company, fiscal_year, quarter, call_date } = req.body ?? {};
    const record = await approveCandidate({ docType, url, company, fiscal_year, quarter, call_date });
    // annual_reports.id is a Prisma BigInt (see prisma/schema.prisma), which
    // JSON.stringify can't serialize on its own — stringify it for the response.
    res.json({ success: true, record: { ...record, id: record.id?.toString?.() ?? record.id } });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
};

module.exports = { triggerRun, getRuns, listUrls, previewDocument, approve };
