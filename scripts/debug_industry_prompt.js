'use strict';
/**
 * Debug: build the industry_overview prompt for any ticker and save it to a file.
 * No LLM call is made.
 *
 * Usage:
 *   node scripts/debug_industry_prompt.js ABB
 *   node scripts/debug_industry_prompt.js ABB output.txt
 */

require('dotenv').config();
const fs             = require('fs');
const path           = require('path');
const { PrismaClient } = require('@prisma/client');
const { FinHelper }    = require('../utils/finHelper');
const { isBFSI }       = require('../utils/industryClassifier');
const { industryPrompt } = require('../prompts/of-prompts/industry-prompt');

const TICKER      = process.argv[2] || 'ABB';
const OUTPUT_FILE = process.argv[3] || path.join(__dirname, `industry_prompt_${TICKER}.txt`);

const RAW_ABBRS = [
  'REV_OP', 'TOTAL_INCOME', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
  'EMP_EXP', 'OTH_EXP', 'FIN_COST', 'DEP_AMORT',
  'PBT', 'PAT', 'TOTAL_ASSETS', 'CURR_LIAB',
];

function banner(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

function _latest(series) {
  if (!Array.isArray(series)) return null;
  return series.filter(s => s.value != null).at(-1)?.value ?? null;
}

function _sparkline(series, n = 4) {
  if (!Array.isArray(series)) return 'N/A';
  const rows = series.filter(s => s.value != null).slice(-n);
  if (!rows.length) return 'N/A';
  return rows.map(r => `${r.period}: ${r.value}`).join('  |  ');
}

function tableRow(label, value, unit = '') {
  const v = value != null ? `${value}${unit}` : 'NULL / MISSING';
  console.log(`  ${label.padEnd(30)} ${v}`);
}

async function main() {
  const prisma = new PrismaClient();
  const helper = new FinHelper(prisma);

  try {
    // ── 1. Find calls + resolve industry ──────────────────────────────────────
    banner(`Step 1 — Earnings calls for ${TICKER}`);
    const calls = await prisma.earnings_calls.findMany({
      where:   { company: TICKER },
      select:  { id: true, fiscal_year: true, quarter: true, call_date: true, basic_industry: true },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    });
    console.log(`  Found ${calls.length} call(s):`);
    calls.forEach(c => console.log(`    ${c.id}  (FY${c.fiscal_year} ${c.quarter})  date: ${c.call_date}`));

    if (!calls.length) { console.log('  ⚠️  No calls found.'); return; }

    // Get last 2 summaryNew rows (same as worker getSubjectSummaries)
    const summaryRows = await prisma.summaryNew.findMany({
      where:   { callId: { startsWith: TICKER } },
      select:  { callId: true, industryAnalysis: true },
      orderBy: { callId: 'desc' },
      take:    2,
    });
    const subjectSummaries = [...summaryRows].reverse();
    const latestSummary    = subjectSummaries.at(-1);
    const industry = latestSummary?.industryAnalysis?.industry
      || calls[0]?.basic_industry
      || 'Unknown Industry';
    const bfsi = isBFSI(industry);

    console.log(`\n  Industry : ${industry}`);
    console.log(`  BFSI     : ${bfsi}`);
    console.log(`  Subject summaryNew: ${subjectSummaries.map(s => s.callId).join(', ') || 'none'}`);

    // ── 2. Peer discovery (mirrors updated getAutoPeerSummaries) ──────────────
    banner('Step 2 — Peer discovery via earnings_calls.basic_industry');
    let peerSummaries = [];
    if (industry && industry !== 'Unknown Industry') {
      const peerCalls = await prisma.earnings_calls.findMany({
        where:   { basic_industry: industry, NOT: { company: TICKER } },
        select:  { company: true, id: true },
        orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
      });
      const seen = new Map();
      for (const c of peerCalls) {
        if (!seen.has(c.company)) {
          seen.set(c.company, c.id);
          if (seen.size >= 2) break;
        }
      }
      console.log(`  Peer tickers: ${[...seen.keys()].join(', ') || 'none'}`);

      if (seen.size > 0) {
        peerSummaries = await prisma.summaryNew.findMany({
          where: { callId: { in: [...seen.values()] } },
        });
        console.log(`  Peer summaryNew found: ${peerSummaries.map(s => s.callId).join(', ') || 'none'}`);
      }
    }

    // ── 3. Fetch KPI batches (mirrors buildIndustrySection exactly) ───────────
    banner('Step 3 — KPI batches (Q4-filtered for snapshot/sparkline, all for fallback)');
    const [rawBatch, derivedBatch] = await Promise.all([
      helper.getTimeSeriesBatch(TICKER, RAW_ABBRS),
      helper.getDerivedKpiBatch(TICKER, bfsi),
    ]);

    const q4Only = batch => Object.fromEntries(
      Object.entries(batch).map(([k, v]) => [k, v.filter(s => s.quarter === 'Q4')])
    );

    const rawQ4     = q4Only(rawBatch);
    const derivedQ4 = q4Only(derivedBatch);
    // derivedBatchAll = full series (passed to prompt as fallback for ROCE/ROE/ROA/CAPEX/FCF)
    const derivedBatchAll = derivedBatch;

    // Show what values end up in the prompt (mirrors industry-prompt.js rendering)
    const _latestAny = (q4Series, allSeries) => _latest(q4Series) ?? _latest(allSeries);

    const revOp       = _latest(rawQ4?.REV_OP);
    const totalInc    = _latest(rawQ4?.TOTAL_INCOME);
    const pat         = _latest(rawQ4?.PAT);
    const pbt         = _latest(rawQ4?.PBT);
    const finCost     = _latest(rawQ4?.FIN_COST);
    const totalAssets = _latest(rawQ4?.TOTAL_ASSETS);
    const currLiab    = _latest(rawQ4?.CURR_LIAB);
    const ebit        = _latest(derivedQ4?.EBIT);
    const roce        = _latest(derivedBatchAll?.ROCE);
    const roa         = _latestAny(derivedQ4?.ROA,   derivedBatchAll?.ROA);
    const roe         = _latestAny(derivedQ4?.ROE,   derivedBatchAll?.ROE);
    const capex       = _latestAny(derivedQ4?.CAPEX, derivedBatchAll?.CAPEX);
    const fcf         = _latestAny(derivedQ4?.FCF,   derivedBatchAll?.FCF);

    console.log('\n  ── Section A snapshot values (what prompt renders) ──');
    tableRow('REV_OP',       revOp);
    tableRow('TOTAL_INCOME', totalInc);
    tableRow('EBIT',         ebit);
    tableRow('PBT',          pbt);
    tableRow('PAT',          pat);
    tableRow('FIN_COST',     finCost);
    tableRow('TOTAL_ASSETS', totalAssets);
    tableRow('CURR_LIAB',    currLiab);
    tableRow('ROCE',         roce,  '%');
    tableRow('ROA',          roa,   '%');
    tableRow('ROE',          roe,   '%');
    tableRow('CAPEX',        capex);
    tableRow('FCF',          fcf);

    console.log('\n  ── Sparklines (Q4-only, last 4) ──');
    console.log(`  REV_OP  : ${_sparkline(rawQ4?.REV_OP)}`);
    console.log(`  PAT     : ${_sparkline(rawQ4?.PAT)}`);
    console.log(`  EBIT    : ${_sparkline(derivedQ4?.EBIT)}`);
    console.log(`  ROCE    : ${_sparkline(derivedQ4?.ROCE) !== 'N/A' ? _sparkline(derivedQ4?.ROCE) : _sparkline(derivedBatchAll?.ROCE) + ' (fallback: all quarters)'}`);

    // ── 4. Build prompt ───────────────────────────────────────────────────────
    banner('Step 4 — Building prompt');
    const subjectData = subjectSummaries.map(s => ({ callId: s.callId, industryAnalysis: s.industryAnalysis }));
    const peerData    = peerSummaries.map(s => ({ callId: s.callId, industryAnalysis: s.industryAnalysis }));
    const metrics     = { rawBatch: rawQ4, derivedBatch: derivedQ4, derivedBatchAll, bfsi };

    const prompt = industryPrompt(TICKER, industry, subjectData, peerData, metrics, null);
    console.log(`  Prompt length: ${prompt.length} chars`);
    console.log(`  Contains final_scoring: ${prompt.includes('"final_scoring"')}`);

    fs.writeFileSync(OUTPUT_FILE, prompt, 'utf8');
    console.log(`  Saved to: ${OUTPUT_FILE}`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => { console.error('Script error:', err); process.exit(1); });
