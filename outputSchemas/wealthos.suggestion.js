'use strict';

const wealthosSuggestionSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'wealthos_suggestions',
    strict: true,
    schema: {
      type:  'array',
      items: {
        type:       'object',
        properties: {
          client_id:        { type: 'string' },
          reason:           { type: 'string' },
          suggested_action: { type: 'string' },
          talking_points:   { type: 'array', items: { type: 'string' } },
          message:          { type: 'string' },
          priority:         { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
        required:             ['client_id', 'reason', 'suggested_action', 'talking_points', 'message', 'priority'],
        additionalProperties: false,
      },
    },
  },
};

module.exports = { wealthosSuggestionSchema };
