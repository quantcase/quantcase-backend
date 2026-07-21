'use strict';

const prisma = require('../config/prisma');
const { previewProwessCoverage, getDefaultKpiSets } = require('../services/prowess/prowessCoverage.service');
const { DEFAULT_TARGET_TICKERS } = require('../services/pipelineDispatch');
const { listGroups } = require('../services/companyGroups');

// GET /admin/prowess/coverage/options
const getCoverageOptions = async (req, res, next) => {
  try {
    const [callRows, reportRows, groups, defaultKpiSets] = await Promise.all([
      prisma.earnings_calls.findMany({ select: { company: true }, distinct: ['company'] }),
      prisma.annual_reports.findMany({ select: { company: true }, distinct: ['company'] }),
      listGroups(),
      getDefaultKpiSets(),
    ]);
    const companies = [...new Set([
      ...callRows.map(r => r.company),
      ...reportRows.map(r => r.company),
    ])].filter(Boolean).sort();
    const companyGroups = groups.map(g => ({ slug: g.slug, name: g.name, filter_type: g.filter_type }));
    res.json({ defaultTickers: DEFAULT_TARGET_TICKERS, companies, companyGroups, defaultKpiSets });
  } catch (err) {
    next(err);
  }
};

// POST /admin/prowess/coverage/preview — dry run, read-only
const previewCoverage = async (req, res, next) => {
  try {
    const result = await previewProwessCoverage(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

module.exports = { getCoverageOptions, previewCoverage };
