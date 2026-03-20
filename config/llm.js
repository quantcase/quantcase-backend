'use strict';

const OpenAI = require('openai');

/**
 * OpenRouter client configured to route exclusively through Anthropic native.
 * Using OpenRouter avoids Bedrock limitations (e.g. no PDF support).
 */
const openRouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey:  process.env.OPENROUTER_API_KEY,
});

module.exports = openRouter;
