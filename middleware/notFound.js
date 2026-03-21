'use strict';

/**
 * 404 fallback handler.
 * Must be registered after all routes but before the error handler.
 */
module.exports = (req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
};
