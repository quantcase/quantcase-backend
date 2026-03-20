'use strict';

/**
 * Global Express error-handling middleware.
 * Must be registered last (after all routes) in server.js.
 * The 4-argument signature is required for Express to treat this as an error handler.
 */
// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    error:   err.message || 'Internal server error',
  });
};
