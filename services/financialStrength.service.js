'use strict';

const prisma = require('../config/prisma');
const { ProwessHelper } = require('../utils/prowessHelper');

// ── Main service ─────────────────────────────────────────────────────────────

async function getFinancialStrength(ticker) {
  const sym = ticker.toUpperCase();

  // Resolve latest call_id that has a financial-strength lens score
  const latestRow = await prisma.lensScore.findFirst({
    where:   { ticker: sym, lens_slug: 'financial-strength' },
    select:  { call_id: true, lens_data: true, computed_at: true, is_stale: true, z_score: true },
    orderBy: { computed_at: 'desc' },
  });

  if (!latestRow) {
    return { ticker: sym, available: false, error: 'financial-strength lens not computed for ticker' };
  }

  const ld         = latestRow.lens_data ?? {};
  const topSignals = Array.isArray(ld.top_signals) ? ld.top_signals : [];

  // metric field is the canonical prowess kpi_abbr (enforced by prompt)
  const abbrSet = new Set(topSignals.map(s => s.metric).filter(Boolean));
  const abbrs   = [...abbrSet];

  const prowess = new ProwessHelper(prisma);

  const [annualBatch, quarterlyBatch] = await Promise.all([
    abbrs.length ? prowess.getAnnualBatch(sym, abbrs)    : {},
    abbrs.length ? prowess.getQuarterlyBatch(sym, abbrs) : {},
  ]);

  // Build timeseries map: annual series + latest quarterly point if it's newer than latest annual
  const timeseriesMap = {};
  for (const abbr of abbrs) {
    const annualSeries = (annualBatch[abbr]    ?? []).filter(p => p.value != null);
    const qtrlySeries  = (quarterlyBatch[abbr] ?? []).filter(p => p.value != null);

    const latestAnnual = annualSeries.at(-1) ?? null;
    const latestQtrly  = qtrlySeries.at(-1)  ?? null;
    const isNewerQtr   = latestQtrly && latestAnnual
      ? latestQtrly.fiscal_year > latestAnnual.fiscal_year ||
        (latestQtrly.fiscal_year === latestAnnual.fiscal_year && latestQtrly.quarter > latestAnnual.quarter)
      : !!latestQtrly;

    timeseriesMap[abbr] = {
      annual:         annualSeries,
      latest_quarter: isNewerQtr ? latestQtrly : null,
    };
  }

  // Attach timeseries keyed by metric
  const signalsWithTimeseries = topSignals.map(signal => ({
    ...signal,
    timeseries: timeseriesMap[signal.metric] ?? null,
  }));

  return {
    ticker:       sym,
    call_id:      latestRow.call_id,
    available:    true,
    is_stale:     latestRow.is_stale,
    computed_at:  latestRow.computed_at,
    score:        ld.score        ?? null,
    status:       ld.status       ?? null,
    z_score:      latestRow.z_score ?? null,
    takeaway:     ld.takeaway     ?? null,
    key_metrics:  ld.key_metrics  ?? {},
    highlights:   ld.highlights   ?? [],
    risks:        ld.risks        ?? [],
    top_signals:  signalsWithTimeseries,
  };
}

module.exports = { getFinancialStrength };
