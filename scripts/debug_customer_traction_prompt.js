'use strict';
/**
 * Debug: build the customer_traction prompt for any ticker and save it to a file.
 * No LLM call is made.
 *
 * Usage:
 *   node scripts/debug_customer_traction_prompt.js ABB
 *   node scripts/debug_customer_traction_prompt.js ABB output.txt
 */

require('dotenv').config();
const fs               = require('fs');
const path             = require('path');
const { PrismaClient } = require('@prisma/client');
const { FinHelper }    = require('../utils/finHelper');
const { customerTractionPrompt } = require('../prompts/of-prompts/customer-traction-prompt');

const TICKER      = process.argv[2] || 'ABB';
const OUTPUT_FILE = process.argv[3] || path.join(__dirname, `customer_traction_prompt_${TICKER}.txt`);

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

function fmtKpi(obj) {
  if (!obj || obj.value == null) return 'NULL / MISSING';
  return `${obj.value.toLocaleString('en-IN')} (${obj.abbrUsed ?? ''}, ${obj.period ?? 'latest'})`;
}

async function main() {
  const prisma = new PrismaClient();
  const helper = new FinHelper(prisma);

  try {
    // ── 1. Subject summaries (same as worker getSubjectSummaries) ─────────────
    banner(`Step 1 — Subject summaries for ${TICKER}`);
    const summaryRows = await prisma.summaryNew.findMany({
      where:   { callId: { startsWith: TICKER } },
      orderBy: { callId: 'desc' },
      take:    2,
    });
    const subjectSummaries = [...summaryRows].reverse();
    const subjectCallIds   = subjectSummaries.map(s => s.callId);
    console.log(`  Found ${subjectSummaries.length} summaryNew row(s): ${subjectCallIds.join(', ') || 'none'}`);

    if (!subjectSummaries.length) {
      console.log('  ⚠️  No summaryNew rows found — client traction block will be empty.');
    }

    // ── 2. Computed metrics + kpiValue rows ───────────────────────────────────
    banner('Step 2 — CUST KPI + all kpiValue rows for subject calls');
    const [custLatest, custCagr, kpiRows] = await Promise.all([
      helper.stockKpiLatest(TICKER, 'CUST'),
      helper.stockCustCagr(TICKER),
      prisma.kpiValue.findMany({
        where:  { callId: { in: subjectCallIds } },
        select: { callId: true, kpi_abbr: true, value: true, multiplier: true },
      }),
    ]);

    console.log(`  CUST latest : ${fmtKpi(custLatest)}`);
    console.log(`  CUST CAGR   : ${fmtCagr(custCagr)}`);

    // Filter: total revenue + industry_specific KPIs (covers SEG_* segment KPIs too)
    const industryKpiRows = await prisma.kpi.findMany({
      where:  { kpi_type: 'industry_specific' },
      select: { abbr: true },
    });
    const industrySet = new Set(industryKpiRows.map(k => k.abbr));

    const kpiByCall = {};
    for (const row of kpiRows) {
      if (row.kpi_abbr === 'REV_OP' || industrySet.has(row.kpi_abbr)) {
        if (!kpiByCall[row.callId]) kpiByCall[row.callId] = [];
        kpiByCall[row.callId].push({ kpi_abbr: row.kpi_abbr, value: row.value / (row.multiplier || 1) });
      }
    }

    console.log(`  industry_specific KPIs in registry: ${industrySet.size}`);
    for (const callId of subjectCallIds) {
      const kpis = kpiByCall[callId] ?? [];
      console.log(`\n  ${callId} — ${kpis.length} filtered KPIs (REV_OP + industry_specific):`);
      if (!kpis.length) {
        console.log('    (none)');
      } else {
        kpis.forEach(k => console.log(`    ${k.kpi_abbr.padEnd(24)} = ${k.value}`));
      }
    }

    // ── 3. Fallback: scan transcript summaryNew for CUST ──────────────────────
    banner('Step 3 — CUST fallback check (transcript summaryNew.clientTraction)');
    let resolvedCustLatest = custLatest;
    if (custLatest.value == null) {
      for (const s of [...subjectSummaries].reverse()) {
        const kpis  = s.clientTraction?.customer_growth?.kpis ?? [];
        const match = kpis.find(k => k.kpi_abbr === 'CUST' && k.value != null);
        if (match) {
          resolvedCustLatest = { value: match.value, abbrUsed: 'CUST', period: s.callId, type: 'transcript' };
          console.log(`  ✓ CUST fallback found in ${s.callId}: ${match.value}`);
          break;
        }
      }
      if (resolvedCustLatest.value == null) {
        console.log('  ✗ CUST not found in kpi_values OR transcript summaryNew — will show N/A in prompt');
      }
    } else {
      console.log('  CUST found in kpi_values — no fallback needed');
    }

    // ── 4. factors_affecting from clientTraction ──────────────────────────────
    banner('Step 4 — factors_affecting from summaryNew.clientTraction (qualitative)');
    for (const s of subjectSummaries) {
      console.log(`\n  ${s.callId}:`);
      if (!s.clientTraction) {
        console.log('    (no clientTraction data)');
        continue;
      }
      const ct = s.clientTraction;
      const custFactors = ct.customer_growth?.factors_affecting ?? [];
      const revFactors  = ct.revenue_streams?.factors_affecting  ?? [];
      const hasRetention    = ct.retention    && Object.keys(ct.retention).length > 0;
      const hasSegmentation = ct.segmentation && Object.keys(ct.segmentation).length > 0;
      console.log(`    customer_growth.factors_affecting : ${custFactors.length} item(s)`);
      custFactors.forEach(f => console.log(`      • ${f}`));
      console.log(`    revenue_streams.factors_affecting : ${revFactors.length} item(s)`);
      revFactors.forEach(f => console.log(`      • ${f}`));
      console.log(`    retention       : ${hasRetention    ? '✓' : '✗ (missing)'}`);
      console.log(`    segmentation    : ${hasSegmentation ? '✓' : '✗ (missing)'}`);
    }

    // ── 5. Build prompt ───────────────────────────────────────────────────────
    banner('Step 5 — Building prompt');
    const subjectData = subjectSummaries.map(s => ({
      callId:         s.callId,
      kpis:           kpiByCall[s.callId] ?? [],
      clientTraction: s.clientTraction,
    }));

    const metrics = { custLatest: resolvedCustLatest, custCagr };

    const prompt = customerTractionPrompt(TICKER, subjectData, metrics, null);
    console.log(`  Prompt length: ${prompt.length} chars`);
    console.log(`  Contains final_scoring: ${prompt.includes('"final_scoring"')}`);
    console.log(`  CUST shown in prompt  : Active Customers rendered as "${fmtKpi(resolvedCustLatest)}"`);

    fs.writeFileSync(OUTPUT_FILE, prompt, 'utf8');
    console.log(`  Saved to: ${OUTPUT_FILE}`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => { console.error('Script error:', err); process.exit(1); });
