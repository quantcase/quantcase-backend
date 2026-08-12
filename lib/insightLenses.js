'use strict';

// Which lens slugs feed each insight type (L3 synthesis).
// Single source of truth shared by the worker and the API service.
// Canonical display order for lenses within each analysis type.
// Both /api/analysis and /api/lenses responses are sorted by this order.
const INSIGHT_LENSES = {
  management:  ['guidance-credibility', 'disclosure-honesty', 'capital-allocation', 'promoter-activity'],
  opportunity: ['industry-analysis', 'competition', 'financial-strength', 'customer-distribution'],
  deal:        ['earnings-forecast', 'earning-quality'],
};

/**
 * Sort an array of lens objects by the canonical order defined in INSIGHT_LENSES.
 * Lenses not found in the config are appended at the end in their original order.
 */
function sortLensesByConfig(lenses, insightType) {
  const order = INSIGHT_LENSES[insightType];
  if (!order) return lenses;
  const indexMap = new Map(order.map((slug, i) => [slug, i]));
  return [...lenses].sort((a, b) => {
    const ia = indexMap.has(a.slug) ? indexMap.get(a.slug) : Infinity;
    const ib = indexMap.has(b.slug) ? indexMap.get(b.slug) : Infinity;
    return ia - ib;
  });
}

module.exports = { INSIGHT_LENSES, sortLensesByConfig };
