require('dotenv').config();
const prisma = require('../lib/prisma');
const jobQueue = require('../lib/jobQueue');

const BATCH_SIZE = 8;

async function run() {
  const calls = await prisma.earnings_calls.findMany({
    orderBy: { created_at: 'desc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      company: true,
      company_name: true,
      quarter: true,
      fiscal_year: true,
      transcript_text: true,
      ppt_text: true,
      quarterly_result_url: true
    }
  });

  console.log(`Queuing ${calls.length} calls...\n`);

  const results = await Promise.allSettled(
    calls.map(async (call) => {
      const hasText = !!(call.transcript_text || call.ppt_text);
      const hasQe   = !!call.quarterly_result_url?.trim();

      if (!hasText) {
        console.warn(`[SKIP] ${call.id} — no transcript or PPT text`);
        return { id: call.id, skipped: true };
      }

      const summarizationData = {
        callId:         call.id,
        type:           'summarization',
        companyName:    call.company_name || call.company,
        transcriptText: call.transcript_text,
        pptText:        call.ppt_text
      };

      if (hasQe) {
        const flow = await jobQueue.addFlow({
          name:      'qe_extraction',
          queueName: 'qe_extraction',
          data:      { callId: call.id, type: 'qe_extraction' },
          children:  [{ name: 'summarization', queueName: 'summarization', data: summarizationData }]
        });
        console.log(`[FLOW] ${call.id} — summarization → qe_extraction`);
        return { id: call.id, type: 'flow', qeJobId: flow.job.id };
      }

      const job = await jobQueue.addJob('summarization', summarizationData);
      console.log(`[JOB]  ${call.id} — summarization only`);
      return { id: call.id, type: 'job', jobId: job.id };
    })
  );

  console.log('\n── Summary ──────────────────────────');
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const v = r.value;
      if (v.skipped) console.log(`SKIPPED  ${v.id}`);
      else           console.log(`QUEUED   ${v.id} (${v.type})`);
    } else {
      console.error(`FAILED   ${calls[i].id}: ${r.reason?.message}`);
    }
  });

  await jobQueue.close();
  await prisma.$disconnect();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
