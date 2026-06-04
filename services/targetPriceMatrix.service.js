'use strict';

const prisma = require('../config/prisma');

const HOLDING_YEARS   = 3;
const PROBABILITIES   = { bear: 25, base: 50, bull: 25 };
// Ordered positions in takeaway / highlights[] per lens prompt spec:
//   highlights[0] = Bull, highlights[1] = Base, highlights[2] = Bear
//   allRanges[0]  = Bull, allRanges[1]  = Base, allRanges[2]  = Bear
const SCENARIO_ORDER  = ['bull', 'base', 'bear'];

// ── Parsers ──────────────────────────────────────────────────────────────────

// Extract all ₹X–₹Y ranges from a string in the order they appear.
function parsePriceRanges(text) {
  if (!text) return [];
  const re = /₹([\d,]+(?:\.\d+)?)\s*[–—-]\s*₹([\d,]+(?:\.\d+)?)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      low:  parseFloat(m[1].replace(/,/g, '')),
      high: parseFloat(m[2].replace(/,/g, '')),
    });
  }
  return out;
}

// Extract risk/reward ratio: "2.1x risk" → 2.1
function parseRiskReward(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)x\s*risk/i);
  return m ? parseFloat(m[1]) : null;
}

// Extract EPS/PAT CAGR %: "22% PAT CAGR" → 22
function parseEpsCagr(text) {
  if (!text) return null;
  const m = text.match(/([\d.]+)%\s*(?:PAT|EPS)?\s*CAGR/i);
  return m ? parseFloat(m[1]) : null;
}

// ── Math helpers ─────────────────────────────────────────────────────────────

// Project EPS forward: trailingEps × (1 + cagr/100)^years
function projectEps(trailingEps, cagrPct) {
  if (trailingEps == null || cagrPct == null) return null;
  return Math.round(trailingEps * Math.pow(1 + cagrPct / 100, HOLDING_YEARS) * 100) / 100;
}

// Derive exit PE from target price and projected EPS: pe = target / fyEps
function deriveExitPe(targetMid, fyEps) {
  if (targetMid == null || fyEps == null || fyEps === 0) return null;
  return Math.round((targetMid / fyEps) * 10) / 10;
}

// Probability-weighted target range
function weightedTargets(scenarios) {
  const valid = scenarios.filter(
    s => s.probability_pct != null && s.target_low != null && s.target_high != null,
  );
  if (valid.length < 3) return { low: null, high: null };
  const wLow  = valid.reduce((s, v) => s + (v.target_low  * v.probability_pct) / 100, 0);
  const wHigh = valid.reduce((s, v) => s + (v.target_high * v.probability_pct) / 100, 0);
  return { low: Math.round(wLow), high: Math.round(wHigh) };
}

// CAGR p.a. from CMP to a target over HOLDING_YEARS
function cagrPa(target, cmp) {
  if (target == null || cmp == null || cmp <= 0) return null;
  return Math.round((Math.pow(target / cmp, 1 / HOLDING_YEARS) - 1) * 1000) / 10; // one decimal
}

// % change from CMP
function pctFromCmp(target, cmp) {
  if (target == null || cmp == null || cmp <= 0) return null;
  return Math.round(((target - cmp) / cmp) * 1000) / 10;
}

// ── Main service ─────────────────────────────────────────────────────────────

async function getTargetPriceMatrix(ticker) {
  const sym = ticker.toUpperCase();

  // Resolve latest call_id from lens_scores
  const latestRow = await prisma.lensScore.findFirst({
    where:   { ticker: sym },
    select:  { call_id: true },
    orderBy: { call_id: 'desc' },
  });
  const callId = latestRow?.call_id ?? null;
  if (!callId) {
    return { ticker: sym, callId: null, available: false, error: 'No lens scores found for ticker' };
  }

  // Parallel fetch: TPM lens, PE re-rating lens, CMP from nse_equity
  const [tpmRow, peRow, priceRows] = await Promise.all([
    prisma.lensScore.findFirst({
      where:  { call_id: callId, lens_slug: 'target-price-matrix' },
      select: { lens_data: true, computed_at: true, is_stale: true },
    }),
    prisma.lensScore.findFirst({
      where:  { call_id: callId, lens_slug: 'pe-rerating-potential' },
      select: { lens_data: true },
    }),
    prisma.nse_equity.findMany({
      where:   { symbol: sym, close: { not: null } },
      orderBy: { datetime: 'desc' },
      take:    1,
      select:  { close: true, pe: true, datetime: true },
    }),
  ]);

  if (!tpmRow) {
    return { ticker: sym, callId, available: false, error: 'target-price-matrix lens not computed' };
  }

  const ld         = tpmRow.lens_data ?? {};
  const takeaway   = ld.takeaway  ?? '';
  const highlights = ld.highlights ?? [];

  // CMP and trailing EPS from nse_equity
  const latestPrice  = priceRows[0] ?? null;
  const cmp          = latestPrice?.close != null ? parseFloat(latestPrice.close) : null;
  const currentPe    = latestPrice?.pe    != null ? parseFloat(latestPrice.pe)    : null;
  const trailingEps  = (cmp != null && currentPe != null && currentPe > 0)
    ? Math.round((cmp / currentPe) * 100) / 100
    : null;

  // Parse price ranges and risk/reward from takeaway
  // Prompt spec guarantees order: allRanges[0]=Bull, [1]=Base, [2]=Bear
  const allRanges  = parsePriceRanges(takeaway);
  const riskReward = parseRiskReward(takeaway);

  // Build per-scenario data
  const scenarios = SCENARIO_ORDER.map((scenario, idx) => {
    const highlight  = highlights[idx] ?? null;
    const range      = allRanges[idx]  ?? null;
    const cagrPct    = parseEpsCagr(highlight);
    const fyEps      = projectEps(trailingEps, cagrPct);

    // Derive exit PE from mid-point of target range and projected EPS
    const targetMid  = (range != null) ? Math.round((range.low + range.high) / 2) : null;
    const exitPe     = deriveExitPe(targetMid, fyEps);

    return {
      scenario,
      probability_pct: PROBABILITIES[scenario],
      target_low:      range?.low  ?? null,
      target_high:     range?.high ?? null,
      pct_from_cmp_low:  pctFromCmp(range?.low,  cmp),
      pct_from_cmp_high: pctFromCmp(range?.high, cmp),
      eps_cagr_pct:    cagrPct,
      // exit_pe is a single derived value (mid-point target / projected EPS)
      exit_pe:         exitPe,
      fy_eps:          fyEps,
      narrative:       highlight,
    };
  });

  // Weighted outcome
  const weighted     = weightedTargets(scenarios);
  const wCagrLow     = cagrPa(weighted.low,  cmp);
  const wCagrHigh    = cagrPa(weighted.high, cmp);

  return {
    ticker,
    callId,
    available:             true,
    cmp,
    trailing_eps:          trailingEps,
    current_pe:            currentPe ? Math.round(currentPe * 10) / 10 : null,
    holding_period_years:  HOLDING_YEARS,
    risk_reward:           riskReward,
    weighted_target_low:   weighted.low,
    weighted_target_high:  weighted.high,
    weighted_cagr_low:     wCagrLow,
    weighted_cagr_high:    wCagrHigh,
    model_updated_date:    tpmRow.computed_at,
    lens_score:            ld.score  ?? null,
    lens_status:           ld.status ?? null,
    takeaway,
    scenarios,
  };
}

module.exports = { getTargetPriceMatrix };
