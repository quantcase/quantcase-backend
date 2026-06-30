'use strict';

require('dotenv').config();

const http   = require('http');
const prisma = require('./config/prisma');
const { loadAndRegisterAll, reregisterJob, getStatus } = require('./scheduler/index');

const SCHEDULER_PORT = parseInt(process.env.SCHEDULER_PORT ?? '8001', 10);

// ── Internal HTTP server ──────────────────────────────────────────────────────
// Listens only on loopback — not exposed externally.
// Used by the admin API to trigger job re-registration without a full restart.

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
  server.listen(SCHEDULER_PORT, '127.0.0.1', () => {
    console.log(`[scheduler] Internal API → 127.0.0.1:${SCHEDULER_PORT}`);
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
