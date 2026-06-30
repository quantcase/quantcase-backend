'use strict';

/**
 * BSE Corporate Announcements Scraper — all listed companies.
 *
 * Fetches daily announcements from the BSE public API, classifies each one
 * into transcript / ppt / annual_report using a three-layer classifier, and
 * returns grouped results ready for upserting into bse_discovered_urls.
 *
 * No auth required. If 401/403 appears, add Cookie from DevTools → Network.
 *
 * NOTE: PDF propagation delay — newly filed PDFs at AttachHis/ become accessible
 * a few hours after filing. The scraper stores the URL; the worker downloads later.
 */

const HEADERS = {
  'accept':          'application/json, text/plain, */*',
  'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'origin':          'https://www.bseindia.com',
  'referer':         'https://www.bseindia.com/',
  'user-agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

// New filings land on AttachLive/; BSE archives them to AttachHis/ after a few days.
// Always build with AttachLive/ — the resolver falls back to AttachHis/ for older docs.
const ATTACHMENT_BASE_URL    = 'https://www.bseindia.com/xml-data/corpfiling/AttachLive/';
const ATTACHMENT_ARCHIVE_URL = 'https://www.bseindia.com/xml-data/corpfiling/AttachHis/';
const SLEEP_BETWEEN_PAGES_MS = 300;

// ── Classifier ────────────────────────────────────────────────────────────────

const TRANSCRIPT_RE = /transcript|earnings[\s\-]?call|conference[\s\-]?call/i;
const PPT_RE        = /investor[\s\-]?pres|earnings[\s\-]?pres|investor[\s\-]?presentation/i;
const ANNUAL_RE     = /annual[\s\-]?report/i;
// Signal that a doc actually exists (vs a plain meeting notice)
const OUTCOME_RE    = /outcome|enclosed|transcript|recording|attached|presentation|find attach/i;

function isIntimation(row) {
  const news = row.NEWSSUB || '';
  const hl   = row.HEADLINE || '';
  // Only exclude when BSE explicitly tagged it Intimation AND headline has no doc signal
  return news.endsWith('- Intimation') && !OUTCOME_RE.test(hl);
}

function classifyRow(row) {
  const sub  = (row.SUBCATNAME || '').trim();
  const news = (row.NEWSSUB    || '').trim();
  const hl   = (row.HEADLINE   || '').trim();
  const text = hl + ' ' + news;

  // L1 — subcategory direct mapping (most reliable)
  if (sub === 'Reg. 34 (1) Annual Report') return 'annual_report';
  if (sub === 'Investor Presentation')      return 'ppt';

  // L1 — Analyst/Investor Meet: keep unless explicitly flagged as Intimation with no doc signal
  if (sub === 'Analyst / Investor Meet') {
    if (isIntimation(row)) return null;
    return TRANSCRIPT_RE.test(text) ? 'transcript' : 'ppt';
  }

  // L2 — broad regex fallback (catches General / AGM / Financial Results etc.)
  // False positives are filtered downstream by the resolver (file size / PDF text)
  if (TRANSCRIPT_RE.test(text)) return 'transcript';
  if (ANNUAL_RE.test(text))     return 'annual_report';
  if (PPT_RE.test(text))        return 'ppt';

  return null;
}

// ── API fetch ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// BSE API requires strPrevDate === strToDate (same date both params).
// Multi-day ranges return empty results. Scrape each date separately.
async function fetchPage(page, date) {
  const url =
    `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w` +
    `?pageno=${page}&strCat=-1&strPrevDate=${date}&strScrip=&strSearch=P` +
    `&strToDate=${date}&strType=C&subcategory=-1`;

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`BSE API HTTP ${res.status} on page ${page} date ${date}`);
  return res.json();
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Scrape all BSE-listed companies for the given lookback window.
 * Iterates one API call per calendar day (BSE API doesn't support date ranges).
 *
 * Returns an array of grouped objects, one per (scrip_cd, scrape_date) pair:
 * { scrip_cd, company_name, scrape_date, transcript_urls[], ppt_urls[], annual_report_urls[] }
 */
async function scrapeAllCompanies(lookbackDays = 1) {
  // Build list of dates to scrape (today going back lookbackDays)
  const dates = [];
  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    dates.push(formatDate(d));
  }

  console.log(`[bse-scraper] Fetching all companies for dates: ${dates.join(', ')}`);

  const grouped         = new Map(); // key: `${scrip_cd}::${date}`
  const seenAttachments = new Set(); // dedup same PDF filed under multiple subcategories

  function processRows(rows) {
    for (const row of rows) {
      if (!row.ATTACHMENTNAME) continue;
      if (seenAttachments.has(row.ATTACHMENTNAME)) continue;

      const type = classifyRow(row);
      if (!type) continue;

      seenAttachments.add(row.ATTACHMENTNAME);

      const url        = ATTACHMENT_BASE_URL + row.ATTACHMENTNAME;
      const scrapeDate = (row.NEWS_DT || row.DT_TM || '').slice(0, 10);
      if (!scrapeDate) continue;

      const key = `${row.SCRIP_CD}::${scrapeDate}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          scrip_cd:           row.SCRIP_CD,
          company_name:       row.SLONGNAME || '',
          scrape_date:        scrapeDate,
          transcript_urls:    [],
          ppt_urls:           [],
          annual_report_urls: [],
        });
      }

      const entry = grouped.get(key);
      const arr   = type === 'transcript'    ? entry.transcript_urls
                  : type === 'ppt'           ? entry.ppt_urls
                  : entry.annual_report_urls;
      if (!arr.includes(url)) arr.push(url);
    }
  }

  for (const date of dates) {
    try {
      const firstData  = await fetchPage(1, date);
      const firstRows  = firstData.Table || [];
      const totalPages = firstRows[0]?.TotalPageCnt ?? 0;

      if (!totalPages) {
        console.log(`[bse-scraper] ${date}: no data`);
        continue;
      }

      console.log(`[bse-scraper] ${date}: ${totalPages} pages`);
      processRows(firstRows);

      for (let page = 2; page <= totalPages; page++) {
        await sleep(SLEEP_BETWEEN_PAGES_MS);
        const data = await fetchPage(page, date);
        processRows(data.Table || []);
      }
    } catch (err) {
      console.error(`[bse-scraper] ${date} error: ${err.message}`);
    }

    if (dates.indexOf(date) < dates.length - 1) await sleep(500); // gap between dates
  }

  const results   = [...grouped.values()];
  const totalUrls = results.reduce(
    (s, g) => s + g.transcript_urls.length + g.ppt_urls.length + g.annual_report_urls.length, 0,
  );
  console.log(`[bse-scraper] ${results.length} companies, ${totalUrls} URLs discovered`);
  return results;
}

module.exports = { scrapeAllCompanies, ATTACHMENT_BASE_URL, ATTACHMENT_ARCHIVE_URL };
