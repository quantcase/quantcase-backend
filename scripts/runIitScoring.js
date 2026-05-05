'use strict';

const { runIitScoring } = require('../utils/industryIntelligence');

// Usage: node scripts/runIitScoring.js [YYYY-MM-DD] [Risk-On|Neutral|Risk-Off]
// Defaults to today's date and Neutral regime.

const weekDate = process.argv[2] || new Date().toISOString().slice(0, 10);
const regime   = process.argv[3] || 'Neutral';

console.log(`Running IIT scoring — weekDate: ${weekDate}, regime: ${regime}`);

runIitScoring({ weekDate, regime })
  .then(({ stockScores, clusterScores }) => {
    console.log(`Done. Stocks: ${stockScores.length}, Clusters: ${clusterScores.length}`);
    process.exit(0);
  })
  .catch(err => {
    console.error('Scoring failed:', err);
    process.exit(1);
  });
