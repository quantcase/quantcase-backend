'use strict';

// OpenRouter strict mode rules:
//  1. strict: true
//  2. Every object needs additionalProperties: false
//  3. Every property defined must appear in required[] (use ["type","null"] for optional fields)

const lensOutputSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'lens_score',
    strict: true,
    schema: {
      type:                 'object',
      additionalProperties: false,
      required: ['score', 'status', 'takeaway', 'key_metrics', 'highlights', 'risks', 'top_signals'],
      properties: {
        score:       { type: 'integer' },
        status:      { type: 'string', enum: ['STRONG', 'MODERATE', 'WEAK'] },
        takeaway:    { type: 'string' },
        key_metrics: {
          type:                 'object',
          additionalProperties: { type: 'string' },
        },
        highlights: { type: 'array', items: { type: 'string' } },
        risks:      { type: 'array', items: { type: 'string' } },
        top_signals: {
          type:  'array',
          items: {
            type:                 'object',
            additionalProperties: false,
            required: [
              'signal_id', 'metric', 'label',
              'guided_value', 'guided_date',
              'actual_value', 'actual_date',
              'unit', 'delta', 'delta_pct',
              'direction', 'impact', 'statement',
            ],
            properties: {
              signal_id:    { type: ['string',  'null'] },
              metric:       { type: 'string' },
              label:        { type: 'string' },
              guided_value: { type: ['number', 'null'] },
              guided_date:  { type: ['string',  'null'] },
              actual_value: { type: ['number', 'null'] },
              actual_date:  { type: ['string',  'null'] },
              unit:         { type: ['string',  'null'] },
              delta:        { type: ['number', 'null'] },
              delta_pct:    { type: ['number', 'null'] },
              direction:    { type: 'string', enum: ['beat', 'miss', 'in_line', 'tracking', 'major_miss'] },
              impact:       { type: 'string', enum: ['high', 'medium', 'low'] },
              statement:    { type: ['string',  'null'] },
            },
          },
        },
      },
    },
  },
};

module.exports = { lensOutputSchema };
