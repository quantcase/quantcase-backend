const { FINCRUX_METRICS } = require("../constants");


function transcriptExtractorPrompt(transcriptText) {
  return `You are an expert financial analyst extracting structured intelligence from an earnings call transcript to assess management integrity and quality of disclosure.

TRANSCRIPT:
${transcriptText}

----------------------

EXTRACTION GUIDELINES:

**entities**
- people: Key executives, board members, or individuals mentioned by name
- business_segments: Product lines, divisions, or business units discussed
- geographies: Countries, regions, or markets mentioned

**milestones**
Extract milestone information organized into three categories:

1. **future_goals** - New targets and goals announced during this call:
   - financial_targets: Quantitative metrics with specific numbers
     * Examples: EPS targets, revenue growth goals, margin expansion, P/E ratio objectives, EBITDA targets, cost reduction goals
   - conceptual_targets: Qualitative or non-quantitative strategic goals
     * Examples: "become the leading AI media company", "launch 3000 new outlets", "achieve carbon neutrality", "expand into 5 new markets"

2. **failure_disclosures** - Previously announced targets that were missed or will be missed:
   - financial_targets: Quantitative targets that failed
     * Examples: "Q3 revenue target of $500M missed, actual was $450M", "annual EPS guidance of $5.00 reduced to $4.50"
   - conceptual_targets: Qualitative goals that were not achieved
     * Examples: "planned product launch delayed", "market expansion postponed"

3. **success_disclosures** - Previously announced targets that were achieved or exceeded:
   - financial_targets: Quantitative targets that succeeded
     * Examples: "exceeded Q3 revenue target of $400M with $425M", "achieved margin expansion goal of 15%"
   - conceptual_targets: Qualitative goals that were accomplished
     * Examples: "successfully launched new product line as planned", "completed acquisition of competitor"

**Target Schema** (applies to all financial_targets and conceptual_targets):
- statement: Full description of the target/goal
- metric_name: If financial_targets, use one of the FINCRUX_METRICS standard metric names (e.g., "Sales", "Net Profit", "EPS in Rs", "ROE", "ROCE", "OPM %"). If conceptual_targets, a human readable text about the concept outcome being talked about (e.g., "product launch", "market expansion", "carbon neutrality")
  * IMPORTANT: Only use FINCRUX_METRICS names from this list: ${FINCRUX_METRICS.join(', ')}
  * Choose the closest matching metric name from the list above. If no exact match exists, use the most semantically similar metric.
- current_value: Current state or value (use "N/A" if not applicable for conceptual targets). For financial_targets, include the metric value with units (e.g., "INR 459 crore", "$125M revenue", "15.2% margin")
- targeted_value: The goal or desired state. For financial_targets, include the metric value with units (e.g., "INR 786 crore", "$150M revenue", "18% margin")
- initial_time: When the target was first set or announced (extract from context or use current call date)
- target_time: When the target is/was expected to be achieved

**risk_disclosures**
Identify risks mentioned and assess disclosure quality:
- risk: Description of the risk or challenge
- severity: "low", "medium", or "high" based on potential impact
- disclosed_early: true if proactively disclosed, false if only mentioned when pressed by analysts

**governance_signals**
Assess management's governance quality (boolean flags):
- transparent: Are they forthcoming with information and clear in explanations?
- defensive_language: Do they deflect, avoid specifics, or use evasive language when questioned?
- capital_allocation_clarity: Is their capital allocation strategy clearly articulated?

**tone**
Overall management tone: "confident", "neutral", "defensive", or "promotional"

**confidence**
Your confidence in the assessment: "high", "medium", or "low"

----------------------

Be thorough but precise. If a field has no data (e.g., no promises made), return an empty array. All required fields must be present.`;
}

module.exports = { transcriptExtractorPrompt };
