/**
 * Upserts substitute_kpis entries for KPIs used as ratio components.
 * These enable automatic fallback chains inside FinHelper.computeXxx() methods.
 *
 * Run once: node scripts/seedSubstituteKpis.js
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ENTRIES = [
  // ── Ratio component fallbacks ──────────────────────────────────────────────
  // Used by computeIc() — if EBIT missing, fall to PBT → PAT → EBITDA
  { primaryKpiAbbr: 'EBIT',    substitutes: ['PBT', 'PAT', 'EBITDA'] },

  // Used by computeNetDebtEbitda() — if NETDEBT missing, fall to raw DEBT
  { primaryKpiAbbr: 'NETDEBT', substitutes: ['DEBT'] },

  // Used by computeNetDebtEbitda() — if EBITDA missing, fall to EBIT → PAT → PBT
  { primaryKpiAbbr: 'EBITDA',  substitutes: ['EBIT', 'PAT', 'PBT'] },

  // Used by computeCr() — if TL missing, use DEBT as rough proxy for liabilities
  { primaryKpiAbbr: 'TL',      substitutes: ['DEBT'] },
];

async function main() {
  for (const entry of ENTRIES) {
    await prisma.substituteKpi.upsert({
      where:  { primaryKpiAbbr: entry.primaryKpiAbbr },
      update: { substitutes: entry.substitutes },
      create: entry,
    });
    console.log(`OK  ${entry.primaryKpiAbbr.padEnd(12)} -> [${entry.substitutes.join(', ')}]`);
  }
  console.log('\nDone.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
