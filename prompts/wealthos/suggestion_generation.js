'use strict';

/**
 * PROMPT_TEMPLATE — static instructional portion stored in the DB.
 * Dynamic client data is injected at {{DATA_BLOCK}}.
 */
const PROMPT_TEMPLATE = `You are a senior wealth management advisor assisting a Relationship Manager (RM) in communicating effectively with their clients.

For each client below, generate a personalized outreach suggestion grounded ONLY in their actual portfolio data.

STRICT RULES — violations will cause the response to be rejected:
1. Only reference equity symbols explicitly listed in each client's "allowed_symbols" field.
2. NEVER use these phrases: "guaranteed returns", "sure profit", "insider", "confidential tip", "risk-free".
3. Do NOT make specific price predictions or promise any returns.
4. Keep the message under 80 words and appropriate for a WhatsApp or brief call context.
5. Talking points must be specific to the client's actual holdings and risk profile — no generic advice.
6. The "suggested_action" should be one of: "call", "whatsapp", "email", "schedule_meeting".
7. The "reason" must explain WHY this client needs attention now, citing their score components.

CLIENT DATA:
{{DATA_BLOCK}}

Return a JSON array — one object per client — with exactly these fields:
- client_id (string, must match input)
- reason (string, 2-3 sentences explaining why outreach is needed now)
- suggested_action (string: call | whatsapp | email | schedule_meeting)
- talking_points (array of 3-5 specific bullet points)
- message (string, under 80 words, ready to send)
- priority (string: HIGH | MEDIUM | LOW, must match the priority given in input)`;

/**
 * Assemble the runtime data block from the scored client batch.
 *
 * @param {Array<{clientId, clientData, portfolioData, score, components, priority}>} clients
 * @returns {string}
 */
function buildDataBlock(clients) {
  const clientSummaries = clients.map(c => {
    const holdings = c.portfolioData?.holdings ?? [];
    const symbolList = Array.isArray(holdings)
      ? holdings.map(h => h.ticker || h.symbol || h.scheme_name).filter(Boolean).join(', ')
      : 'No holdings data';

    return {
      client_id:          c.clientId,
      name:               c.clientData.name,
      segment:            c.clientData.segment,
      risk_profile:       c.clientData.risk_profile,
      engagement_score:   c.clientData.engagement_score,
      churn_probability:  c.clientData.churn_probability,
      days_since_contact: c.components.daysSinceContact != null
        ? `${Math.round(c.components.daysSinceContact * 90)} days`
        : 'Unknown',
      portfolio_value_cr: c.portfolioData?.total_value_cr ?? c.portfolioData?.total_value ?? null,
      portfolio_risk:     c.portfolioData?.risk_score ?? null,
      holdings,
      allowed_symbols:    symbolList,
      priority_score:     c.score,
      priority:           c.priority,
      score_components:   c.components,
    };
  });

  return JSON.stringify(clientSummaries, null, 2);
}

/**
 * Build the suggestion generation prompt.
 *
 * @param {Array} clients
 * @param {string|null} [dbTemplate=null]
 * @returns {string}
 */
function suggestionGenerationPrompt(clients, dbTemplate = null) {
  const dataBlock = buildDataBlock(clients);
  const template  = dbTemplate ?? PROMPT_TEMPLATE;
  return template.replace('{{DATA_BLOCK}}', dataBlock);
}

module.exports = { suggestionGenerationPrompt, buildDataBlock, PROMPT_TEMPLATE };
