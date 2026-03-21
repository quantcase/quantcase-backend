'use strict';

const FORBIDDEN_PATTERNS = [
  /guaranteed\s+returns/i,
  /sure\s+profit/i,
  /\binsider\b/i,
  /confidential\s+tip/i,
  /risk[\s-]free/i,
  /guaranteed\s+profit/i,
];

/**
 * Validate LLM-generated suggestion output against compliance guardrails.
 *
 * @param {object} suggestion  - A single suggestion from the LLM response
 * @param {string[]} [allowedSymbols] - Equity symbols from the client's holdings
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateSuggestionOutput(suggestion, allowedSymbols = []) {
  const violations = [];

  const textToCheck = [
    suggestion.reason          ?? '',
    suggestion.message         ?? '',
    ...(Array.isArray(suggestion.talking_points) ? suggestion.talking_points : []),
  ].join(' ');

  // Check forbidden phrases
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(textToCheck)) {
      violations.push(`Forbidden phrase detected: "${pattern.source}"`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Validate LLM-generated message output.
 *
 * @param {object} message  - { body, subject?, channel }
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateMessageOutput(message) {
  const violations = [];
  const textToCheck = [message.body ?? '', message.subject ?? ''].join(' ');

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(textToCheck)) {
      violations.push(`Forbidden phrase detected: "${pattern.source}"`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

module.exports = { validateSuggestionOutput, validateMessageOutput };
