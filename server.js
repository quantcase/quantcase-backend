require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const jobQueue = require('./lib/jobQueue');
const { getManagementAnalysis } = require('./controllers/managementController');

const app = express();
const port = process.env.PORT || 8000;

// Initialize Prisma Client
const prisma = new PrismaClient();

// Middleware
app.use(cors());
app.use(express.json());

// Test database connection
prisma.$connect()
  .then(() => console.log('Successfully connected to PostgreSQL database via Prisma'))
  .catch((err) => console.error('Error connecting to the database:', err));

// Health check endpoint
app.get('/health', async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// Get all earnings calls
app.get('/api/calls', async (req, res) => {
  try {
    // Parse pagination parameters
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 10));

    // Calculate skip for pagination
    const skip = (page - 1) * size;

    // Get total count for pagination metadata
    const totalCount = await prisma.earnings_calls.count();

    // Fetch paginated calls
    const calls = await prisma.earnings_calls.findMany({
      orderBy: {
        created_at: 'desc'
      },
      skip: skip,
      take: size
    });

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / size);

    res.json({
      success: true,
      data: calls,
      pagination: {
        page: page,
        size: size,
        totalItems: totalCount,
        totalPages: totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching calls:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch calls',
      message: error.message
    });
  }
});

// Get specific earnings call by ID
app.get('/api/calls/:callId', async (req, res) => {
  try {
    const { callId } = req.params;
    const call = await prisma.earnings_calls.findUnique({
      where: { id: callId }
    });

    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    res.json({
      success: true,
      data: call
    });
  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch call',
      message: error.message
    });
  }
});

// Get summary for a specific earnings call
app.get('/api/summary/:callId', async (req, res) => {
  try {
    const { callId } = req.params;

    // Find the most recent summary for this call
    const summary = await prisma.summary.findFirst({
      where: { callId: callId },
      orderBy: { createdAt: 'desc' }
    });

    if (!summary) {
      return res.status(404).json({
        success: false,
        error: 'Summary not found for this call'
      });
    }

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch summary',
      message: error.message
    });
  }
});

// Get management analysis (transformed summary data)
app.get('/api/management/analysis', getManagementAnalysis);

// Summarize an earnings call
app.post('/api/calls/:callId/summarize', async (req, res) => {
  try {
    const { callId } = req.params;

    // Check if call exists
    const call = await prisma.earnings_calls.findUnique({
      where: { id: callId }
    });

    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    // Validate that at least one text source exists
    const hasTranscript = call.transcript_text && call.transcript_text.trim().length > 0;
    const hasPPT = call.ppt_text && call.ppt_text.trim().length > 0;

    if (!hasTranscript && !hasPPT) {
      return res.status(400).json({
        success: false,
        error: 'No transcript or PPT text available for this call'
      });
    }

    // Add job to queue (creates BullMQ job + database entry)
    const job = await jobQueue.addJob('summarization', {
      callId: callId,
      type: 'summarization',
      companyName: call.company_name || call.company,
      transcriptText: call.transcript_text,
      pptText: call.ppt_text
    });

    res.json({
      success: true,
      message: 'Summarization job created and queued',
      job: {
        id: job.id,
        callId: job.callId,
        type: job.type,
        status: job.status,
        bullmqId: job.bullmqId,
        createdAt: job.createdAt
      }
    });
  } catch (error) {
    console.error('Error creating summarization job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create summarization job',
      message: error.message
    });
  }
});

// Get job status
app.get('/api/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await prisma.job.findUnique({
      where: { id: jobId }
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    // Get BullMQ job status if bullmqId exists
    let bullmqStatus = null;
    if (job.bullmqId) {
      try {
        bullmqStatus = await jobQueue.getJobStatus('summarization', job.bullmqId);
      } catch (err) {
        console.error('Error fetching BullMQ status:', err);
      }
    }

    // Optionally include the call data
    const call = await prisma.earnings_calls.findUnique({
      where: { id: job.callId }
    });

    res.json({
      success: true,
      data: {
        ...job,
        bullmqStatus: bullmqStatus,
        call: call
      }
    });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch job',
      message: error.message
    });
  }
});

// 404 handler
app.use((_, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Error handler
app.use((err, _, res, __) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

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
