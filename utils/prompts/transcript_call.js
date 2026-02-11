function transcriptExtractorPrompt(transcriptText) {
  return `
You are an expert financial analyst evaluating management integrity
from an earnings call transcript.

Your job is to extract structured intelligence for an investor dashboard.

Return ONLY valid JSON. Do not include any explanatory text or markdown formatting.


----------------------

TRANSCRIPT:
${transcriptText}

----------------------

Extract the following:

1. PROMISES & GUIDANCE
- Forward-looking commitments
- Revenue/profit/capex guidance
- Timelines mentioned

2. DISCLOSURE QUALITY
- Early warnings
- Risk transparency
- Avoidance or vague language

3. GOVERNANCE SIGNALS
- Capital allocation discipline
- Related-party mentions
- Stake pledge references
- Auditor or compliance flags

4. MANAGEMENT TONE
- Confident / Defensive / Promotional / Transparent

Return JSON in this exact schema:

{
  "entities": {
    "people": [],
    "business_segments": [],
    "geographies": []
  },
  "promises": [
    {
      "statement": "",
      "metric": "",
      "target": "",
      "timeline": ""
    }
  ],
  "guidance": [
    {
      "metric": "",
      "guided_value": "",
      "period": ""
    }
  ],
  "risk_disclosures": [
    {
      "risk": "",
      "severity": "low|medium|high",
      "disclosed_early": true
    }
  ],
  "governance_signals": {
    "transparent": true,
    "defensive_language": false,
    "capital_allocation_clarity": true
  },
  "tone": "confident|neutral|defensive|promotional",
  "confidence": "high|medium|low"
}

Only output JSON. No markdown.`;
}

module.exports = { transcriptExtractorPrompt };
