require('dotenv').config();
const prisma   = require('../lib/prisma');
const jobQueue = require('../lib/jobQueue');

const TARGET_IDS = [
  'MOTILALOFS_FY2024_Q4', 'MOTILALOFS_FY2025_Q1', 'MOTILALOFS_FY2025_Q2',
  'ANGELONE_FY2025_Q1',   'ANGELONE_FY2025_Q4',   'ANGELONE_FY2026_Q1',
  'IIFLCAPS_FY2024_Q4',   'IIFLCAPS_FY2025_Q4',   'IIFLCAPS_FY2026_Q1'
];

async function run() {
  const calls = await prisma.earnings_calls.findMany({
    where:  { id: { in: TARGET_IDS } },
    select: { id: true, company: true, company_name: true, transcript_text: true, ppt_text: true, quarterly_result_url: true }
  });

  console.log(`Found ${calls.length} / ${TARGET_IDS.length} calls in DB`);

  const found    = new Set(calls.map(c => c.id));
  const missing  = TARGET_IDS.filter(id => !found.has(id));
  if (missing.length > 0) console.warn('Missing call IDs:', missing);

  const results = await Promise.allSettled(calls.map(async call => {
    const hasText = Boolean(call.transcript_text || call.ppt_text);
    const summarizationData = {
      callId:         call.id,
      type:           'summarization',
      companyName:    call.company_name || call.company,
      transcriptText: call.transcript_text,
      pptText:        call.ppt_text
    };

    if (hasText) {
      const flow = await jobQueue.addFlow({
        name:      'qe_extraction',
        queueName: 'qe_extraction',
        data:      { callId: call.id, type: 'qe_extraction' },
        children:  [{ name: 'summarization', queueName: 'summarization', data: summarizationData }]
      });
      console.log('[FLOW] ' + call.id + ' — summarization -> qe_extraction');
      return { id: call.id, type: 'flow' };
    } else {
      const job = await jobQueue.addJob('qe_extraction', { callId: call.id, type: 'qe_extraction' });
      console.log('[QE]   ' + call.id + ' — qe only (no transcript)');
      return { id: call.id, type: 'qe_only' };
    }
  }));

  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error('FAILED ' + calls[i]?.id + ': ' + r.reason?.message);
  });

  await jobQueue.close();
  await prisma.$disconnect();
}

run().catch(console.error);
