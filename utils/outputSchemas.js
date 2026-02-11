const summarySchema = {
  type: "json_schema",
  schema: {
    type: "object",
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
      promises: {
        type: "array",
        items: {
          type: "object",
          properties: {
            statement: { type: "string" },
            metric: { type: "string" },
            target: { type: "string" },
            timeline: { type: "string" }
          },
          required: ["statement", "metric", "target", "timeline"],
          additionalProperties: false
        }
      },
      guidance: {
        type: "array",
        items: {
          type: "object",
          properties: {
            metric: { type: "string" },
            guided_value: { type: "string" },
            period: { type: "string" }
          },
          required: ["metric", "guided_value", "period"],
          additionalProperties: false
        }
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
    required: ["entities", "promises", "guidance", "risk_disclosures", "governance_signals", "tone", "confidence"],
    additionalProperties: false
  }
};

module.exports = { summarySchema };
