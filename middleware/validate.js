'use strict';

const { z } = require('zod');

/**
 * Validation middleware factory using Zod.
 *
 * Usage in a route file:
 *   const { z } = require('zod');
 *   const validate = require('../middleware/validate');
 *
 *   router.get('/analysis',
 *     validate(z.object({ callId: z.string().min(1) })),
 *     controller.doThing
 *   );
 *
 * @param {z.ZodSchema} schema  - Zod schema to validate against
 * @param {'query'|'body'|'params'} source  - Which part of req to validate (default: 'query')
 */
module.exports = (schema, source = 'query') => (req, res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    return res.status(400).json({
      success: false,
      error:   'Validation failed',
      details: result.error.flatten(),
    });
  }
  req[source] = result.data;
  next();
};
