'use strict';

const { Worker }    = require('bullmq');
const connection    = require('../config/redis');
const prisma        = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { messageGenerationPrompt } = require('../prompts/wealthos/message_generation');
const { wealthosMessageSchema }   = require('../outputSchemas/wealthos.message');
const { validateMessageOutput }   = require('../services/wealthos/compliance.service');

const MODEL      = 'anthropic/claude-sonnet-4-6';
const MAX_TOKENS = 2000;

async function processMessageJob(job) {
  const { clientId, client, portfolio, interactions, channel, context, rmId } = job.data;
  console.log(`[wealthos_message] Job ${job.id}: generating ${channel} message for client ${clientId}`);

  await job.updateProgress(15);

  const prompt = messageGenerationPrompt(client, portfolio, interactions ?? [], channel, context);

  await job.updateProgress(30);

  const responseText = await llmStream({
    model:           MODEL,
    max_tokens:      MAX_TOKENS,
    messages:        [{ role: 'user', content: prompt }],
    response_format: wealthosMessageSchema,
  });

  await job.updateProgress(70);

  if (!responseText) throw new Error('Empty response from LLM');

  const message = parseJson(responseText);

  // Compliance validation
  const { valid, violations } = validateMessageOutput(message);
  if (!valid) {
    throw new Error(`Compliance violation in generated message: ${violations.join('; ')}`);
  }

  await job.updateProgress(85);

  // Store generated message as a WealthAction record
  const action = await prisma.wealthAction.create({
    data: {
      client_id:   clientId,
      rm_id:       rmId ?? null,
      action_type: 'generated_message',
      content:     message.body,
      outcome:     null,
    },
  });

  await job.updateProgress(100);
  console.log(`[wealthos_message] Job ${job.id} done — action ${action.id}`);

  return {
    action_id: action.id,
    message,
  };
}

const worker = new Worker('wealthos_message', processMessageJob, {
  connection,
  concurrency: 3,
  limiter: { max: 10, duration: 1000 },
});

worker.on('completed', job      => console.log(`[wealthos_message] Job ${job.id} completed`));
worker.on('failed',    (job, e) => console.error(`[wealthos_message] Job ${job.id} failed:`, e.message));
worker.on('error',     err      => console.error('[wealthos_message] Worker error:', err));

console.log('WealthOS message worker ready');

module.exports = worker;
