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
 * Stream an LLM request through OpenRouter, routing exclusively to Anthropic native.
 * Avoids Bedrock which has different limitations (e.g. no PDF support).
 */
async function llmStream(params) {
  let stream;
  try {
    stream = await openRouter.chat.completions.create({
      ...params,
      stream:   true,
    });
  } catch (err) {
    const body = err?.error ?? err?.response?.data ?? err?.message;
    console.error('[llmStream] API error:', JSON.stringify(body, null, 2));
    throw err;
  }
  let text = '';
  let finishReason;
  try {
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    }
  } catch (err) {
    const body = err?.error ?? err?.response?.data ?? err?.message;
    console.error('[llmStream] stream error:', JSON.stringify(body, null, 2));
    throw err;
  }
  if (finishReason === 'length') {
    throw new Error(`[llmStream] Response truncated at token limit (finish_reason=length, ${text.length} chars). Increase maxTokens or reduce input.`);
  }
  return text;
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

module.exports = { parseJson, llmStream, applyMultiplier, computePeriodType };
