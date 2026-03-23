'use strict';

/**
 * Build the suggestion generation prompt for a batch of scored clients.
 *
 * @param {Array<{
 *   clientId: string,
 *   clientData: object,
 *   portfolioData: object|null,
 *   score: number,
 *   components: object,
 *   priority: string
 * }>} clients
 * @returns {string}
 */
function suggestionGenerationPrompt(clients) {
  const clientSummaries = clients.map(c => {
    const holdings = c.portfolioData?.holdings ?? [];
    const symbolList = Array.isArray(holdings)
      ? holdings.map(h => h.symbol).filter(Boolean).join(', ')
      : 'No holdings data';

    return {
      client_id:         c.clientId,
      name:              c.clientData.name,
      segment:           c.clientData.segment,
      risk_profile:      c.clientData.risk_profile,
      engagement_score:  c.clientData.engagement_score,
      churn_probability: c.clientData.churn_probability,
      days_since_contact:c.components.daysSinceContact != null
        ? `${Math.round(c.components.daysSinceContact * 90)} days`
        : 'Unknown',
      portfolio_value:   c.portfolioData?.total_value ?? null,
      portfolio_risk:    c.portfolioData?.risk_score ?? null,
      holdings:          holdings,
      allowed_symbols:   symbolList,
      priority_score:    c.score,
      priority:          c.priority,
      score_components:  c.components,
    };
  });

  return `You are a senior wealth management advisor assisting a Relationship Manager (RM) in communicating effectively with their clients.

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
${JSON.stringify(clientSummaries, null, 2)}

Return a JSON array — one object per client — with exactly these fields:
- client_id (string, must match input)
- reason (string, 2-3 sentences explaining why outreach is needed now)
- suggested_action (string: call | whatsapp | email | schedule_meeting)
- talking_points (array of 3-5 specific bullet points)
- message (string, under 80 words, ready to send)
- priority (string: HIGH | MEDIUM | LOW, must match the priority given in input)`;
}

module.exports = { suggestionGenerationPrompt };
