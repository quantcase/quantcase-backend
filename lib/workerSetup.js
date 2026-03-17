require('dotenv').config();
const Redis = require('ioredis');
const { PrismaClient } = require('@prisma/client');
const OpenAI = require('openai');

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 50, 20000)
});

const prisma = new PrismaClient();
const openRouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

function parseJson(responseText) {
  if (!responseText || !responseText.trim()) {
    throw new Error('parseJson: LLM returned empty response');
  }
  const cleaned = responseText.match(/```json\s*([\s\S]*?)\s*```/)?.[1] ?? responseText.trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const snippet = cleaned.length > 500 ? cleaned.slice(0, 500) + '…' : cleaned;
    throw new Error(`parseJson: JSON.parse failed — ${err.message}\nResponse snippet:\n${snippet}`);
  }
}

// Always route to Anthropic native — avoids Bedrock which has different limitations (no PDF support etc.)
async function llmStream(params) {
  const stream = await openRouter.chat.completions.create({
    ...params,
    stream: true,
    provider: { order: ['Anthropic'], allow_fallbacks: false }
  });
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
  return text;
}

// Normalize a raw LLM value by its multiplier, rounding to 4 decimal places
// to eliminate float-multiply drift (e.g. 4572.19 * 10000000 = 45721899999.99999).
function applyMultiplier(llmVal, mult) {
  return parseFloat((llmVal * mult).toFixed(4));
}

// Derive period type from start/end dates at ingestion time.
// Days are inclusive: quarterly ~91, half-yearly ~182, annual ~365.
function computePeriodType(startDate, endDate) {
  if (!startDate || !endDate) return 'snapshot';
  const days = (new Date(endDate) - new Date(startDate)) / 86400000;
  if (days <= 100) return 'quarterly';
  if (days <= 200) return 'half_yearly';
  if (days <= 400) return 'annual';
  return 'multi_year';
}

module.exports = { connection, prisma, openRouter, parseJson, llmStream, computePeriodType, applyMultiplier };
