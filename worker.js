require('dotenv').config();
const { Worker } = require('bullmq');
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { transcriptExtractorPrompt } = require('./utils/prompts/transcript_call');
const { summarySchema } = require('./utils/outputSchemas');

const TRANSCRIPT_CHAR_LIMIT = 50000;
const MAX_TOKENS = 50000;

// Initialize clients
const prisma = new PrismaClient();
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const anthropic = new Anthropic({
  apiKey: process.env['CLAUDE_API_KEY'],
});

// Switch between LLM providers:
// const LLMClient = openaiClient.chat.completions;  // For OpenAI
const LLMClient = anthropic.messages;  // For Claude (current)

console.log('LLM Client initialized:', LLMClient);

// Redis connection
const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null
});


async function processSummarizationJob(job) {
  const { callId, transcriptText, pptText, type } = job.data;
  console.log(`Processing BullMQ job ${job.id} (callId: ${callId}, type: ${type})`);

  try {
    const combinedText = [
      transcriptText || '',
      pptText || ''
    ].filter(text => text.trim().length > 0).join('\n\n');
    if (!combinedText || combinedText.trim().length === 0) {
      throw new Error(`No transcript or PPT text available for call ${callId}`);
    }

    // Update database job status to processing (upsert if doesn't exist)
    console.log(`Updating database job with bullmqId: ${job.id}`);
    const dbJob = await prisma.job.upsert({
      where: { bullmqId: job.id },
      update: { status: 'processing' },
      create: {
        callId: callId,
        type: type || 'summarization',
        status: 'processing',
        bullmqId: job.id
      }
    });
    console.log(`Database job ${dbJob.id} updated to processing`);
    await job.updateProgress(25);

    // Use character limit for testing
    const testTranscript = combinedText.substring(0, TRANSCRIPT_CHAR_LIMIT);
    console.log(`combinedText length: ${combinedText.length}, testTranscript length: ${testTranscript.length}`);
    // Generate prompt using the transcript extractor
    const prompt = transcriptExtractorPrompt(testTranscript);
    console.log(`prompt length: ${prompt.length}, testTranscript length: ${testTranscript.length}`);

    await job.updateProgress(50);

    console.log('Calling Claude API with streaming...');
    // Use streaming to avoid timeout errors for long-running requests
    const stream = LLMClient.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      output_config: {
        format: summarySchema
      }
    });

    // Get the final message without handling individual events
    const completion = await stream.finalMessage();

    await job.updateProgress(75);

    // Extract JSON response from LLM output
    const responseText = completion?.content[0].text || completion?.choices[0].message.content;
    console.log('LLM API response:', responseText);

    // Parse the JSON response
    const extractedData = JSON.parse(responseText);

    // Save to Summary table (upsert to update existing summaries)
    const summaryRecord = await prisma.summary.upsert({
      where: { callId: callId },
      update: {
        entities: extractedData.entities || null,
        milestones: extractedData.milestones || null,
        riskDisclosures: extractedData.risk_disclosures || null,
        governanceSignals: extractedData.governance_signals || null,
        tone: extractedData.tone || null,
        confidence: extractedData.confidence || null
      },
      create: {
        callId: callId,
        entities: extractedData.entities || null,
        milestones: extractedData.milestones || null,
        riskDisclosures: extractedData.risk_disclosures || null,
        governanceSignals: extractedData.governance_signals || null,
        tone: extractedData.tone || null,
        confidence: extractedData.confidence || null
      }
    });

    console.log(`Summary saved to database with ID: ${summaryRecord.id}`);

    await job.updateProgress(100);

    // Update database job with result
    await prisma.job.update({
      where: { bullmqId: job.id },
      data: {
        status: 'completed',
        result: {
          summaryId: summaryRecord.id,
          extractedData
        }
      }
    });

    console.log(`Job ${job.id} completed successfully`);
    return { summaryId: summaryRecord.id, extractedData };

  } catch (error) {
    console.error(`Job ${job.id} failed:`, error);

    // Update database job with error (upsert if doesn't exist)
    try {
      await prisma.job.upsert({
        where: { bullmqId: job.id },
        update: {
          status: 'failed',
          error: error.message
        },
        create: {
          callId: callId,
          type: type || 'summarization',
          status: 'failed',
          bullmqId: job.id,
          error: error.message
        }
      });
    } catch (dbError) {
      console.error(`Failed to update job ${job.id} in database:`, dbError);
    }

    throw error;
  }
}

// Create worker for summarization queue
const summarizationWorker = new Worker(
  'summarization',
  processSummarizationJob,
  {
    connection,
    concurrency: 5, // Process up to 5 jobs concurrently
    limiter: {
      max: 10, // Max 10 jobs
      duration: 1000 // per 1 second
    }
  }
);

// Worker event listeners
summarizationWorker.on('completed', (job) => {
  console.log(`Job ${job.id} has been completed`);
});

summarizationWorker.on('failed', (job, err) => {
  console.error(`Job ${job.id} has failed with error:`, err.message);
});

summarizationWorker.on('error', (err) => {
  console.error('Worker error:', err);
});

console.log('Summarization worker started and listening for jobs...');

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing worker');
  await summarizationWorker.close();
  await connection.quit();
  await prisma.$disconnect();
  console.log('Worker closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing worker');
  await summarizationWorker.close();
  await connection.quit();
  await prisma.$disconnect();
  console.log('Worker closed');
  process.exit(0);
});
