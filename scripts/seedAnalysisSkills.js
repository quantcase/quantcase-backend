'use strict';

/**
 * Seed script: apply compliant action terminology across all skills in the DB.
 *
 * Compliance mapping (per product requirement):
 *   Buy         → Accumulate
 *   Strong Buy  → Strong Accumulate
 *   Partial Buy → Add
 *   Hold        → Neutral
 *   Partial Sell (profit) → Trim
 *   Partial Sell (loss)   → Cut
 *   Sell        → Exit
 *   Stop Loss   → Stop
 *   Avoid / Ignore → Avoid
 *
 * Skills updated:
 *   1. technical-intelligence      (promptKey: decisionIntelligencePrompt) — prompt + schema enum
 *   2. null-slug decisionIntelligencePrompt skill                          — prompt + schema enum
 *   3. fundamentals-intelligence   (promptKey: fundamentalsIntelligencePrompt) — prompt + schema enum
 *   4. ai-insight-synthesis        — wire outputSchema from outputSchemas/aiInsight.js
 *   5. overview-synthesis          — wire outputSchema from outputSchemas/overview.js
 *
 * Usage:  node scripts/seedComplianceTerms.js
 */

const prisma = require('../config/prisma');
const { aiInsightOutputSchema } = require('../outputSchemas/aiInsight');
const { overviewOutputSchema }  = require('../outputSchemas/overview');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fixDecisionIntelligencePrompt(pt) {
  return pt
    .replace(
      /"action": "<Buy \| Sell \| Hold \| Avoid \| Ignore>"/g,
      '"action": "<Strong Accumulate | Accumulate | Add | Neutral | Trim | Cut | Exit | Stop | Avoid>"'
    )
    .replace(
      /actionableInsight\.action: "Buy" for STRONG_BUY, "Sell" for STRONG_SELL, "Hold" for mild signals, "Avoid" for bearish\/distribution, "Ignore" for insufficient data/g,
      'actionableInsight.action: "Strong Accumulate" for STRONG_BUY; "Accumulate" for BUY; "Add" for WEAK_BUY; "Neutral" for mild/mixed signals; "Trim" for WEAK_SELL (partial exit in profit); "Cut" for partial exit at loss; "Exit" for STRONG_SELL; "Stop" for stop-loss triggered; "Avoid" for bearish/distribution or insufficient data'
    )
    .replace(
      /convictionLevel: High if STRONG_BUY or STRONG_SELL, Medium if BUY or SELL, Low otherwise/g,
      'convictionLevel: High if action is "Strong Accumulate" or "Exit" or "Stop"; Medium if "Accumulate", "Add", "Trim", or "Cut"; Low if "Neutral" or "Avoid"'
    );
}

function fixDecisionIntelligenceSchema(schema) {
  const s = JSON.parse(JSON.stringify(schema)); // deep clone
  const actionProp = s?.json_schema?.schema?.properties?.actionableInsight?.properties?.action;
  if (actionProp) {
    actionProp.enum = ['Strong Accumulate', 'Accumulate', 'Add', 'Neutral', 'Trim', 'Cut', 'Exit', 'Stop', 'Avoid'];
  }
  return s;
}

function fixFundamentalsPrompt(pt) {
  return pt
    .replace(
      /"action": "<Accumulate \| Buy \| Hold \| Reduce \| Avoid>"/g,
      '"action": "<Strong Accumulate | Accumulate | Add | Neutral | Trim | Cut | Exit | Stop | Avoid>"'
    )
    .replace(
      /actionableInsight\.action: "Accumulate" for strong quality at fair price; "Buy" for clear value; "Hold" for steady; "Reduce" for deteriorating; "Avoid" for stressed/g,
      'actionableInsight.action: "Strong Accumulate" for very high conviction full entry; "Accumulate" for normal entry; "Add" for adding to existing position; "Neutral" for stay invested, do nothing; "Trim" for partial exit in profit; "Cut" for partial exit at loss; "Exit" for full exit; "Stop" for stop-loss triggered; "Avoid" for not worth entering'
    );
}

function fixFundamentalsSchema(schema) {
  const s = JSON.parse(JSON.stringify(schema)); // deep clone
  // Schema stored as raw { type, required, properties } (no json_schema wrapper)
  const actionProp = s?.properties?.actionableInsight?.properties?.action;
  if (actionProp) {
    actionProp.enum = ['Strong Accumulate', 'Accumulate', 'Add', 'Neutral', 'Trim', 'Cut', 'Exit', 'Stop', 'Avoid'];
  }
  return s;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let updated = 0;

  // ── 1 & 2. decision-intelligence skills (technical-intelligence + null-slug) ──
  const diSkills = await prisma.skill.findMany({
    where: { promptKey: 'decisionIntelligencePrompt' },
  });

  for (const skill of diSkills) {
    // DO NOT touch technical-intelligence. Its prompt and schema are owned by
    // scripts/updateTechnicalIntelligenceSkill.js, and actionableInsight is no longer a
    // string with an `action` enum — it is an object of new_position/existing_position/
    // watch_for. The regex rewrites below no longer match it and the schema patch would
    // graft a stale `action` enum onto the current shape.
    if (skill.slug === 'technical-intelligence') {
      console.log('⏭  Skipping technical-intelligence — owned by updateTechnicalIntelligenceSkill.js');
      continue;
    }

    const newPrompt = fixDecisionIntelligencePrompt(skill.promptTemplate || '');
    const newSchema = fixDecisionIntelligenceSchema(skill.outputSchema || {});

    await prisma.skill.update({
      where:  { id: skill.id },
      data:   { promptTemplate: newPrompt, outputSchema: newSchema, updatedAt: new Date() },
    });
    console.log(`✓ Updated decision-intelligence skill: slug="${skill.slug}" (id: ${skill.id})`);
    updated++;
  }

  // ── 3. fundamentals-intelligence ─────────────────────────────────────────────
  const fi = await prisma.skill.findUnique({ where: { slug: 'fundamentals-intelligence' } });
  if (fi) {
    const newPrompt = fixFundamentalsPrompt(fi.promptTemplate || '');
    const newSchema = fixFundamentalsSchema(fi.outputSchema || {});
    await prisma.skill.update({
      where: { id: fi.id },
      data:  { promptTemplate: newPrompt, outputSchema: newSchema, updatedAt: new Date() },
    });
    console.log(`✓ Updated fundamentals-intelligence`);
    updated++;
  } else {
    console.warn('⚠ fundamentals-intelligence skill not found in DB');
  }

  // ── 4. ai-insight-synthesis — wire outputSchema ───────────────────────────────
  const ais = await prisma.skill.findUnique({ where: { slug: 'ai-insight-synthesis' } });
  if (ais) {
    await prisma.skill.update({
      where: { id: ais.id },
      data:  { outputSchema: aiInsightOutputSchema, updatedAt: new Date() },
    });
    console.log(`✓ Updated ai-insight-synthesis outputSchema`);
    updated++;
  } else {
    console.warn('⚠ ai-insight-synthesis skill not found in DB');
  }

  // ── 5. overview-synthesis — wire outputSchema ─────────────────────────────────
  const os = await prisma.skill.findUnique({ where: { slug: 'overview-synthesis' } });
  if (os) {
    await prisma.skill.update({
      where: { id: os.id },
      data:  { outputSchema: overviewOutputSchema, updatedAt: new Date() },
    });
    console.log(`✓ Updated overview-synthesis outputSchema`);
    updated++;
  } else {
    console.warn('⚠ overview-synthesis skill not found in DB');
  }

  console.log(`\nDone. ${updated} skill record(s) updated.`);

  // ── Verification pass ─────────────────────────────────────────────────────────
  console.log('\n── Verification ──');
  const allUpdated = await prisma.skill.findMany({
    where: { promptKey: { in: ['decisionIntelligencePrompt', 'fundamentalsIntelligencePrompt', 'aiInsightSynthesisPrompt', 'overviewSynthesisPrompt'] } },
    select: { slug: true, promptKey: true, promptTemplate: true, outputSchema: true },
  });
  for (const s of allUpdated) {
    const pt = s.promptTemplate || '';
    const schemaStr = JSON.stringify(s.outputSchema || {});
    const ptBad     = /\"Buy\"|\"Sell\"|\"Hold\"|\"Ignore\"/.test(pt);
    const schemaBad = /\"Buy\"|\"Sell\"|\"Hold\"|\"Ignore\"/.test(schemaStr);
    const status    = (!ptBad && !schemaBad) ? '✅ clean' : '❌ still has non-compliant terms';
    console.log(`  ${status} — ${s.slug ?? '(null slug)'} / ${s.promptKey}`);
  }
}

main()
  .catch(err => { console.error('Seed failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
