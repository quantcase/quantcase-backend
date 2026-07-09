require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');

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
app.use(express.json());

// Serves admin-uploaded transcript/ppt/annual-report PDFs (see
// routes/admin.documentUpload.routes.js) as static files so worker.js can
// fetch() them the same way it fetches BSE-sourced URLs.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
