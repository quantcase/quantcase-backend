'use strict';

require('dotenv').config();

const http   = require('http');
const prisma = require('./config/prisma');
const { loadAndRegisterAll, reregisterJob, getStatus } = require('./scheduler/index');
const { dispatch }                     = require('./scheduler/executor');
const { logRun, completeRun, failRun } = require('./scheduler/registry');

const SCHEDULER_PORT = parseInt(process.env.SCHEDULER_PORT ?? '8001', 10);
// Bind interface for the internal HTTP server. Defaults to loopback (assumes
// this process is co-located with the API server). If the scheduler instead
// runs on a separate host (e.g. alongside the worker), set this to '0.0.0.0'
// (or the host's private IP) and restrict access at the network level
// (security group / firewall to the API server's IP only) — this endpoint is
// unauthenticated.
const SCHEDULER_BIND_HOST = process.env.SCHEDULER_BIND_HOST || '127.0.0.1';

// ── Internal HTTP server ──────────────────────────────────────────────────────
// Used by the admin API to trigger job re-registration without a full restart.

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  try {
    // POST /reload/:slug — re-register one job (cron change or is_active toggle)
    const reloadMatch = req.method === 'POST' && req.url?.match(/^\/reload\/([^/]+)$/);
    if (reloadMatch) {
      const result = await reregisterJob(decodeURIComponent(reloadMatch[1]));
      return send(200, { ok: true, ...result });
    }

    // POST /trigger/:slug — run a job now, regardless of is_active/cron.
    // Fires and returns immediately; the admin API polls scheduler_runs (shared
    // DB) for status instead of holding this HTTP request open for the job's
    // full duration (BSE discovery can take a couple of minutes).
    const triggerMatch = req.method === 'POST' && req.url?.match(/^\/trigger\/([^/]+)$/);
    if (triggerMatch) {
      const slug = decodeURIComponent(triggerMatch[1]);
      const job  = await prisma.schedulerJob.findUnique({ where: { slug } });
      if (!job) return send(404, { error: `Job "${slug}" not found` });

      const body      = await readJsonBody(req).catch(() => ({}));
      const runConfig = { ...(job.config ?? {}), ...(body.config ?? {}) };

      const runId = await logRun(job.id);
      dispatch(job.job_type, runConfig)
        .then(meta => completeRun(runId, meta))
        .catch(err => failRun(runId, err));

      return send(200, { ok: true, run_id: runId, slug, job_type: job.job_type });
    }

    // POST /reload — re-register all active jobs (full reload)
    if (req.method === 'POST' && req.url === '/reload') {
      await loadAndRegisterAll();
      return send(200, { ok: true, message: 'All jobs reloaded' });
    }

    // GET /status — current timer state (debugging / monitoring)
    if (req.method === 'GET' && req.url === '/status') {
      return send(200, { jobs: getStatus() });
    }

    send(404, { error: 'Not found' });
  } catch (err) {
    console.error('[scheduler-api]', err.message);
    send(500, { error: err.message });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  await loadAndRegisterAll();
  server.listen(SCHEDULER_PORT, SCHEDULER_BIND_HOST, () => {
    console.log(`[scheduler] Internal API → ${SCHEDULER_BIND_HOST}:${SCHEDULER_PORT}`);
  });
}

async function shutdown() {
  console.log('[scheduler] Shutting down...');
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

start().catch(err => { console.error(err); process.exit(1); });
