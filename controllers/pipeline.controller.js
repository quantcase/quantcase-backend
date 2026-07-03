'use strict';

const prisma = require('../config/prisma');

// FY2025 → FY2024-25
function ecFyToArFy(fy) {
  const y = parseInt(fy.replace('FY', ''), 10);
  return `FY${y - 1}-${String(y).slice(-2)}`;
}

// GET /api/pipeline/coverage?from=A&to=B
// GET /api/pipeline/coverage?format=csv[&sort=desc][&fy=FY2025,FY2026]
async function getCoverage(req, res, next) {
  try {
    // ── CSV mode ────────────────────────────────────────────────────────────
    if (req.query.format === 'csv') return getCoverageCSV(req, res, next);

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

    // Collect all call_ids to fetch failures in one query
    const ecCallIds = ecRows.map(r => r.call_id);
    const arCallIds = arRows.map(r => r.call_id);
    const allCallIds = [...new Set([...ecCallIds, ...arCallIds])];

    const failureMap = allCallIds.length
      ? await buildFailureMap(allCallIds)
      : {};

    // Group by company
    const companies = {};

    for (const r of ecRows) {
      if (!companies[r.company]) companies[r.company] = { transcript: [], ppt: [], annual_report: [] };
      const failures = failureMap[r.call_id] ?? {};

      if (r.t_url_present) {
        companies[r.company].transcript.push({
          fiscal_year:    r.fiscal_year,
          quarter:        r.quarter,
          url_present:    true,
          signal_present: r.t_signal_present,
          failed_chunks:  failures.transcript ?? [],
        });
      }
      if (r.p_url_present) {
        companies[r.company].ppt.push({
          fiscal_year:    r.fiscal_year,
          quarter:        r.quarter,
          url_present:    true,
          signal_present: r.p_signal_present,
          failed_chunks:  failures.ppt ?? [],
        });
      }
    }

    for (const r of arRows) {
      if (!companies[r.company]) companies[r.company] = { transcript: [], ppt: [], annual_report: [] };
      const failures = failureMap[r.call_id] ?? {};

      companies[r.company].annual_report.push({
        fiscal_year:    r.fiscal_year,
        url_present:    r.url_present,
        signal_present: r.signal_present,
        failed_chunks:  failures.annual_report ?? [],
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

// ─── DB queries ───────────────────────────────────────────────────────────────

async function getEcRows(from, to) {
  return prisma.$queryRawUnsafe(`
    SELECT
      ec.id         AS call_id,
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
      ar.id::text   AS call_id,
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

// Returns { [call_id]: { transcript: [...chunks], ppt: [...chunks], annual_report: [...chunks] } }
async function buildFailureMap(callIds) {
  const failures = await prisma.pipelineJobFailure.findMany({
    where:  { call_id: { in: callIds } },
    select: { call_id: true, source_doc_type: true, chunk_index: true, total_chunks: true, error_message: true, failed_at: true, bullmq_job_id: true },
    orderBy: { chunk_index: 'asc' },
  });

  const map = {};
  for (const f of failures) {
    if (!map[f.call_id])                       map[f.call_id] = {};
    if (!map[f.call_id][f.source_doc_type])    map[f.call_id][f.source_doc_type] = [];
    map[f.call_id][f.source_doc_type].push({
      chunk_index:   f.chunk_index,
      total_chunks:  f.total_chunks,
      error_message: f.error_message,
      failed_at:     f.failed_at,
    });
  }
  return map;
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

// ─── CSV handler (called internally when ?format=csv) ────────────────────────

async function getCoverageCSV(req, res, next) {
  try {
    const sort = req.query.sort === 'asc' ? 'asc' : 'desc';

    // Parse / validate fiscal years
    let ecFys;
    if (req.query.fy) {
      ecFys = req.query.fy.split(',').map(s => s.trim()).filter(Boolean);
      for (const fy of ecFys) {
        if (!/^FY\d{4}$/.test(fy)) {
          return res.status(400).json({ error: `Invalid fy format: "${fy}". Use FY2025 style.` });
        }
      }
    } else {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT fiscal_year FROM earnings_calls WHERE fiscal_year IS NOT NULL ORDER BY fiscal_year DESC LIMIT 2`
      );
      ecFys = rows.map(r => r.fiscal_year);
    }

    const arFys = ecFys.map(ecFyToArFy);
    const ecIn  = ecFys.map((_, i) => `$${i + 1}`).join(', ');
    const arIn  = arFys.map((_, i) => `$${i + 1}`).join(', ');

    const [mcapRows, transcriptRows, pptRows, arRows, ecCompanies, arCompanies] = await Promise.all([
      // Latest market cap per symbol
      prisma.$queryRawUnsafe(`
        SELECT DISTINCT ON (symbol) symbol, company_name, market_cap_cr
        FROM nse_equity_new
        ORDER BY symbol, datetime DESC
      `),
      // Transcript: quarters with signals per (company, fiscal_year)
      prisma.$queryRawUnsafe(`
        SELECT ec.company, ec.fiscal_year, COUNT(DISTINCT ec.quarter)::int AS q_count
        FROM earnings_calls ec
        WHERE ec.fiscal_year IN (${ecIn})
          AND ec.transcript_url IS NOT NULL AND ec.transcript_url <> ''
          AND EXISTS (
            SELECT 1 FROM transcript_signals_v2 tsv
            WHERE tsv.call_id = ec.id AND tsv.source_doc_type = 'transcript'
          )
        GROUP BY ec.company, ec.fiscal_year
      `, ...ecFys),
      // PPT: quarters with signals per (company, fiscal_year)
      prisma.$queryRawUnsafe(`
        SELECT ec.company, ec.fiscal_year, COUNT(DISTINCT ec.quarter)::int AS q_count
        FROM earnings_calls ec
        WHERE ec.fiscal_year IN (${ecIn})
          AND ec.ppt_url IS NOT NULL AND ec.ppt_url <> ''
          AND EXISTS (
            SELECT 1 FROM transcript_signals_v2 tsv
            WHERE tsv.call_id = ec.id AND tsv.source_doc_type = 'ppt'
          )
        GROUP BY ec.company, ec.fiscal_year
      `, ...ecFys),
      // Annual report: signal present per (company, fiscal_year)
      prisma.$queryRawUnsafe(`
        SELECT ar.company, ar.fiscal_year
        FROM annual_reports ar
        WHERE ar.fiscal_year IN (${arIn})
          AND ar.annual_report_url IS NOT NULL AND ar.annual_report_url <> ''
          AND EXISTS (
            SELECT 1 FROM transcript_signals_v2 tsv
            WHERE tsv.call_id = ar.id::text AND tsv.source_doc_type = 'annual_report'
          )
      `, ...arFys),
      prisma.$queryRawUnsafe(`SELECT DISTINCT company FROM earnings_calls WHERE company IS NOT NULL`),
      prisma.$queryRawUnsafe(`SELECT DISTINCT company FROM annual_reports WHERE company IS NOT NULL`),
    ]);

    // Build lookup maps
    const mcapMap = {};
    for (const r of mcapRows) mcapMap[r.symbol] = { name: r.company_name, market_cap_cr: r.market_cap_cr };

    const transcriptMap = {};
    for (const r of transcriptRows) {
      if (!transcriptMap[r.company]) transcriptMap[r.company] = {};
      transcriptMap[r.company][r.fiscal_year] = Number(r.q_count);
    }

    const pptMap = {};
    for (const r of pptRows) {
      if (!pptMap[r.company]) pptMap[r.company] = {};
      pptMap[r.company][r.fiscal_year] = Number(r.q_count);
    }

    const arMap = {};
    for (const r of arRows) {
      if (!arMap[r.company]) arMap[r.company] = {};
      arMap[r.company][r.fiscal_year] = 1;
    }

    // Union of all companies
    const allCompanies = [...new Set([
      ...ecCompanies.map(r => r.company),
      ...arCompanies.map(r => r.company),
    ])];

    // Build + sort data rows
    const dataRows = allCompanies.map(company => {
      const mcap = mcapMap[company] ?? {};
      return {
        name:          mcap.name ?? company,
        symbol:        company,
        market_cap_cr: mcap.market_cap_cr ?? null,
        transcript:    ecFys.map(fy => transcriptMap[company]?.[fy] ?? 0),
        ppt:           ecFys.map(fy => pptMap[company]?.[fy] ?? 0),
        annual_report: arFys.map(fy => arMap[company]?.[fy] ?? 0),
      };
    });

    dataRows.sort((a, b) => {
      if (a.market_cap_cr == null && b.market_cap_cr == null) return 0;
      if (a.market_cap_cr == null) return 1;
      if (b.market_cap_cr == null) return -1;
      return sort === 'desc'
        ? b.market_cap_cr - a.market_cap_cr
        : a.market_cap_cr - b.market_cap_cr;
    });

    // Build CSV headers
    const displayFys = ecFys.map(ecFyToArFy);
    const headers = [
      'Name', 'Symbol', 'Market Cap (Cr)',
      ...displayFys.map(fy => `Transcript ${fy}`),
      ...displayFys.map(fy => `PPT ${fy}`),
      ...arFys.map(fy => `Annual Report ${fy}`),
    ];

    const csvLines = [headers.join(',')];
    for (const row of dataRows) {
      const cells = [
        `"${String(row.name ?? '').replace(/"/g, '""')}"`,
        row.symbol,
        row.market_cap_cr != null ? row.market_cap_cr.toFixed(2) : '',
        ...row.transcript,
        ...row.ppt,
        ...row.annual_report,
      ];
      csvLines.push(cells.join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="pipeline_coverage_${ecFys.join('_')}.csv"`);
    res.send(csvLines.join('\n'));
  } catch (err) {
    next(err);
  }
}

module.exports = { getCoverage, getMissing };
