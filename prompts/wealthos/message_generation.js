'use strict';

const CHANNEL_TONE = {
  whatsapp: 'Brief, warm, and conversational. No salutations. Maximum 50 words.',
  email:    'Formal and professional. Include a subject line. Maximum 100 words.',
  call:     'Script-style with a clear opening, 2-3 key points, and a call-to-action. Maximum 80 words.',
};

/**
 * PROMPT_TEMPLATE — static instructional portion stored in the DB.
 * Dynamic client/portfolio/channel data is injected at {{DATA_BLOCK}}.
 */
const PROMPT_TEMPLATE = `You are drafting a client communication for a Relationship Manager.

{{DATA_BLOCK}}

STRICT RULES:
1. Only reference equity symbols from the allowed symbols list above
2. NEVER use: "guaranteed returns", "sure profit", "insider", "confidential tip", "risk-free"
3. Do NOT make specific price predictions
4. Use the client's name naturally
5. End with a clear call-to-action

Generate the message now. Return JSON with fields: subject (string or null), body (string), channel (string).`;

/**
 * Assemble the runtime data block from client/portfolio/interaction context.
 *
 * @param {object} client
 * @param {object|null} portfolio
 * @param {Array<object>} recentInteractions
 * @param {string} channel - 'call' | 'email' | 'whatsapp'
 * @param {string|null} [context]
 * @returns {string}
 */
function buildDataBlock(client, portfolio, recentInteractions, channel, context) {
  const holdings = portfolio?.holdings ?? [];
  const symbolList = Array.isArray(holdings)
    ? holdings.map(h => h.symbol).filter(Boolean).join(', ')
    : 'none';

  const recentSummaries = recentInteractions.map(i => ({
    type:      i.type,
    summary:   i.summary,
    sentiment: i.sentiment,
    date:      i.timestamp,
  }));

  return `CLIENT:
- Name: ${client.name}
- Segment: ${client.segment}
- Risk Profile: ${client.risk_profile}
- Engagement Score: ${client.engagement_score}
- Churn Probability: ${(client.churn_probability * 100).toFixed(0)}%

PORTFOLIO:
- Total Value: ${portfolio?.total_value != null ? `₹${portfolio.total_value} Cr` : 'Not available'}
- Risk Score: ${portfolio?.risk_score ?? 'N/A'} / 10
- Holdings: ${symbolList || 'No holdings data'}
- Allowed Symbols: ${symbolList || 'none'}

RECENT INTERACTIONS:
${recentSummaries.length > 0 ? JSON.stringify(recentSummaries, null, 2) : 'No recent interactions'}

${context ? `RM CONTEXT NOTE: ${context}\n` : ''}CHANNEL: ${channel}
TONE GUIDE: ${CHANNEL_TONE[channel] ?? CHANNEL_TONE.call}`;
}

/**
 * Build the message generation prompt.
 *
 * @param {object} client
 * @param {object|null} portfolio
 * @param {Array<object>} recentInteractions
 * @param {string} channel
 * @param {string|null} [context]
 * @param {string|null} [dbTemplate=null]
 * @returns {string}
 */
function messageGenerationPrompt(client, portfolio, recentInteractions, channel, context, dbTemplate = null) {
  const dataBlock = buildDataBlock(client, portfolio, recentInteractions, channel, context);
  const template  = dbTemplate ?? PROMPT_TEMPLATE;
  return template.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { messageGenerationPrompt, buildDataBlock, PROMPT_TEMPLATE, CHANNEL_TONE };
