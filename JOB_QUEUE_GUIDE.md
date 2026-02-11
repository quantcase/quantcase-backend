# JobQueue System Guide

## Overview

This project uses a singleton JobQueue pattern with BullMQ for background job processing. The system creates a BullMQ task first, then stores a reference in the database with the BullMQ job ID.

## Architecture

```
┌─────────────────┐
│   API Request   │
└────────┬────────┘
         │
         v
┌─────────────────┐
│   JobQueue      │
│   Singleton     │
└────┬───────┬────┘
     │       │
     │       └──────────────┐
     v                      v
┌─────────────┐      ┌──────────────┐
│   BullMQ    │      │  Database    │
│   Queue     │      │  Job Entry   │
└──────┬──────┘      └──────────────┘
       │
       v
┌─────────────┐
│   Worker    │
│   Process   │
└─────────────┘
```

## Setup

### 1. Install Redis

BullMQ requires Redis to be running. Install Redis based on your OS:

**macOS:**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt-get install redis-server
sudo systemctl start redis
```

**Docker:**
```bash
docker run -d -p 6379:6379 redis:alpine
```

### 2. Configure Environment Variables

Add Redis configuration to your `.env` file:

```env
REDIS_HOST=localhost
REDIS_PORT=6379
# REDIS_PASSWORD=your_password  # Optional
```

### 3. Database Schema

The Job model includes the BullMQ job ID:

```prisma
model Job {
  id        String   @id @default(uuid())
  callId    String   @map("call_id")
  type      String
  status    String   @default("pending")
  bullmqId  String?  @map("bullmq_id")  // BullMQ job reference
  result    Json?
  error     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

## Usage

### Creating a Job

The JobQueue singleton provides a simple interface:

```javascript
const jobQueue = require('./lib/jobQueue');

// Add a job to the queue
const job = await jobQueue.addJob('queueName', {
  callId: 'call-id',
  type: 'summarization',
  // ... other data
}, {
  priority: 1,  // Optional: higher priority jobs run first
  delay: 5000   // Optional: delay job by 5 seconds
});

// Returns database job entry with bullmqId
console.log(job.id);        // Database job ID
console.log(job.bullmqId);  // BullMQ job ID
```

### Example: Summarize Endpoint

```javascript
app.post('/api/calls/:callId/summarize', async (req, res) => {
  const { callId } = req.params;

  // Validate call exists
  const call = await prisma.earnings_calls.findUnique({
    where: { id: callId }
  });

  if (!call) {
    return res.status(404).json({ error: 'Call not found' });
  }

  // Add job to queue (creates BullMQ job + database entry)
  const job = await jobQueue.addJob('summarization', {
    callId: callId,
    type: 'summarization',
    transcriptText: call.transcript_text
  });

  res.json({
    success: true,
    job: {
      id: job.id,
      bullmqId: job.bullmqId,
      status: job.status
    }
  });
});
```

## Running the System

### Start the API Server

```bash
npm start
# or for development with auto-reload
npm run dev
```

### Start the Worker Process

In a separate terminal:

```bash
npm run worker
# or for development with auto-reload
npm run worker:dev
```

## Worker Implementation

Workers consume jobs from the queue and process them:

```javascript
const { Worker } = require('bullmq');

const worker = new Worker(
  'summarization',  // Queue name
  async (job) => {
    // Process the job
    const { callId, transcriptText } = job.data;

    // Update job status
    await prisma.job.update({
      where: { bullmqId: job.id },
      data: { status: 'processing' }
    });

    // Do the actual work
    const result = await processSummarization(transcriptText);

    // Update with result
    await prisma.job.update({
      where: { bullmqId: job.id },
      data: {
        status: 'completed',
        result: result
      }
    });

    return result;
  },
  {
    connection: redisConnection,
    concurrency: 5  // Process 5 jobs concurrently
  }
);
```

## Job Status Flow

```
pending → processing → completed
                    → failed
```

## API Endpoints

### Get Job Status

```bash
GET /api/jobs/:jobId

Response:
{
  "success": true,
  "data": {
    "id": "uuid",
    "callId": "call-id",
    "type": "summarization",
    "status": "completed",
    "bullmqId": "bullmq-job-id",
    "result": { ... },
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

## Advanced Usage

### Check BullMQ Job Status

```javascript
const status = await jobQueue.getJobStatus('queueName', bullmqId);
console.log(status.state);      // 'active', 'completed', 'failed', etc.
console.log(status.progress);   // Job progress (0-100)
```

### Update Job Status

```javascript
await jobQueue.updateJobStatus(jobId, {
  status: 'completed',
  result: { summary: '...' }
});
```

## Benefits

1. **Scalability**: Process jobs in the background without blocking API requests
2. **Reliability**: Jobs are persisted in Redis; retries on failure
3. **Monitoring**: Track job progress and status in database
4. **Concurrency**: Process multiple jobs simultaneously
5. **Rate Limiting**: Control job processing rate

## Troubleshooting

### Redis Connection Issues

If you see Redis connection errors:

1. Verify Redis is running: `redis-cli ping` (should return "PONG")
2. Check environment variables in `.env`
3. Ensure Redis port (6379) is not blocked

### Jobs Not Processing

1. Ensure worker process is running: `npm run worker`
2. Check worker logs for errors
3. Verify queue name matches between API and worker

### Database Sync Issues

If BullMQ and database get out of sync, you can manually reconcile:

```javascript
// Find jobs by BullMQ ID
const job = await prisma.job.findFirst({
  where: { bullmqId: 'job-id' }
});
```

## Production Deployment

For production, consider:

1. **Redis Cluster**: Use Redis Cluster or managed Redis (AWS ElastiCache, Redis Cloud)
2. **Multiple Workers**: Run multiple worker processes for scalability
3. **Monitoring**: Use BullMQ Board or Bull Board for job monitoring
4. **Error Handling**: Implement proper error logging and alerting
5. **Job Retention**: Configure job cleanup policies

```javascript
defaultJobOptions: {
  removeOnComplete: {
    age: 24 * 3600,  // Keep for 24 hours
    count: 1000       // Keep last 1000
  },
  removeOnFail: {
    age: 7 * 24 * 3600  // Keep failed jobs for 7 days
  }
}
```
