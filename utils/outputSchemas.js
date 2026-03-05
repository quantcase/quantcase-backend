const kpiEntry = {
  type: "object",
  properties: {
    kpi_abbr:  { type: "string" },
    value:     { type: ["number", "null"] },
    statement: { type: "string" }
  },
  required: ["kpi_abbr", "value", "statement"],
  additionalProperties: false
};

// Reusable sub-section: kpis array + factors_affecting array
const analysisSection = {
  type: "object",
  properties: {
    kpis:              { type: "array", items: kpiEntry },
    factors_affecting: { type: "array", items: { type: "string" } }
  },
  required: ["kpis", "factors_affecting"],
  additionalProperties: false
};

const summarySchema = {
  type: "json_schema",
  schema: {
    type: "object",
    $defs: {
      financialTarget: {
        type: "object",
        properties: {
          statement:     { type: "string" },
          kpi_abbr:      { type: "string" },
          current_value: { type: ["number", "null"] },
          targeted_value:{ type: ["number", "null"] },
          initial_time:  { type: ["string", "null"] },
          target_time:   { type: ["string", "null"] }
        },
        required: ["statement", "kpi_abbr", "current_value", "targeted_value", "initial_time", "target_time"],
        additionalProperties: false
      },
      conceptualTarget: {
        type: "object",
        properties: {
          statement:      { type: "string" },
          concept:        { type: "string" },
          current_state:  { type: ["string", "null"] },
          targeted_state: { type: "string" },
          initial_time:   { type: ["string", "null"] },
          target_time:    { type: ["string", "null"] }
        },
        required: ["statement", "concept", "current_state", "targeted_state", "initial_time", "target_time"],
        additionalProperties: false
      },
      milestoneCategory: {
        type: "object",
        properties: {
          financial_targets:  { type: "array", items: { "$ref": "#/$defs/financialTarget" } },
          conceptual_targets: { type: "array", items: { "$ref": "#/$defs/conceptualTarget" } }
        },
        required: ["financial_targets", "conceptual_targets"],
        additionalProperties: false
      },
      newKpi: {
        type: "object",
        properties: {
          abbr:             { type: "string" },
          full_form:        { type: "string" },
          type:             { type: "string", enum: ["standalone", "ratio"] },
          denomination:     { type: ["string", "null"] },
          numerator_abbr:   { type: ["string", "null"] },
          denominator_abbr: { type: ["string", "null"] }
        },
        required: ["abbr", "full_form", "type", "denomination", "numerator_abbr", "denominator_abbr"],
        additionalProperties: false
      }
    },

    properties: {
      entities: {
        type: "object",
        properties: {
          people: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: "string" }
              },
              required: ["name", "role"],
              additionalProperties: false
            }
          },
          business_segments: { type: "array", items: { type: "string" } },
          geographies:        { type: "array", items: { type: "string" } }
        },
        required: ["people", "business_segments", "geographies"],
        additionalProperties: false
      },

      milestones: {
        type: "object",
        properties: {
          future_goals:        { "$ref": "#/$defs/milestoneCategory" },
          failure_disclosures: { "$ref": "#/$defs/milestoneCategory" },
          success_disclosures: { "$ref": "#/$defs/milestoneCategory" }
        },
        required: ["future_goals", "failure_disclosures", "success_disclosures"],
        additionalProperties: false
      },

      risk_disclosures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            risk:            { type: "string" },
            severity:        { type: "string", enum: ["low", "medium", "high"] },
            disclosed_early: { type: "boolean" }
          },
          required: ["risk", "severity", "disclosed_early"],
          additionalProperties: false
        }
      },

      governance_signals: {
        type: "object",
        properties: {
          transparent:                { type: "boolean" },
          defensive_language:         { type: "boolean" },
          capital_allocation_clarity: { type: "boolean" }
        },
        required: ["transparent", "defensive_language", "capital_allocation_clarity"],
        additionalProperties: false
      },

      tone:       { type: "string", enum: ["confident", "neutral", "defensive", "promotional"] },
      confidence: { type: "string", enum: ["high", "medium", "low"] },

      industry_analysis: {
        type: "object",
        properties: {
          demand:           analysisSection,
          supply:           analysisSection,
          operating_margins: analysisSection
        },
        required: ["demand", "supply", "operating_margins"],
        additionalProperties: false
      },

      financial_strength: {
        type: "object",
        properties: {
          revenue_growth:                      analysisSection,
          profitability_and_margin_expansion:  analysisSection,
          cash_flow_generation_and_quality:    analysisSection,
          balance_sheet_strength_and_leverage: analysisSection
        },
        required: [
          "revenue_growth",
          "profitability_and_margin_expansion",
          "cash_flow_generation_and_quality",
          "balance_sheet_strength_and_leverage"
        ],
        additionalProperties: false
      },

      client_traction: {
        type: "object",
        properties: {
          customer_growth: analysisSection,
          revenue_streams: analysisSection
        },
        required: ["customer_growth", "revenue_streams"],
        additionalProperties: false
      },

      new_kpis: {
        type: "array",
        items: { "$ref": "#/$defs/newKpi" }
      }
    },

    required: [
      "entities", "milestones", "risk_disclosures",
      "governance_signals", "tone", "confidence",
      "industry_analysis", "financial_strength", "client_traction",
      "new_kpis"
    ],
    additionalProperties: false
  }
};

module.exports = { summarySchema };
