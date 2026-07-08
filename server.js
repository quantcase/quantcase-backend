require('dotenv').config();
const express  = require('express');
const cors     = require('cors');

const { port }     = require('./config/env');
const prisma       = require('./config/prisma');
const jobQueue     = require('./lib/jobQueue');
const router       = require('./routes/index');
const notFound     = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

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
const WEBHOOK_PATHS = ['/api/billing/webhook', '/api/smallcase/webhook'];
app.use((req, res, next) => {
  if (WEBHOOK_PATHS.includes(req.path)) return next();
  return express.json()(req, res, next);
});

prisma.$connect()
  .then(() => console.log('Successfully connected to PostgreSQL database via Prisma'))
  .catch((err) => console.error('Error connecting to the database:', err));

app.use(router);
app.use(notFound);
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

const shutdown = async (signal) => {
  console.log(`${signal} signal received: closing HTTP server`);
  await jobQueue.close();
  await prisma.$disconnect();
  console.log('Database and queue connections closed');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
