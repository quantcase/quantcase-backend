'use strict';

const openRouter = require('../config/llm');

/**
 * Parse JSON from LLM response text, handling markdown code-fenced blocks.
 */
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

/**
 * Stream an LLM request through OpenRouter.
 */
async function llmStream(params) {
  let stream;
  try {
    stream = await openRouter.chat.completions.create({
      ...params,
      stream: true,
    });
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    const body   = err?.error ?? err?.response?.data ?? err?.message;
    console.error(`[llmStream] API error (HTTP ${status ?? '?'}):`, JSON.stringify(body, null, 2));
    // Log the full response_format that was sent so schema issues are immediately visible
    if (status === 400 && params.response_format) {
      console.error('[llmStream] response_format sent:', JSON.stringify(params.response_format, null, 2));
    }
    throw err;
  }
  let text = '';
  let finishReason;
  let usage = null;
  try {
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  } catch (err) {
    const body = err?.error ?? err?.response?.data ?? err?.message;
    console.error('[llmStream] stream error:', JSON.stringify(body, null, 2));
    throw err;
  }
  if (finishReason === 'length') {
    throw new Error(`[llmStream] Response truncated at token limit (finish_reason=length, ${text.length} chars). Increase maxTokens or reduce input.`);
  }
  return { text, usage };
}

/**
 * Normalize a raw LLM value by its multiplier, rounding to 4 decimal places
 * to eliminate float-multiply drift (e.g. 4572.19 * 10000000 = 45721899999.99999).
 */
function applyMultiplier(llmVal, mult) {
  return parseFloat((llmVal * mult).toFixed(4));
}

/**
 * Derive period type from start/end dates at ingestion time.
 * Days are inclusive: quarterly ~91, half-yearly ~182, annual ~365.
 */
function computePeriodType(startDate, endDate) {
  if (!startDate || !endDate) return 'snapshot';
  const days = (new Date(endDate) - new Date(startDate)) / 86400000;
  if (days <= 100) return 'quarterly';
  if (days <= 200) return 'half_yearly';
  if (days <= 400) return 'annual';
  return 'multi_year';
}

/**
 * Log OpenRouter usage stats (tokens + cost) returned in the final stream chunk.
 */
function logUsage(tag, usage) {
  if (!usage) return;
  const { prompt_tokens, completion_tokens, total_tokens, cost } = usage;
  const costStr = cost != null ? ` | cost: $${Number(cost).toFixed(6)}` : '';
  console.log(`[${tag}] tokens: ${prompt_tokens ?? '?'} in / ${completion_tokens ?? '?'} out / ${total_tokens ?? '?'} total${costStr}`);
}

module.exports = { parseJson, llmStream, logUsage, applyMultiplier, computePeriodType };
