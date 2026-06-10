'use strict';

const { Worker }    = require('bullmq');
const connection    = require('../config/redis');
const prisma        = require('../config/prisma');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { messageGenerationPrompt } = require('../prompts/wealthos/message_generation');
const { validateMessageOutput }   = require('../services/wealthos/compliance.service');
const { loadSkillConfig }         = require('../utils/skillConfig');

async function processMessageJob(job) {
  const { clientId, client, portfolio, interactions, channel, context, rmId } = job.data;
  console.log(`[wealthos_message] Job ${job.id}: generating ${channel} message for client ${clientId}`);

  await job.updateProgress(15);

  const { model, maxTokens, outputSchema, promptTemplate } = await loadSkillConfig('wealthos-message');
  const prompt = messageGenerationPrompt(client, portfolio, interactions ?? [], channel, context, promptTemplate);

  await job.updateProgress(30);
  const { text: responseText, usage } = await llmStream({
    model,
    max_tokens:      maxTokens,
    messages:        [{ role: 'user', content: prompt }],
    ...(outputSchema && { response_format: outputSchema }),
  });
  logUsage('wealthos_message', usage);

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
