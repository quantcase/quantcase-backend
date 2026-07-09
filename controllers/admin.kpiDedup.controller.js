'use strict';

const asyncHandler = require('../middleware/asyncHandler');
const { runKpiDedupPhase6 } = require('../services/kpiDedup.service');

// POST /admin/kpi-dedup/phase6/preview — dry run, no deletes
const previewPhase6 = asyncHandler(async (req, res) => {
  const report = await runKpiDedupPhase6({ execute: false });
  res.json({ success: true, data: report });
});

// POST /admin/kpi-dedup/phase6/run — actually deletes over-cap KPIs
const runPhase6 = asyncHandler(async (req, res) => {
  const report = await runKpiDedupPhase6({ execute: true });
  res.json({ success: true, data: report });
});

module.exports = { previewPhase6, runPhase6 };
