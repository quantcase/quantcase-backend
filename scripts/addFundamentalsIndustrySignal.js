'use strict';

/**
 * Adds a 6th signal — `industry` (Growing | Stable | Declining) — to the
 * fundamentals-intelligence skill's promptTemplate and outputSchema, so
 * fundamentalsIntelligence.signals carries six entries instead of five.
 *
 * Also strips `capitalEfficiency`, an earlier candidate for the 6th slot that
 * briefly landed in the DB. Drop that block once no environment carries it.
 *
 * This patches the live DB row in place rather than going through
 * scripts/seedFundamentals.js on purpose: the DB prompt has drifted from that
 * seeder (swot is `{title, description}` objects in the DB, plain strings in
 * the seeder; actionBias and whatCanChange wordings differ too), so re-running
 * the seeder would silently revert those edits.
 *
 * Idempotent — re-running is a no-op once the field is present.
 *
 * Bumping skills.updatedAt is load-bearing: getFinancials treats a cached
 * ai_insights row as stale when it predates the skill AND is missing a
 * promised signal, which is what makes the ~2k cached rows self-heal on their
 * next request.
 *
 * Pairs with the COMPANY IDENTITY block in prompts/fundamentals_intelligence.js
 * — without it the model has no sector to judge.
 *
 * Usage:  node scripts/addFundamentalsIndustrySignal.js
 */

const prisma = require('../config/prisma');

const SLUG = 'fundamentals-intelligence';

const SIGNAL_KEY  = 'industry';
const SIGNAL_ENUM = ['Growing', 'Stable', 'Declining', 'Insufficient Data'];
const SIGNAL_LINE = `    "${SIGNAL_KEY}": "<${SIGNAL_ENUM.join(' | ')}>",\n`;
// Anchor: insert after cashConversion so valuation stays last in the block.
const ANCHOR_LINE = '    "cashConversion": "<Excellent | Good | Moderate | Poor | Insufficient Data>",\n';

const RULE_ANCHOR = '- signals: each field must be one of the listed enum values — derive from the data provided\n';
const RULE_LINE   = `- signals.${SIGNAL_KEY}: the trajectory of the sector the company operates in, NOT the company itself — use the COMPANY IDENTITY block's industry group / basic industry / main product as the subject. "Growing" for structural sector tailwinds and expanding end-demand; "Stable" for mature, cyclical or flat demand; "Declining" for structural headwinds, shrinking demand or disruption risk; "Insufficient Data" only when the COMPANY IDENTITY block gives no industry\n`;

// Superseded 6th-signal candidate — remove wherever it landed.
const STALE_KEY = 'capitalEfficiency';

function stripStaleSignal(prompt) {
  return prompt
    .split('\n')
    .filter((line) => !line.includes(`"${STALE_KEY}"`) && !line.startsWith(`- signals.${STALE_KEY}:`))
    .join('\n');
}

function patchPrompt(prompt) {
  let next = stripStaleSignal(prompt);

  if (!next.includes(`"${SIGNAL_KEY}"`)) {
    if (!next.includes(ANCHOR_LINE)) {
      throw new Error('cashConversion anchor line not found in promptTemplate — the DB prompt has changed shape; re-check the signals block before patching.');
    }
    next = next.replace(ANCHOR_LINE, ANCHOR_LINE + SIGNAL_LINE);
  }

  // Rewrite an existing rule line rather than skipping it, so wording changes
  // to RULE_LINE actually reach the DB on a rerun.
  const rulePattern = new RegExp(`^- signals\\.${SIGNAL_KEY}:.*$\\n?`, 'm');
  if (rulePattern.test(next)) {
    next = next.replace(rulePattern, RULE_LINE);
  } else {
    if (!next.includes(RULE_ANCHOR)) {
      throw new Error('signals rule anchor not found in promptTemplate — re-check the Rules section before patching.');
    }
    next = next.replace(RULE_ANCHOR, RULE_ANCHOR + RULE_LINE);
  }

  return next;
}

function patchSchema(schema) {
  const next = JSON.parse(JSON.stringify(schema ?? {}));
  const signals = next?.properties?.signals;
  if (!signals) throw new Error('outputSchema.properties.signals not found — nothing to patch.');

  signals.properties = signals.properties ?? {};
  delete signals.properties[STALE_KEY];
  signals.properties[SIGNAL_KEY] = { type: 'string', enum: SIGNAL_ENUM };
  // Make the six-key contract explicit so the shape is readable from the
  // schema alone (the pipeline parses free-form JSON and does not enforce it).
  // Sorted because Postgres jsonb reorders object keys on read — an unsorted
  // Object.keys() order would differ every round trip and defeat the
  // no-op-on-rerun check below.
  signals.required = Object.keys(signals.properties).sort();

  return next;
}

/**
 * Key-order-independent serialisation. Postgres jsonb normalises object key
 * order on read, so a plain JSON.stringify compare would report a change on
 * every rerun and churn skills.updatedAt for no reason.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function main() {
  const skill = await prisma.skill.findUnique({ where: { slug: SLUG } });
  if (!skill) throw new Error(`Skill "${SLUG}" not found in DB`);

  const promptTemplate = patchPrompt(skill.promptTemplate || '');
  const outputSchema   = patchSchema(skill.outputSchema);

  const promptChanged = promptTemplate !== skill.promptTemplate;
  const schemaChanged = canonical(outputSchema) !== canonical(skill.outputSchema);

  if (!promptChanged && !schemaChanged) {
    console.log(`  No change needed — "${SIGNAL_KEY}" already present in prompt and schema.`);
  } else {
    await prisma.skill.update({
      where: { id: skill.id },
      data:  { promptTemplate, outputSchema, updatedAt: new Date() },
    });
    console.log(`✓ Patched ${SLUG} (prompt: ${promptChanged ? 'updated' : 'unchanged'}, schema: ${schemaChanged ? 'updated' : 'unchanged'})`);
  }

  // ── Verification ────────────────────────────────────────────────────────────
  const after = await prisma.skill.findUnique({ where: { slug: SLUG } });
  const keys  = Object.keys(after.outputSchema?.properties?.signals?.properties ?? {});
  console.log(`\n── Verification ──`);
  console.log(`  schema signal keys (${keys.length}): ${keys.join(', ')}`);
  console.log(`  prompt lists "${SIGNAL_KEY}": ${after.promptTemplate.includes(`"${SIGNAL_KEY}"`) ? '✅' : '❌'}`);
  console.log(`  prompt has ${SIGNAL_KEY} rule: ${after.promptTemplate.includes(`- signals.${SIGNAL_KEY}:`) ? '✅' : '❌'}`);
  console.log(`  stale "${STALE_KEY}" gone: ${after.promptTemplate.includes(STALE_KEY) || keys.includes(STALE_KEY) ? '❌' : '✅'}`);
  console.log(`  skills.updatedAt: ${after.updatedAt.toISOString()}`);

  const stale = await prisma.aiInsight.count({
    where: { type: 'fundamentals', updated_at: { lt: after.updatedAt } },
  });
  console.log(`  cached fundamentals rows now eligible for self-heal: ${stale}`);
  console.log(`\n  Note: utils/skillConfig.js caches skill config in-process for 60s;`);
  console.log(`  running API/worker processes pick this up within a minute.`);
}

main()
  .catch((err) => { console.error('Patch failed:', err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
