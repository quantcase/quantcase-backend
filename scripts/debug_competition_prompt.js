'use strict';
/**
 * Debug: build the competition prompt for any ticker and save it to a file.
 * No LLM call is made.
 *
 * Usage:
 *   node scripts/debug_competition_prompt.js ABB
 *   node scripts/debug_competition_prompt.js ABB output.txt
 */

require('dotenv').config();
const fs               = require('fs');
const path             = require('path');
const { PrismaClient } = require('@prisma/client');
const { FinHelper }    = require('../utils/finHelper');
const { isBFSI }       = require('../utils/industryClassifier');
const { competitionPrompt } = require('../prompts/of-prompts/competition-prompt');

const TICKER      = process.argv[2] || 'ABB';
const OUTPUT_FILE = process.argv[3] || path.join(__dirname, `competition_prompt_${TICKER}.txt`);

function banner(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

function fmtCagr(obj) {
  if (!obj || obj.value == null) return 'NULL / MISSING';
  const note = obj.type === 'latest_value'
    ? ' (latest value)'
    : ` (${obj.type}${obj.spanYears ? ', ' + obj.spanYears + 'Y' : ''})`;
  return `${obj.value}%` + note;
}

async function main() {
  const prisma = new PrismaClient();
  const helper = new FinHelper(prisma);

  try {
    // ── 1. Calls + subject summaries ──────────────────────────────────────────
    banner(`Step 1 — Earnings calls for ${TICKER}`);
    const calls = await prisma.earnings_calls.findMany({
      where:   { company: TICKER },
      select:  { id: true, fiscal_year: true, quarter: true, call_date: true, basic_industry: true },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    });
    console.log(`  Found ${calls.length} call(s)`);
    if (!calls.length) { console.log('  ⚠️  No calls found.'); return; }

    const summaryRows = await prisma.summaryNew.findMany({
      where:   { callId: { startsWith: TICKER } },
      orderBy: { callId: 'desc' },
      take:    2,
    });
    const subjectSummaries = [...summaryRows].reverse();
    const latestSummary    = subjectSummaries.at(-1);
    const industry = latestSummary?.industryAnalysis?.industry
      || calls[0]?.basic_industry
      || 'Unknown Industry';
    const bfsi = isBFSI(industry);

    console.log(`  Industry : ${industry}  |  BFSI: ${bfsi}`);
    console.log(`  Subject summaryNew: ${subjectSummaries.map(s => s.callId).join(', ') || 'none'}`);

    // ── 2. Peer discovery (mirrors getAutoPeerSummaries) ──────────────────────
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
        if (!seen.has(c.company)) { seen.set(c.company, c.id); if (seen.size >= 2) break; }
      }
      console.log(`  Peer tickers: ${[...seen.keys()].join(', ') || 'none'}`);
      if (seen.size > 0) {
        peerSummaries = await prisma.summaryNew.findMany({
          where: { callId: { in: [...seen.values()] } },
        });
        console.log(`  Peer summaryNew: ${peerSummaries.map(s => s.callId).join(', ') || 'none'}`);
      }
    }

    // ── 3. Computed metrics (mirrors buildCompetitionSection exactly) ─────────
    banner('Step 3 — Computed metrics (EPS/PE CAGR)');
    const allCallIds = [...subjectSummaries, ...peerSummaries].map(s => s.callId);

    const [stockEps, stockPe, industryEps, industryPe, kpiRows] = await Promise.all([
      helper.stockEpsCagr(TICKER),
      helper.stockPeCagr(TICKER),
      industry !== 'Unknown Industry' ? helper.industryEpsCagr(industry) : Promise.resolve(null),
      industry !== 'Unknown Industry' ? helper.industryPeCagr(industry)  : Promise.resolve(null),
      prisma.kpiValue.findMany({
        where:  { callId: { in: allCallIds } },
        select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
      }),
    ]);

    console.log(`\n  Subject EPS CAGR  : ${fmtCagr(stockEps)}`);
    console.log(`  Subject P/E CAGR  : ${fmtCagr(stockPe)}`);
    console.log(`  Industry EPS CAGR : ${fmtCagr(industryEps)}${industryEps?.validTickerCount != null ? ` [${industryEps.validTickerCount}/${industryEps.tickerCount} tickers]` : ''}`);
    console.log(`  Industry P/E CAGR : ${fmtCagr(industryPe)}${industryPe?.avgLatestPe != null ? ` (avg latest P/E: ${industryPe.avgLatestPe})` : ''}`);

    // ── 4. KPI values per call ────────────────────────────────────────────────
    banner('Step 4 — KPI values injected per call (Current Quarter KPIs block)');
    const kpiByCall = {};
    for (const row of kpiRows) {
      if (!kpiByCall[row.callId]) kpiByCall[row.callId] = [];
      kpiByCall[row.callId].push({ kpi_abbr: row.kpi_abbr, value: row.value / (row.multiplier || 1) });
    }

    for (const callId of allCallIds) {
      const kpis = kpiByCall[callId] ?? [];
      console.log(`\n  ${callId} — ${kpis.length} KPIs injected:`);
      if (!kpis.length) {
        console.log('    (none — Current Quarter KPIs block will be omitted)');
      } else {
        kpis.slice(0, 15).forEach(k => console.log(`    ${k.kpi_abbr.padEnd(20)} = ${k.value}`));
        if (kpis.length > 15) console.log(`    ... and ${kpis.length - 15} more`);
      }
    }

    // ── 5. Build prompt ───────────────────────────────────────────────────────
    banner('Step 5 — Building prompt');
    const pickFields = s => ({
      callId:            s.callId,
      entities:          s.entities,
      milestones:        s.milestones,
      kpis:              kpiByCall[s.callId] ?? [],
      governanceSignals: s.governanceSignals,
      riskDisclosures:   s.riskDisclosures,
      tone:              s.tone,
    });

    const subjectData = subjectSummaries.map(pickFields);
    const peerData    = peerSummaries.map(pickFields);
    const metrics     = { stockEps, stockPe, industryEps, industryPe };

    const prompt = competitionPrompt(TICKER, industry, subjectData, peerData, metrics, null);
    console.log(`  Prompt length: ${prompt.length} chars`);
    console.log(`  Contains final_scoring: ${prompt.includes('"final_scoring"')}`);

    fs.writeFileSync(OUTPUT_FILE, prompt, 'utf8');
    console.log(`  Saved to: ${OUTPUT_FILE}`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => { console.error('Script error:', err); process.exit(1); });
