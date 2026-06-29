'use strict';

const { llmStream } = require('../../utils/workerUtils');

/**
 * Generate a 2-3 sentence AI nudge explaining why a thesis is partial/broken.
 *
 * @param {object} params
 * @param {string}   params.thesis
 * @param {string}   params.dimension      "M" | "O" | "D"
 * @param {string[]} params.subFactors
 * @param {string}   params.changedFactor  The sub-factor whose score dropped most
 * @param {number}   params.prevScore      Score at entry creation
 * @param {number}   params.currScore      Current score
 * @param {object}   params.modScores      { M: number|null, O: number|null, D: number|null }
 * @returns {Promise<string>}
 */
async function generateNudge({ thesis, dimension, subFactors, changedFactor, prevScore, currScore, modScores }) {
  const dimLabel = { M: 'Management', O: 'Opportunity', D: 'Deal' }[dimension] ?? dimension;
  const M = modScores.M != null ? Math.round(modScores.M) : 'N/A';
  const O = modScores.O != null ? Math.round(modScores.O) : 'N/A';
  const D = modScores.D != null ? Math.round(modScores.D) : 'N/A';

  const prompt = [
    `User's investment thesis: "${thesis}"`,
    `Primary dimension: ${dimLabel} | Selected sub-factors: ${subFactors.join(', ')}`,
    `Changed sub-score: ${changedFactor} has dropped from ${prevScore} to ${currScore}`,
    `Current MOD scores — M: ${M}, O: ${O}, D: ${D}`,
    '',
    'Write a 2-3 sentence AI nudge that:',
    '1. Names the specific sub-score that changed and by how much',
    '2. References the user\'s thesis language where it directly contradicts the data',
    '3. Ends with a concrete action prompt (e.g. "Consider whether...", "Set a 6-month review trigger")',
    'Be direct and factual, not dramatic.',
  ].join('\n');

  const { text } = await llmStream({
    model: 'anthropic/claude-haiku-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return text.trim();
}

module.exports = { generateNudge };
