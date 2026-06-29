'use strict';
/**
 * Diagnostic: check what KPI values are injected into the financial-strength
 * prompt for ABB (or any ticker passed as CLI arg).
 *
 * Usage:
 *   node scripts/debug_abb_financial_strength.js ABB
 *   node scripts/debug_abb_financial_strength.js MSUMI
 */

require('dotenv').config();
const { PrismaClient }   = require('@prisma/client');
const { FinHelper }      = require('../utils/finHelper');
const { isBFSI }         = require('../utils/industryClassifier');
const { resolveProwess } = require('../utils/prowessResolver');

const TICKER = process.argv[2] || 'ABB';

const RAW_ABBRS = [
  'REV_OP', 'COST_MAT', 'PURCH_STOCK', 'INV_CHG',
  'EMP_EXP', 'OTH_EXP', 'DEP_AMORT', 'FIN_COST',
  'PAT', 'PBT', 'CFO',
  'TRADE_RECV', 'TRADE_PAY', 'INVENTORY',
  'DEBT_LT', 'DEBT_ST', 'CASH_EQUIV',
  'EQ_SHARE_CAP', 'RES_SURPLUS',
  'ASSET_PPE', 'ASSET_CWIP',
  'TOTAL_ASSETS', 'CURR_LIAB', 'PROV_CONT',
  'DIV_PAYOUT',
];

// KPIs specifically needed for the failing metrics
const CRITICAL_FOR = {
  ROE:       ['PAT', 'EQ_SHARE_CAP', 'RES_SURPLUS'],
  ROCE:      ['PBT', 'FIN_COST', 'TOTAL_ASSETS', 'CURR_LIAB'],
  FCF:       ['CFO', 'ASSET_PPE', 'ASSET_CWIP'],
  'FCF/PAT': ['FCF (derived)', 'PAT'],
  'FCF TTM': ['CFO', 'ASSET_PPE', 'ASSET_CWIP'],
};

function banner(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

function tableRow(label, value, unit = '') {
  const v = value != null ? `${value}${unit}` : 'NULL / MISSING';
  console.log(`  ${label.padEnd(30)} ${v}`);
}

async function main() {
  const prisma = new PrismaClient();
  const helper = new FinHelper(prisma);

  try {
    // ── 1. Find all earnings calls for this ticker ────────────────────────────
    banner(`Step 1 — Earnings calls for ${TICKER}`);
    const calls = await prisma.earnings_calls.findMany({
      where:   { company: TICKER },
      select:  { id: true, fiscal_year: true, quarter: true, call_date: true, basic_industry: true },
      orderBy: [{ fiscal_year: 'asc' }, { quarter: 'asc' }],
    });
    console.log(`  Found ${calls.length} earnings call(s):`);
    calls.forEach(c => console.log(`    ${c.id}  (FY${c.fiscal_year} ${c.quarter})  date: ${c.call_date}`));

    if (!calls.length) {
      console.log('  ⚠️  No earnings calls found. Check the ticker name in earnings_calls.company');
      return;
    }

    // ── 2. Resolve industry ───────────────────────────────────────────────────
    banner('Step 2 — Industry & BFSI detection');
    const summaryRows = await prisma.summaryNew.findMany({
      where:   { callId: { in: calls.map(c => c.id) } },
      select:  { callId: true, industryAnalysis: true },
      orderBy: { callId: 'desc' },
    });
    const latestSummary = summaryRows[0];
    // Prefer summaryNew industry, fall back to earnings_calls.basic_industry
    const industry = latestSummary?.industryAnalysis?.industry
      || calls[calls.length - 1]?.basic_industry
      || 'Unknown Industry';
    const bfsi = isBFSI(industry);
    console.log(`  Industry : ${industry}`);
    console.log(`  BFSI     : ${bfsi}`);
    console.log(`  Summaries found: ${summaryRows.length} (out of ${calls.length} calls)`);

    const callsWithNoSummary = calls.filter(c => !summaryRows.find(s => s.callId === c.id));
    if (callsWithNoSummary.length) {
      console.log(`\n  ⚠️  Calls with NO summaryNew entry:`);
      callsWithNoSummary.forEach(c => console.log(`    ${c.id}`));
    }

    // ── 3. Show stored KPI values per call (from kpi_values table) ────────────
    banner('Step 3 — Stored KPI values in kpi_values table');
    const criticalAbbrs = ['PAT', 'EQ_SHARE_CAP', 'RES_SURPLUS', 'PBT', 'FIN_COST',
                            'TOTAL_ASSETS', 'CURR_LIAB', 'CFO', 'ASSET_PPE', 'ASSET_CWIP'];
    const kpiValueRows = await prisma.kpiValue.findMany({
      where:  { callId: { in: calls.map(c => c.id) }, kpi_abbr: { in: criticalAbbrs } },
      select: { callId: true, kpi_abbr: true, value: true, multiplier: true, source: true },
      orderBy: [{ callId: 'asc' }, { kpi_abbr: 'asc' }],
    });

    // Group by callId
    const kpiByCall = {};
    for (const row of kpiValueRows) {
      if (!kpiByCall[row.callId]) kpiByCall[row.callId] = {};
      kpiByCall[row.callId][row.kpi_abbr] = row;
    }

    for (const call of calls) {
      console.log(`\n  ── ${call.id} ──`);
      const callKpis = kpiByCall[call.id] ?? {};
      if (!Object.keys(callKpis).length) {
        console.log('    (no kpi_values rows found)');
        continue;
      }
      for (const abbr of criticalAbbrs) {
        const row = callKpis[abbr];
        if (row) {
          const displayVal = row.value / (row.multiplier || 1);
          console.log(`    ✓ ${abbr.padEnd(20)} = ${displayVal}  (stored=${row.value}, mult=${row.multiplier}, src=${row.source})`);
        } else {
          console.log(`    ✗ ${abbr.padEnd(20)} NOT FOUND in kpi_values`);
        }
      }
    }

    // ── 3b. Prowess coverage for all financial-strength RAW_ABBRS ────────────
    const prowessInfo = resolveProwess(TICKER);
    banner(`Step 3b — prowess_values_new coverage for ${TICKER}`);
    if (!prowessInfo) {
      console.log(`  (no prowess mapping for ${TICKER} — add to utils/prowessResolver.js)`);
    } else {
      console.log(`  Prowess name    : ${prowessInfo.prowessName}`);
      console.log(`  basic_industry  : ${prowessInfo.basic_industry}`);

      const prowessRows = await prisma.$queryRawUnsafe(
        `SELECT kpi_abbr, fiscal_year, quarter, value, multiplier
         FROM prowess_values_new
         WHERE company = $1
         ORDER BY fiscal_year, quarter, kpi_abbr`,
        prowessInfo.prowessName
      );

      // Build map: abbr → display value (latest period)
      const prowessMap = {};
      for (const row of prowessRows) {
        const val = row.value != null ? row.value / (Number(row.multiplier) || 1) : null;
        prowessMap[row.kpi_abbr] = { val, period: `${row.fiscal_year}-${row.quarter}` };
      }

      console.log(`\n  ${'KPI'.padEnd(16)} ${'prowess value'.padEnd(16)} period        vs kpi_values`);
      console.log(`  ${'-'.repeat(68)}`);
      for (const abbr of RAW_ABBRS) {
        const p  = prowessMap[abbr];
        const pStr  = p ? String(p.val != null ? p.val.toFixed(2) : 'null').padEnd(16) : '—'.padEnd(16);
        const pPer  = p ? p.period.padEnd(14) : '—'.padEnd(14);
        // Latest kpi_values for same ticker
        const kvRow = await prisma.$queryRawUnsafe(
          `SELECT value, multiplier FROM kpi_values WHERE company=$1 AND kpi_abbr=$2 ORDER BY fiscal_year DESC, quarter DESC LIMIT 1`,
          TICKER, abbr
        );
        const kvVal = kvRow[0] ? (kvRow[0].value / (Number(kvRow[0].multiplier) || 1)).toFixed(2) : '—';
        const flag  = !p ? '✗ missing' : '';
        console.log(`  ${abbr.padEnd(16)} ${pStr} ${pPer} kv=${String(kvVal).padEnd(12)} ${flag}`);
      }

      // Summary
      const covered = RAW_ABBRS.filter(a => prowessMap[a]);
      const missing  = RAW_ABBRS.filter(a => !prowessMap[a]);
      console.log(`\n  Covered : ${covered.length}/25`);
      if (missing.length) console.log(`  Missing : ${missing.join(', ')}`);
    }

    // ── 4. Run getTimeSeriesBatch for critical abbrs (all quarters) ───────────
    banner('Step 4 — getTimeSeriesBatch for critical raw KPIs (all quarters)');
    const rawBatch = await helper.getTimeSeriesBatch(TICKER, RAW_ABBRS);

    for (const abbr of ['PAT', 'EQ_SHARE_CAP', 'RES_SURPLUS', 'PBT', 'FIN_COST',
                         'TOTAL_ASSETS', 'CURR_LIAB', 'CFO', 'ASSET_PPE', 'ASSET_CWIP']) {
      const series = rawBatch[abbr] ?? [];
      const vals   = series.map(r => `${r.period}:${r.value ?? 'null'}`).join('  |  ');
      console.log(`  ${abbr.padEnd(20)} series: ${vals || '(empty)'}`);
    }

    // ── 5. Run getDerivedKpiBatch (all quarters) ──────────────────────────────
    banner('Step 5 — getDerivedKpiBatch (ROE, ROCE, FCF, etc.) — all quarters');
    const derivedBatch = await helper.getDerivedKpiBatch(TICKER, bfsi);

    for (const key of ['ROE', 'ROCE', 'FCF', 'ROA', 'EBIT', 'CAPEX']) {
      const series = derivedBatch[key] ?? [];
      const vals   = series.map(r => `${r.period}:${r.value != null ? r.value.toFixed(2) : 'null'}`).join('  |  ');
      console.log(`  ${key.padEnd(20)} series: ${vals || '(empty)'}`);
    }

    // ── 6. Compute what the prompt would see (latest values across all quarters)
    banner('Step 6 — Prompt snapshot: latest values for failing metrics (all quarters)');

    function _latest(series) {
      if (!Array.isArray(series)) return null;
      return series.filter(s => s.value != null).at(-1)?.value ?? null;
    }

    const roeVal  = _latest(derivedBatch.ROE);
    const roceVal = _latest(derivedBatch.ROCE);
    const fcfVal  = _latest(derivedBatch.FCF);
    const patVal  = _latest(rawBatch.PAT);
    const cfoVal  = _latest(rawBatch.CFO);
    const eqCap   = _latest(rawBatch.EQ_SHARE_CAP);
    const resSur  = _latest(rawBatch.RES_SURPLUS);
    const pbtVal  = _latest(rawBatch.PBT);
    const finCost = _latest(rawBatch.FIN_COST);
    const totAss  = _latest(rawBatch.TOTAL_ASSETS);
    const curLiab = _latest(rawBatch.CURR_LIAB);
    const ppe     = _latest(rawBatch.ASSET_PPE);
    const cwip    = _latest(rawBatch.ASSET_CWIP);
    const capexV  = _latest(derivedBatch.CAPEX);

    tableRow('ROE (derived)',  roeVal != null ? roeVal.toFixed(2) : null, '%');
    tableRow('ROCE (derived)', roceVal != null ? roceVal.toFixed(2) : null, '%');
    tableRow('FCF (derived)',  fcfVal != null ? fcfVal.toFixed(2) : null);
    tableRow('PAT (raw)',      patVal);
    tableRow('CFO (raw)',      cfoVal);
    tableRow('EQ_SHARE_CAP',  eqCap);
    tableRow('RES_SURPLUS',   resSur);
    tableRow('PBT',           pbtVal);
    tableRow('FIN_COST',      finCost);
    tableRow('TOTAL_ASSETS',  totAss);
    tableRow('CURR_LIAB',     curLiab);
    tableRow('ASSET_PPE',     ppe);
    tableRow('ASSET_CWIP',    cwip);
    tableRow('CAPEX (derived)',capexV);

    // ── 7. FCF/PAT and FCF TTM from quarterly (all quarters) ─────────────────
    banner('Step 7 — FCF/PAT% and FCF TTM (last-10-quarters window)');

    function _qSeries(series, n = 10) {
      if (!Array.isArray(series)) return [];
      return series.filter(s => s.value != null).slice(-n).map(s => ({
        quarter: `${s.quarter}'${String(s.fiscal_year ?? s.year ?? '').slice(-2)}`,
        value: s.value
      }));
    }

    const lastN = (batch, n = 10) => Object.fromEntries(
      Object.entries(batch).map(([k, v]) => [k, v.slice(-n)])
    );

    const rawBatchAll     = lastN(rawBatch);
    const derivedBatchAll = lastN(derivedBatch);

    const fcfQ    = _qSeries(derivedBatchAll.FCF);
    const patQAll = _qSeries(rawBatchAll.PAT);
    const cfoQ    = _qSeries(rawBatchAll.CFO);
    const capexQQ = _qSeries(derivedBatchAll.CAPEX);

    console.log('\n  FCF quarterly (last 10):');
    if (fcfQ.length) fcfQ.forEach(r => console.log(`    ${r.quarter}: ${r.value}`));
    else console.log('    (no data — FCF quarterly is empty)');

    console.log('\n  PAT quarterly (last 10):');
    if (patQAll.length) patQAll.forEach(r => console.log(`    ${r.quarter}: ${r.value}`));
    else console.log('    (no data)');

    console.log('\n  FCF/PAT % pairs:');
    const pairs = fcfQ.map((r, i) => {
      const p = patQAll[i];
      if (!p || !p.value) return `    ${r.quarter}: FCF=${r.value}, PAT=missing → SKIPPED`;
      return `    ${r.quarter}: FCF=${r.value}, PAT=${p.value}, ratio=${(r.value / p.value * 100).toFixed(1)}%`;
    });
    if (pairs.length) pairs.forEach(p => console.log(p));
    else console.log('    (no FCF/PAT pairs computable — FCF series is empty)');

    // FCF TTM (latest FCF value)
    const fcfTtm   = _latest(derivedBatch.FCF);
    const cfoTtm   = _latest(rawBatch.CFO);
    const capexTtm = _latest(derivedBatch.CAPEX);
    console.log(`\n  FCF TTM (latest non-null FCF)  : ${fcfTtm ?? 'NULL'}`);
    console.log(`  CFO TTM (latest non-null CFO)  : ${cfoTtm ?? 'NULL'}`);
    console.log(`  CAPEX TTM (latest non-null)    : ${capexTtm ?? 'NULL'}`);

    // ── 8. Root cause summary ─────────────────────────────────────────────────
    banner('Step 8 — Root cause diagnosis');

    const issues = [];
    if (roeVal == null) {
      const missing = [];
      if (patVal == null)  missing.push('PAT');
      if (eqCap  == null)  missing.push('EQ_SHARE_CAP');
      if (resSur == null)  missing.push('RES_SURPLUS');
      issues.push(`ROE is null — missing inputs: ${missing.length ? missing.join(', ') : 'equity=0 (division by zero)'}`);
    }
    if (roceVal == null) {
      const missing = [];
      if (pbtVal  == null) missing.push('PBT');
      if (finCost == null) missing.push('FIN_COST');
      if (totAss  == null) missing.push('TOTAL_ASSETS');
      if (curLiab == null) missing.push('CURR_LIAB');
      issues.push(`ROCE is null — missing inputs: ${missing.length ? missing.join(', ') : 'capital_employed=0'}`);
    }
    if (fcfVal == null) {
      const missing = [];
      if (cfoVal == null)  missing.push('CFO');
      if (ppe    == null)  missing.push('ASSET_PPE');
      issues.push(`FCF is null — missing inputs: ${missing.length ? missing.join(', ') : 'unknown'}`);
    }
    if (!fcfQ.length) {
      issues.push('FCF quarterly series empty → FCF/PAT % block will show N/A in prompt');
    }
    if (fcfTtm == null) {
      issues.push('FCF TTM is null → ocf_to_fcf block will be incomplete');
    }

    if (issues.length) {
      console.log('\n  ❌ Issues detected:');
      issues.forEach(i => console.log(`    • ${i}`));
    } else {
      console.log('\n  ✅ All critical metrics have values. Check the prompt output for formatting issues.');
    }

    // ── 9. Show all KPI abbrs stored in kpi_values for each call ─────────────
    banner(`Step 9 — All KPI abbrs stored in kpi_values for ${TICKER}`);
    const allKpiRows = await prisma.kpiValue.findMany({
      where:   { callId: { in: calls.map(c => c.id) } },
      select:  { callId: true, kpi_abbr: true, value: true, multiplier: true, source: true },
      orderBy: [{ callId: 'asc' }, { kpi_abbr: 'asc' }],
    });

    const allByCall = {};
    for (const row of allKpiRows) {
      if (!allByCall[row.callId]) allByCall[row.callId] = [];
      allByCall[row.callId].push(row);
    }

    for (const call of [...calls].reverse()) {
      const rows = allByCall[call.id] ?? [];
      const abbrsStored = [...new Set(rows.map(r => r.kpi_abbr))].sort();
      console.log(`\n  ${call.id} — ${abbrsStored.length} unique abbrs stored:`);
      console.log(`    ${abbrsStored.join(', ') || '(none)'}`);
      // Show any null/zero values
      const suspicious = rows.filter(r => r.value == null || r.value === 0);
      if (suspicious.length) {
        console.log(`    ⚠️  Suspicious (null or zero): ${suspicious.map(r => r.kpi_abbr).join(', ')}`);
      }
    }

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
