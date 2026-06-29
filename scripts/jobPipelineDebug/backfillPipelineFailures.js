'use strict';

/**
 * Backfills pipeline_job_failures from BullMQ Redis for jobs that already failed
 * before the on('failed') DB handler was added.
 *
 * Run on each machine that has a Redis instance:
 *   node scripts/jobPipelineDebug/backfillPipelineFailures.js
 */

const { Queue } = require('bullmq');
const prisma = require('../../config/prisma');
const connection = require('../../config/redis');

const QUEUES = [
  { name: 'summarization_v2',               sourceDocType: 'transcript',    callIdKey: 'callId'   },
  { name: 'summarization_v2_ppt',           sourceDocType: 'ppt',           callIdKey: 'callId'   },
  { name: 'summarization_v2_annual_report', sourceDocType: 'annual_report', callIdKey: 'reportId' },
];

async function main() {
  let total = 0;

  for (const { name, sourceDocType, callIdKey } of QUEUES) {
    const queue = new Queue(name, { connection });
    const failed = await queue.getFailed(0, 10000);
    console.log(`[${name}] ${failed.length} failed jobs in Redis`);

    for (const job of failed) {
      if (job.attemptsMade < (job.opts.attempts ?? 1)) continue; // still had retries left

      const d = job.data ?? {};
      try {
        await prisma.pipelineJobFailure.upsert({
          where:  { bullmq_job_id: String(job.id) },
          create: {
            queue:           name,
            bullmq_job_id:   String(job.id),
            call_id:         d[callIdKey]   ?? '',
            source_doc_type: sourceDocType,
            chunk_index:     d.chunkIndex   ?? null,
            total_chunks:    d.totalChunks  ?? null,
            lineage_id:      d.lineageId    ?? null,
            error_message:   job.failedReason ?? null,
            attempts_made:   job.attemptsMade,
            failed_at:       job.finishedOn ? new Date(job.finishedOn) : new Date(),
          },
          update: {}, // don't overwrite existing backfill rows
        });
        total++;
      } catch (e) {
        console.error(`Failed to upsert job ${job.id}: ${e.message}`);
      }
    }

    await queue.close();
  }

  console.log(`Done — ${total} failures written to pipeline_job_failures`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
