'use strict';

const wealthosMessageSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'wealthos_message',
    strict: true,
    schema: {
      type:       'object',
      properties: {
        subject: { type: ['string', 'null'] },
        body:    { type: 'string' },
        channel: { type: 'string', enum: ['call', 'email', 'whatsapp'] },
      },
      required:             ['subject', 'body', 'channel'],
      additionalProperties: false,
    },
  },
};

module.exports = { wealthosMessageSchema };
