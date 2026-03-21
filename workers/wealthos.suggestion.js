'use strict';

const { Worker }    = require('bullmq');
const connection    = require('../config/redis');
const prisma        = require('../config/prisma');
const { llmStream, parseJson } = require('../utils/workerUtils');
const { suggestionGenerationPrompt } = require('../prompts/wealthos/suggestion_generation');
const { wealthosSuggestionSchema }   = require('../outputSchemas/wealthos.suggestion');
const { validateSuggestionOutput }   = require('../services/wealthos/compliance.service');

const MODEL     = 'anthropic/claude-sonnet-4-6';
const MAX_TOKENS = 8000;

async function processSuggestionJob(job) {
  const { clients, rmId } = job.data;
  console.log(`[wealthos_suggestion] Job ${job.id}: processing ${clients.length} clients`);

  await job.updateProgress(10);

  const prompt = suggestionGenerationPrompt(clients);
  console.log(`[wealthos_suggestion] Prompt length: ${prompt.length} chars`);

  await job.updateProgress(25);

  const responseText = await llmStream({
    model:           MODEL,
    max_tokens:      MAX_TOKENS,
    messages:        [{ role: 'user', content: prompt }],
    response_format: wealthosSuggestionSchema,
  });

  await job.updateProgress(60);

  if (!responseText) throw new Error('Empty response from LLM');

  const suggestions = parseJson(responseText);

  if (!Array.isArray(suggestions)) {
    throw new Error('LLM response is not an array');
  }

  await job.updateProgress(70);

  // Compliance validation — reject the batch if any suggestion violates guardrails
  for (const s of suggestions) {
    const clientEntry  = clients.find(c => c.clientId === s.client_id);
    const allowedSymbols = clientEntry?.portfolioData?.holdings
      ? clientEntry.portfolioData.holdings.map(h => h.symbol).filter(Boolean)
      : [];

    const { valid, violations } = validateSuggestionOutput(s, allowedSymbols);
    if (!valid) {
      throw new Error(
        `Compliance violation for client ${s.client_id}: ${violations.join('; ')}`
      );
    }
  }

  await job.updateProgress(80);

  // Persist suggestions to DB
  const savedIds = [];
  for (const s of suggestions) {
    const clientEntry = clients.find(c => c.clientId === s.client_id);
    const record = await prisma.wealthSuggestion.create({
      data: {
        client_id:        s.client_id,
        priority:         s.priority,
        reason:           s.reason,
        suggested_action: s.suggested_action,
        talking_points:   s.talking_points,
        message:          s.message,
        status:           'pending',
        score:            clientEntry?.score ?? 0,
        job_id:           job.id,
      },
    });
    savedIds.push(record.id);
  }

  await job.updateProgress(100);
  console.log(`[wealthos_suggestion] Job ${job.id} done — saved ${savedIds.length} suggestions`);
  return { saved: savedIds };
}

const worker = new Worker('wealthos_suggestion', processSuggestionJob, {
  connection,
  concurrency: 2,
  limiter: { max: 5, duration: 1000 },
});

worker.on('completed', job      => console.log(`[wealthos_suggestion] Job ${job.id} completed`));
worker.on('failed',    (job, e) => console.error(`[wealthos_suggestion] Job ${job.id} failed:`, e.message));
worker.on('error',     err      => console.error('[wealthos_suggestion] Worker error:', err));

console.log('WealthOS suggestion worker ready');

module.exports = worker;
