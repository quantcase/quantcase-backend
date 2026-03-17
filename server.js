require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const prisma    = require('./lib/prisma');
const jobQueue  = require('./lib/jobQueue');

const { healthCheck }                                    = require('./controllers/healthController');
const { getCalls, getCallById, getTranscriptStocks,
        getTranscriptCalls }                             = require('./controllers/callsController');
const { getSummary }                                     = require('./controllers/summaryController');
const { getManagementAnalysis }                          = require('./controllers/managementController');
const { enqueueSummarization, enqueueQeExtraction,
        enqueueOFactorAnalysis, getJobStatus }           = require('./controllers/jobsController');
const { getOFactorAnalysis, getOFactorAnalysisByQuery,
        getPeerData }                                    = require('./controllers/oFactorController');
const { getOFactorPrompt,
        enqueueCustomOFactorAnalysis }                   = require('./controllers/oFactorPromptController');
const { createDealAnalysis, getDealAnalysis,
        getDealAnalysisByQuery }                         = require('./controllers/dealController');
const { getOpportunityStats }                            = require('./controllers/adminController');

const app  = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());

// DB connect
prisma.$connect()
  .then(() => console.log('Successfully connected to PostgreSQL database via Prisma'))
  .catch((err) => console.error('Error connecting to the database:', err));

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', healthCheck);

app.get('/api/calls',               getCalls);
app.get('/api/calls/:callId',        getCallById);
app.get('/api/transcript-stocks',   getTranscriptStocks);
app.get('/api/transcript-calls',    getTranscriptCalls);

app.get('/api/summary/:callId',      getSummary);

app.get('/api/management/analysis',  getManagementAnalysis);

app.post('/api/calls/:callId/summarize',           enqueueSummarization);
app.post('/api/calls/:callId/extract-qe',          enqueueQeExtraction);
app.post('/api/calls/:callId/opportunity/analysis', enqueueOFactorAnalysis);
app.post('/api/calls/:callId/deal/analysis',        createDealAnalysis);

app.get('/api/jobs/:jobId',                        getJobStatus);

app.get('/api/calls/:callId/analysis',             getOFactorAnalysis);
app.get('/api/opportunity/analysis',               getOFactorAnalysisByQuery);
app.get('/api/opportunity/peer-data',              getPeerData);
app.get('/api/opportunity/prompt',                 getOFactorPrompt);
app.post('/api/calls/:callId/opportunity/analysis/custom', enqueueCustomOFactorAnalysis);

app.get('/api/calls/:callId/deal',                 getDealAnalysis);
app.get('/api/deal/analysis',                      getDealAnalysisByQuery);

app.get('/admin/opportunity/stats',                getOpportunityStats);

// ── Fallback handlers ─────────────────────────────────────────────────────────
app.use((_, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

app.use((err, _, res, __) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'Internal server error', message: err.message });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await jobQueue.close();
  await prisma.$disconnect();
  console.log('Database and queue connections closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  await jobQueue.close();
  await prisma.$disconnect();
  console.log('Database and queue connections closed');
  process.exit(0);
});
