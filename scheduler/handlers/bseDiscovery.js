'use strict';

/**
 * BSE Discovery handler — runs on Server 2.
 *
 * Flow:
 *   1. Scrape BSE API for all companies → classified URL groups
 *   2. Resolve each URL: download PDF, detect cover letters, extract embedded URLs
 *      - 404 / timeout (propagation delay for same-day filings) → keep BSE URL as-is
 *      - Cover letter with extractable URL → store BSE URL + extracted URL
 *      - Actual document → store BSE URL
 *   3. Upsert into bse_discovered_urls (array dedup via UNNEST+DISTINCT)
 *
 * Principle: never drop a URL. All BSE URLs are always preserved; extraction
 * only adds candidates. Unresolved URLs are flagged for manual resolution.
 *
 * Monitoring (Server 1) reads bse_discovered_urls from the shared DB.
 */

const { randomUUID }         = require('crypto');
const prisma                 = require('../../config/prisma');
const { scrapeAllCompanies } = require('../../services/bseScraper.service');
const { resolveUrlArray }    = require('../../services/bseResolver.service');

async function resolveGroup(group) {
  const [transcript, ppt, annual] = await Promise.all([
    resolveUrlArray(group.transcript_urls),
    resolveUrlArray(group.ppt_urls),
    resolveUrlArray(group.annual_report_urls),
  ]);
  return {
    ...group,
    transcript_urls:    transcript.urls,
    ppt_urls:           ppt.urls,
    annual_report_urls: annual.urls,
    _meta:              { ...transcript.meta, ...ppt.meta, ...annual.meta },
  };
}

// Upsert per-URL metadata (page count / size / status) captured during
// resolution. Never downgrades a previously 'resolved' row: a later lookback
// re-scrape where the CDN briefly 404s (status 'pending', null counts) must not
// wipe good data — COALESCE keeps existing non-null counts, and status only
// ever climbs to 'resolved'.
async function upsertUrlMeta(meta) {
  const entries = Object.entries(meta);
  for (const [url, m] of entries) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO bse_url_meta (url, page_count, file_size, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (url) DO UPDATE SET
         page_count = COALESCE(EXCLUDED.page_count, bse_url_meta.page_count),
         file_size  = COALESCE(EXCLUDED.file_size,  bse_url_meta.file_size),
         status     = CASE WHEN EXCLUDED.status = 'resolved' OR bse_url_meta.status = 'resolved'
                           THEN 'resolved' ELSE EXCLUDED.status END,
         updated_at = NOW()`,
      url, m.page_count, m.file_size, m.status,
    );
  }
}

async function run(config = {}) {
  const lookbackDays = config.lookback_days ?? 1;
  console.log(`[bse-discovery] Starting — lookback=${lookbackDays}d`);

  const groups = await scrapeAllCompanies(lookbackDays);

  if (!groups.length) {
    console.log('[bse-discovery] No new documents found');
    return { records_processed: 0, companies: 0, total_urls: 0 };
  }

  console.log(`[bse-discovery] Resolving URLs for ${groups.length} companies...`);

  let upserted  = 0;
  let totalUrls = 0;

  for (const raw of groups) {
    // Resolve cover letters and extract embedded URLs — sequential per company,
    // parallel across the three doc types within a company
    const g = await resolveGroup(raw);

    await prisma.$executeRawUnsafe(
      `INSERT INTO bse_discovered_urls
         (id, scrip_cd, company_name, scrape_date,
          transcript_urls, ppt_urls, annual_report_urls,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2, $3, $4::date,
          $5::text[], $6::text[], $7::text[],
          NOW(), NOW())
       ON CONFLICT (scrip_cd, scrape_date) DO UPDATE SET
         company_name       = EXCLUDED.company_name,
         transcript_urls    = ARRAY(SELECT DISTINCT UNNEST(
                                bse_discovered_urls.transcript_urls    || EXCLUDED.transcript_urls)),
         ppt_urls           = ARRAY(SELECT DISTINCT UNNEST(
                                bse_discovered_urls.ppt_urls           || EXCLUDED.ppt_urls)),
         annual_report_urls = ARRAY(SELECT DISTINCT UNNEST(
                                bse_discovered_urls.annual_report_urls || EXCLUDED.annual_report_urls)),
         updated_at         = NOW()`,
      randomUUID(),
      g.scrip_cd,
      g.company_name,
      g.scrape_date,
      g.transcript_urls,
      g.ppt_urls,
      g.annual_report_urls,
    );

    await upsertUrlMeta(g._meta);

    upserted++;
    totalUrls += g.transcript_urls.length + g.ppt_urls.length + g.annual_report_urls.length;
  }

  console.log(`[bse-discovery] Done — ${upserted} companies, ${totalUrls} total URLs stored`);
  return { records_processed: upserted, companies: upserted, total_urls: totalUrls };
}

module.exports = { run };
