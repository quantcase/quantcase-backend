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

module.exports = { connection, prisma, openRouter, parseJson, llmStream };
