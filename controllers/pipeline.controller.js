'use strict';

const prisma = require('../config/prisma');

// GET /api/pipeline/coverage?from=A&to=B
// ?from / ?to filter on company name (case-insensitive, upper-bound exclusive).
// Use single-letter ranges (A→B, S→T) — full-table runs will be slow without indexes.
async function getCoverage(req, res, next) {
  try {
    let { from, to } = req.query;

    // Require from; default to to next letter. Cap at 2-letter span (one letter of companies).
    if (!from) return res.status(400).json({ error: '`from` is required (e.g. from=A&to=B)' });
    from = from.toUpperCase();
    to   = to ? to.toUpperCase() : String.fromCharCode(from.charCodeAt(0) + 1);
    if (to.charCodeAt(0) - from.charCodeAt(0) > 2) {
      return res.status(400).json({ error: 'Range too wide — keep to within 2 letters of from (e.g. from=A&to=B)' });
    }

    // One scan of earnings_calls for both transcript + ppt, annual_reports in parallel.
    const [ecCoverage, annualCoverage] = await Promise.all([
      getEcCoverage(from, to),
      getAnnualReportCoverage(from, to),
    ]);

    res.json({
      filter: { from: from ?? null, to: to ?? null },
      l1: {
        transcript:    ecCoverage.transcript,
        ppt:           ecCoverage.ppt,
        annual_report: annualCoverage,
      },
    });
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
      return res.status(400).json({ error: 'Range too wide — keep to within 2 letters of from' });
    }

    let rows;
    if (source === 'transcript') rows = await getMissingRows('transcript', 'transcript_url', from, to);
    else if (source === 'ppt')   rows = await getMissingRows('ppt',        'ppt_url',        from, to);
    else                         rows = await getMissingAnnualReports(from, to);

    res.json({ source, filter: { from: from ?? null, to: to ?? null }, count: rows.length, missing: rows });
  } catch (err) {
    next(err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Single scan of earnings_calls — checks transcript and ppt existence together.
async function getEcCoverage(from, to) {
  const params = [];
  const rangeClause = buildRangeClause('ec.company', from, to, params);

  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(CASE WHEN ec.transcript_url IS NOT NULL AND ec.transcript_url <> '' THEN 1 END)::int AS t_eligible,
      COUNT(CASE WHEN ec.transcript_url IS NOT NULL AND ec.transcript_url <> '' AND EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv WHERE tsv.call_id = ec.id AND tsv.source_doc_type = 'transcript'
      ) THEN 1 END)::int AS t_done,
      COUNT(CASE WHEN ec.ppt_url IS NOT NULL AND ec.ppt_url <> '' THEN 1 END)::int AS p_eligible,
      COUNT(CASE WHEN ec.ppt_url IS NOT NULL AND ec.ppt_url <> '' AND EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv WHERE tsv.call_id = ec.id AND tsv.source_doc_type = 'ppt'
      ) THEN 1 END)::int AS p_done
    FROM earnings_calls ec
    WHERE 1=1 ${rangeClause}
  `, ...params);

  const r = rows[0];
  return {
    transcript: { eligible: r.t_eligible, done: r.t_done, missing: r.t_eligible - r.t_done },
    ppt:        { eligible: r.p_eligible, done: r.p_done, missing: r.p_eligible - r.p_done },
  };
}

async function getAnnualReportCoverage(from, to) {
  const params = [];
  const rangeClause = buildRangeClause('ar.company', from, to, params);

  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(*)::int AS eligible,
      COUNT(CASE WHEN EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv
        WHERE tsv.call_id = ar.id::text AND tsv.source_doc_type = 'annual_report'
      ) THEN 1 END)::int AS done
    FROM annual_reports ar
    WHERE ar.annual_report_url IS NOT NULL AND ar.annual_report_url <> ''
    ${rangeClause}
  `, ...params);

  const { eligible, done } = rows[0];
  return { eligible, done, missing: eligible - done };
}

async function getMissingRows(sourceDocType, urlCol, from, to) {
  const params = [sourceDocType];
  const rangeClause = buildRangeClause('ec.company', from, to, params);

  return prisma.$queryRawUnsafe(`
    SELECT ec.id AS call_id, ec.company, ec.fiscal_year, ec.quarter, ec.call_date, ec.${urlCol} AS url
    FROM earnings_calls ec
    WHERE ec.${urlCol} IS NOT NULL AND ec.${urlCol} <> ''
      ${rangeClause}
      AND NOT EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv
        WHERE tsv.call_id = ec.id AND tsv.source_doc_type = $1
      )
    ORDER BY ec.company, ec.fiscal_year, ec.quarter
  `, ...params);
}

async function getMissingAnnualReports(from, to) {
  const params = [];
  const rangeClause = buildRangeClause('ar.company', from, to, params);

  return prisma.$queryRawUnsafe(`
    SELECT ar.id::text AS call_id, ar.company, ar.fiscal_year, ar.call_date, ar.annual_report_url AS url
    FROM annual_reports ar
    WHERE ar.annual_report_url IS NOT NULL AND ar.annual_report_url <> ''
      ${rangeClause}
      AND NOT EXISTS (
        SELECT 1 FROM transcript_signals_v2 tsv
        WHERE tsv.call_id = ar.id::text AND tsv.source_doc_type = 'annual_report'
      )
    ORDER BY ar.company, ar.fiscal_year
  `, ...params);
}

// Appends from/to as parameterized values; returns the SQL AND fragment.
function buildRangeClause(col, from, to, params) {
  const clauses = [];
  if (from) { params.push(from.toUpperCase()); clauses.push(`UPPER(${col}) >= $${params.length}`); }
  if (to)   { params.push(to.toUpperCase());   clauses.push(`UPPER(${col}) <  $${params.length}`); }
  return clauses.length ? 'AND ' + clauses.join(' AND ') : '';
}

module.exports = { getCoverage, getMissing };
