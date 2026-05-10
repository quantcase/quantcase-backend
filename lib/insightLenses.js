'use strict';

// Which lens slugs feed each insight type (L3 synthesis).
// Single source of truth shared by the worker and the API service.
const INSIGHT_LENSES = {
  management:  ['guidance-credibility', 'capital-allocation', 'disclosure-honesty', 'promoter-activity'],
  opportunity: ['industry-analysis', 'competition', 'financial-strength', 'customer-distribution'],
  deal:        ['eps-engine', 'pe-rerating-potential'],
};

module.exports = { INSIGHT_LENSES };
