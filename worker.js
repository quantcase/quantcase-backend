require('dotenv').config();
const connection = require('./config/redis');
const prisma     = require('./config/prisma');

// Start all workers
require('./workers/summarization');
require('./workers/qe');
require('./workers/wealthos.suggestion');
require('./workers/wealthos.message');
require('./workers/technicals');
require('./workers/aiInsightSynthesis');
require('./workers/overviewSynthesis');
require('./workers/prowess');
require('./workers/lensComputation');

console.log('All workers started');

// ─── Graceful shutdown ───────────────────────────────────────────────────────

const shutdown = async (signal) => {
  console.log(`${signal} received, shutting down all workers...`);
  // Workers close themselves; we just need to release shared resources
  await connection.quit();
  await prisma.$disconnect();
  console.log('Connections closed');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
