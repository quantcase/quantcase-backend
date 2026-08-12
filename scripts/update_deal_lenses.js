const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 1. Deactivate target-price-matrix and pe-rerating-potential
  await prisma.lensConfig.updateMany({
    where: { slug: { in: ['target-price-matrix', 'pe-rerating-potential'] } },
    data: { is_active: false }
  });

  // 2. Update earning-quality
  const eq = await prisma.lensConfig.findUnique({ where: { slug: 'earning-quality' } });
  const pe = await prisma.lensConfig.findUnique({ where: { slug: 'pe-rerating-potential' } });
  
  const mergedConfig = { ...eq.config };
  
  // Merge signal types
  const peSignalTypes = pe.config.signal_filters?.signal_types || [];
  const eqSignalTypes = eq.config.signal_filters?.signal_types || [];
  mergedConfig.signal_filters.signal_types = [...new Set([...eqSignalTypes, ...peSignalTypes])];

  // Merge metric family
  const peMetricFamily = pe.config.signal_filters?.metric_family || [];
  const eqMetricFamily = eq.config.signal_filters?.metric_family || [];
  mergedConfig.signal_filters.metric_family = [...new Set([...eqMetricFamily, ...peMetricFamily])];

  // Merge weights (simple deduplication by metric name, preferring PE weights for valuation)
  const eqWeights = eq.config.weights || [];
  const peWeights = pe.config.weights || [];
  const mergedWeightsMap = new Map();
  for (const w of eqWeights) mergedWeightsMap.set(w.metric, w);
  for (const w of peWeights) mergedWeightsMap.set(w.metric, w);
  mergedConfig.weights = Array.from(mergedWeightsMap.values());

  // Update prompt template for earning-quality to include PE re-rating
  mergedConfig.prompt_template = `You are a senior financial analyst. You have received pre-computed signal data for the "{{LENS_NAME}}" analytical lens.

Your task is to synthesise this compact signal summary into a structured analytical view focusing on both Earnings Quality and Valuation/Re-rating Potential.

1. EARNINGS QUALITY: Evaluate cash conversion (CFO/EBITDA), accrual risks, provision buffers, working capital stress, and revenue quality.
2. VALUATION & RE-RATING: Assess whether the current P/E multiple is likely to expand, contract, or remain stable based on the quality of earnings and forward growth visibility.

{{DATA_BLOCK}}

OUTPUT FIELD RULES — strictly enforced:
highlights[] — 3 items:
  1. Cash conversion or working capital metric.
  2. Revenue quality or provisioning metric.
  3. Valuation or multiple expansion/contraction rationale.
takeaway — A concise verdict (max 30 words) combining the quality of earnings with the likely impact on the stock's valuation multiple.

Return a JSON object conforming exactly to the lens_score schema:
{
  "score": <integer 0-100>,
  "status": <"STRONG" | "MODERATE" | "WEAK">,
  "takeaway": <string>,
  "key_metrics": { ... },
  "highlights": [ ... ],
  "risks": [ ... ],
  "top_signals": [ ... ]
}`;

  await prisma.lensConfig.update({
    where: { slug: 'earning-quality' },
    data: { 
      name: 'Earnings Quality & Valuation',
      config: mergedConfig 
    }
  });

  // 3. Update Skill prompt template
  const skill = await prisma.skill.findUnique({ where: { slug: 'ai-insight-synthesis' } });
  if (skill) {
    const updatedPrompt = skill.promptTemplate.replace(
      'each lens gets between 15 and 45',
      'each lens gets between 15 and 85'
    );
    await prisma.skill.update({
      where: { slug: 'ai-insight-synthesis' },
      data: { promptTemplate: updatedPrompt }
    });
  }

  console.log('Database updates complete.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
