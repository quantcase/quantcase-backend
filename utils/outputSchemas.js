const summarySchema = {
  type: "json_schema",
  schema: {
    type: "object",
    $defs: {
      targetItem: {
        type: "object",
        properties: {
          statement: { type: "string" },
          current_value: { type: "string" },
          targeted_value: { type: "string" },
          metric_name: { type: "string" },
          initialTime: { type: "string" },
          targetTime: { type: "string" }
        },
        required: ["statement", "current_value", "targeted_value", "metric_name", "initialTime", "targetTime"],
        additionalProperties: false
      },
      milestoneCategory: {
        type: "object",
        properties: {
          financial_targets: {
            type: "array",
            items: { $ref: "#/$defs/targetItem" }
          },
          conceptual_targets: {
            type: "array",
            items: { $ref: "#/$defs/targetItem" }
          }
        },
        required: ["financial_targets", "conceptual_targets"],
        additionalProperties: false
      }
    },
    properties: {
      entities: {
        type: "object",
        properties: {
          people: { type: "array", items: { type: "string" } },
          business_segments: { type: "array", items: { type: "string" } },
          geographies: { type: "array", items: { type: "string" } }
        },
        required: ["people", "business_segments", "geographies"],
        additionalProperties: false
      },
      milestones: {
        type: "object",
        properties: {
          future_goals: { $ref: "#/$defs/milestoneCategory" },
          failure_disclosures: { $ref: "#/$defs/milestoneCategory" },
          success_disclosures: { $ref: "#/$defs/milestoneCategory" }
        },
        required: ["future_goals", "failure_disclosures", "success_disclosures"],
        additionalProperties: false
      },
      risk_disclosures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            risk: { type: "string" },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            disclosed_early: { type: "boolean" }
          },
          required: ["risk", "severity", "disclosed_early"],
          additionalProperties: false
        }
      },
      governance_signals: {
        type: "object",
        properties: {
          transparent: { type: "boolean" },
          defensive_language: { type: "boolean" },
          capital_allocation_clarity: { type: "boolean" }
        },
        required: ["transparent", "defensive_language", "capital_allocation_clarity"],
        additionalProperties: false
      },
      tone: { type: "string", enum: ["confident", "neutral", "defensive", "promotional"] },
      confidence: { type: "string", enum: ["high", "medium", "low"] }
    },
    required: ["entities", "milestones", "risk_disclosures", "governance_signals", "tone", "confidence"],
    additionalProperties: false
  }
};

module.exports = { summarySchema };
