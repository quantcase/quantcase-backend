require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');

const { port }     = require('./config/env');
const prisma       = require('./config/prisma');
const jobQueue     = require('./lib/jobQueue');
const cache        = require('./lib/cache');
const router       = require('./routes/index');
const notFound     = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const globalAuth   = require('./middleware/globalAuth');
const { WEBHOOK_PATHS } = require('./middleware/publicRoutes');
const { warmRegistryCache } = require('./utils/formulaRegistry/registryCache');

const app = express();

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
  process.exit(1);
});

app.use(cors());

// Webhook endpoints need the raw request body for signature/checksum verification,
// so skip the global JSON parser for them (their routes attach express.raw() instead).
// WEBHOOK_PATHS is sourced from middleware/publicRoutes.js (single source of truth).
app.use((req, res, next) => {
  if (WEBHOOK_PATHS.includes(req.path)) return next();
  return express.json()(req, res, next);
});

// Serves admin-uploaded transcript/ppt/annual-report PDFs (see
// routes/admin.documentUpload.routes.js) as static files so worker.js can
// fetch() them the same way it fetches BSE-sourced URLs.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

prisma.$connect()
  .then(() => console.log('Successfully connected to PostgreSQL database via Prisma'))
  .catch((err) => console.error('Error connecting to the database:', err));

// Warm the formulaRegistry Kpi-definitions cache so the first screener
// request isn't slow — non-fatal if it fails, resolveMetric lazily loads on
// first use either way.
warmRegistryCache().catch((err) => console.error('[server] formulaRegistry cache warm-up failed:', err));

// Global user-token gate: every route requires a valid JWT except the
// allowlist in middleware/publicRoutes.js (auth entry points, webhooks,
// /health, invite validation, billing pricing reads, /uploads). Runs after
// body parsing so downstream handlers still receive req.body, and before all
// /api/* and /admin routes. /admin keeps its own requireAdmin layer on top.
app.use(globalAuth);

app.use(router);
app.use(notFound);
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

const shutdown = async (signal) => {
  console.log(`${signal} signal received: closing HTTP server`);
  await jobQueue.close();
  await cache.close();
  await prisma.$disconnect();
  console.log('Database and queue connections closed');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
