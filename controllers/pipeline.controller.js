'use strict';

const prisma = require('../config/prisma');

// GET /api/pipeline/coverage?from=A&to=B
// Returns per-company breakdown of transcript, ppt, and annual_report L1 status.
async function getCoverage(req, res, next) {
  try {
    let { from, to } = req.query;

    if (!from) return res.status(400).json({ error: '`from` is required (e.g. from=A&to=B)' });
    from = from.toUpperCase();
    to   = to ? to.toUpperCase() : String.fromCharCode(from.charCodeAt(0) + 1);
    if (to.charCodeAt(0) - from.charCodeAt(0) > 2) {
      return res.status(400).json({ error: 'Range too wide — keep within 2 letters (e.g. from=A&to=B)' });
    }

    const [ecRows, arRows] = await Promise.all([
      getEcRows(from, to),
      getArRows(from, to),
    ]);

    // Group earnings_calls rows by company
    const companies = {};

    for (const r of ecRows) {
      if (!companies[r.company]) companies[r.company] = { transcript: [], ppt: [], annual_report: [] };
      const c = companies[r.company];

      if (r.t_url_present) {
        c.transcript.push({ fiscal_year: r.fiscal_year, quarter: r.quarter, url_present: true,  signal_present: r.t_signal_present });
      }
      if (r.p_url_present) {
        c.ppt.push({        fiscal_year: r.fiscal_year, quarter: r.quarter, url_present: true,  signal_present: r.p_signal_present });
      }
    }

    // Merge annual_reports by company
    for (const r of arRows) {
      if (!companies[r.company]) companies[r.company] = { transcript: [], ppt: [], annual_report: [] };
      companies[r.company].annual_report.push({
        fiscal_year:    r.fiscal_year,
        url_present:    r.url_present,
        signal_present: r.signal_present,
      });
    }

    res.json({ filter: { from, to }, companies });
  } catch (err) {
    next(err);
  }
}

// GET /api/pipeline/missing?source=transcript|ppt|annual_report&from=A&to=B
async function getMissing(req, res, next) {
  try {
    let { source, from, to } = req.query;
    if (!['transcript', 'ppt', 'annual_report'].includes(source)) {
      return res.status(400).json({ error: 'source must be transcript | ppt | annual_report' });
    }
    if (!from) return res.status(400).json({ error: '`from` is required (e.g. from=A&to=B)' });
    from = from.toUpperCase();
    to   = to ? to.toUpperCase() : String.fromCharCode(from.charCodeAt(0) + 1);
    if (to.charCodeAt(0) - from.charCodeAt(0) > 2) {
      return res.status(400).json({ error: 'Range too wide — keep within 2 letters' });
    }

    let rows;
    if (source === 'transcript') rows = await getMissingRows('transcript', 'transcript_url', from, to);
    else if (source === 'ppt')   rows = await getMissingRows('ppt',        'ppt_url',        from, to);
    else                         rows = await getMissingAnnualReports(from, to);

    res.json({ source, filter: { from, to }, count: rows.length, missing: rows });
  } catch (err) {
    next(err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getEcRows(from, to) {
  return prisma.$queryRawUnsafe(`
    SELECT
      ec.company,
      ec.fiscal_year,
      ec.quarter,
      (ec.transcript_url IS NOT NULL AND ec.transcript_url <> '') AS t_url_present,
      EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv
        WHERE tsv.call_id = ec.id AND tsv.source_doc_type = 'transcript'
      ) AS t_signal_present,
      (ec.ppt_url IS NOT NULL AND ec.ppt_url <> '') AS p_url_present,
      EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv
        WHERE tsv.call_id = ec.id AND tsv.source_doc_type = 'ppt'
      ) AS p_signal_present
    FROM earnings_calls ec
    WHERE UPPER(ec.company) >= $1 AND UPPER(ec.company) < $2
    ORDER BY ec.company, ec.fiscal_year, ec.quarter
  `, from, to);
}

async function getArRows(from, to) {
  return prisma.$queryRawUnsafe(`
    SELECT
      ar.company,
      ar.fiscal_year,
      (ar.annual_report_url IS NOT NULL AND ar.annual_report_url <> '') AS url_present,
      EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv
        WHERE tsv.call_id = ar.id::text AND tsv.source_doc_type = 'annual_report'
      ) AS signal_present
    FROM annual_reports ar
    WHERE UPPER(ar.company) >= $1 AND UPPER(ar.company) < $2
    ORDER BY ar.company, ar.fiscal_year
  `, from, to);
}

async function getMissingRows(sourceDocType, urlCol, from, to) {
  return prisma.$queryRawUnsafe(`
    SELECT ec.id AS call_id, ec.company, ec.fiscal_year, ec.quarter, ec.call_date, ec.${urlCol} AS url
    FROM earnings_calls ec
    WHERE ec.${urlCol} IS NOT NULL AND ec.${urlCol} <> ''
      AND UPPER(ec.company) >= $2 AND UPPER(ec.company) < $3
      AND NOT EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv
        WHERE tsv.call_id = ec.id AND tsv.source_doc_type = $1
      )
    ORDER BY ec.company, ec.fiscal_year, ec.quarter
  `, sourceDocType, from, to);
}

async function getMissingAnnualReports(from, to) {
  return prisma.$queryRawUnsafe(`
    SELECT ar.id::text AS call_id, ar.company, ar.fiscal_year, ar.call_date, ar.annual_report_url AS url
    FROM annual_reports ar
    WHERE ar.annual_report_url IS NOT NULL AND ar.annual_report_url <> ''
      AND UPPER(ar.company) >= $1 AND UPPER(ar.company) < $2
      AND NOT EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv
        WHERE tsv.call_id = ar.id::text AND tsv.source_doc_type = 'annual_report'
      )
    ORDER BY ar.company, ar.fiscal_year
  `, from, to);
}

module.exports = { getCoverage, getMissing };
