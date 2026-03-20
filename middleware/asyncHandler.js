'use strict';

/**
 * Wraps an async Express controller to automatically catch errors
 * and forward them to Express's global error handler via next(error).
 * Eliminates the need for try/catch in every route controller.
 */
module.exports = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
