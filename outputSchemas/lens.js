'use strict';

const lensOutputSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'lens_score',
    strict: false,
    schema: {
      type: 'object',
      required: ['score', 'status', 'takeaway', 'key_metrics', 'highlights', 'risks', 'top_signals'],
      properties: {
        score: { type: 'integer' },
        status: {
          type: 'string',
          enum: ['STRONG', 'MODERATE', 'WEAK'],
        },
        takeaway:    { type: 'string' },
        key_metrics: { type: 'object' },
        highlights:  { type: 'array', items: { type: 'string' } },
        risks:       { type: 'array', items: { type: 'string' } },
        top_signals: {
          type:  'array',
          items: {
            type: 'object',
            required: ['signal_id', 'metric', 'label', 'impact'],
            properties: {
              signal_id:    { type: 'string' },
              metric:       { type: 'string' },
              label:        { type: 'string' },
              guided_value: { type: 'number' },
              guided_date:  { type: 'string' },
              actual_value: { type: 'number' },
              actual_date:  { type: 'string' },
              unit:         { type: 'string' },
              delta:        { type: 'number' },
              delta_pct:    { type: 'number' },
              direction:    { type: 'string', enum: ['beat', 'miss', 'in_line', 'tracking'] },
              impact:       { type: 'string', enum: ['high', 'medium', 'low'] },
              statement:    { type: 'string' },
            },
          },
        },
      },
    },
  },
};

module.exports = { lensOutputSchema };
