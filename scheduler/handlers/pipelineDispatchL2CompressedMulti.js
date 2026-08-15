'use strict';

/**
 * Thin wrapper around services/pipelineDispatch for the scheduler executor.
 * Manual-only job (see scripts/seedSchedulerJobs.js — is_active: false):
 * fired via the admin trigger endpoint, never cron-registered.
 */

const { runL2CompressedMultiDispatch } = require('../../services/pipelineDispatch');

async function run(config = {}) {
  const { slug, ...options } = config;
  return runL2CompressedMultiDispatch(slug, options);
}

module.exports = { run };
