'use strict';

/**
 * Thin wrapper around services/pipelineDispatch for the scheduler executor.
 * Manual-only job (see scripts/seedSchedulerJobs.js — is_active: false):
 * fired via the admin trigger endpoint, never cron-registered.
 */

const { runL3MultiDispatch } = require('../../services/pipelineDispatch');

async function run(config = {}) {
  return runL3MultiDispatch(config);
}

module.exports = { run };
