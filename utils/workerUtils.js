'use strict';

const openRouter = require('../config/llm');
const {
  vertexEnabled, getVertexClient, getVertexAccessToken,
  isGeminiModel, toVertexMessages, vertexModelCandidates, markModelUnavailable, isModelUnavailableError,
} = require('../config/vertexLlm');

// ─── Colored logger ───────────────────────────────────────────────────────────

const c = {
  gray:   s => `\x1b[90m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[1;33m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
};

const wlog = {
  info:  msg => console.log(c.gray(msg)),
  done:  msg => console.log(c.green(msg)),
  cost:  msg => console.log(c.yellow(msg)),
  warn:  msg => console.warn(c.cyan(msg)),
  error: msg => console.error(c.red(msg)),
};

// Vertex's OpenAI-compatible endpoint hard-rejects max_tokens above the Gemini
// output ceiling with a bare `400 (no body)` — 65536 for gemini-3.5-flash,
// 65535 for gemini-2.5-flash-lite. (OpenRouter silently clamped instead.) Since
// the candidate list may fall through to flash-lite, clamp to the lower ceiling.
const GEMINI_MAX_OUTPUT_TOKENS = 65535;

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
 * Stream an LLM request.
 *
 * By default this goes through OpenRouter. The L1 summarization workers pass
 * `{ vertex: true }` to route Gemini calls through Vertex AI's OpenAI-compatible
 * endpoint instead (GCP credits) — but only when Vertex is enabled AND the model
 * is a Gemini model; otherwise it transparently stays on OpenRouter. On the
 * Vertex path the model comes from the configured preference list
 * (env.vertexGeminiModels — default: gemini-3.5-flash, then gemini-2.5-flash-lite),
 * trying the next model when one isn't offered on Vertex.
 *
 * @param {object} params  OpenAI chat.completions params ({ model, max_tokens, messages, response_format? })
 * @param {{ vertex?: boolean }} [opts]
 */
async function llmStream(params, opts = {}) {
  const useVertex = Boolean(opts.vertex) && isGeminiModel(params.model) && vertexEnabled();

  if (!useVertex) {
    const openRouterParams = { ...params, stream: true };
    // Handle reasoning/thinking suppression for all OpenRouter models.
    // If the model string ends with :high or :low, strip the suffix and pass
    // it as an explicit effort level. Otherwise, disable reasoning entirely.
    //
    // IMPORTANT: `reasoning` must be a TOP-LEVEL key in openRouterParams, NOT
    // nested inside `extra_body`. The OpenAI Node SDK silently drops `extra_body`
    // in streaming mode for many SDK versions, meaning reasoning was never actually
    // disabled — DeepSeek was silently consuming the full token budget with thinking
    // tokens (which appear as `delta.thinking`, not `delta.reasoning_content`),
    // producing finish_reason='length' with 0 visible chars.
    const effortMatch = openRouterParams.model?.match(/^(.*):(high|low)$/);
    if (effortMatch) {
      openRouterParams.model = effortMatch[1];
      openRouterParams.reasoning = { effort: effortMatch[2] };
    } else {
      // Disable reasoning by default for all models on OpenRouter path.
      openRouterParams.reasoning = { enabled: false };
    }
    if (openRouterParams.model?.includes('deepseek')) {
      openRouterParams.provider = { ignore: ["Cloudflare"] };
    }
    return runChatStream(openRouter, openRouterParams, {}, 'OpenRouter');
  }

  // Vertex path: reuse one access token across the fallback attempts, and rewrite
  // OpenRouter-style PDF blocks ({type:"file"}) into Vertex's {type:"image_url"} form.
  const reqOpts    = { headers: { Authorization: `Bearer ${await getVertexAccessToken()}` } };
  const client     = getVertexClient();
  const messages   = toVertexMessages(params.messages);
  
  let candidates = vertexModelCandidates();
  // If the caller explicitly passed a specific model (not a generic 'gemini' placeholder), use it
  if (params.model && params.model !== 'gemini' && params.model !== 'google/gemini') {
    candidates = [toVertexModel(params.model)];
  }

  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    let maxCeiling = 8192;
    if (model.includes('3.5-flash') || model.includes('flash-lite')) {
      maxCeiling = 65535;
    }
    const maxTokens = Math.min(params.max_tokens ?? maxCeiling, maxCeiling);
    const body  = { ...params, model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
    try {
      return await runChatStream(client, body, reqOpts, `Vertex(${model})`);
    } catch (err) {
      const hasNext = i < candidates.length - 1;
      if (hasNext && isModelUnavailableError(err)) {
        markModelUnavailable(model);
        wlog.warn(`[llmStream] Vertex model "${model}" unavailable — falling back to "${candidates[i + 1]}"`);
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Open a streamed chat.completions request on `client` and accumulate the text.
 * @param {string} label  Provider/model label for error logs.
 */
async function runChatStream(client, requestBody, reqOpts, label) {
  let stream;
  try {
    stream = await client.chat.completions.create(requestBody, reqOpts);
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    const body   = err?.error ?? err?.response?.data ?? err?.message;
    const detail = typeof body === 'object' ? JSON.stringify(body) : String(body ?? err.message);
    console.error(`[llmStream] ${label} API error (HTTP ${status ?? '?'}):`, detail);
    if (status === 400 && requestBody.response_format) {
      console.error('[llmStream] response_format sent:', JSON.stringify(requestBody.response_format, null, 2));
    }
    const enriched    = new Error(`[llmStream] HTTP ${status ?? '?'}: ${detail}`);
    enriched.status   = status;
    enriched.original = err;
    throw enriched;
  }
  let text = '';
  let reasoningChars = 0;
  let finishReason;
  let usage = null;
  try {
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (typeof delta?.content === 'string') {
        text += delta.content;
      }
      
      // Track reasoning/thinking tokens from both field names:
      // - `reasoning_content` is the OpenRouter standard field
      // - `thinking` is DeepSeek's native streaming field (different providers use different names)
      if (typeof delta?.reasoning_content === 'string') {
        reasoningChars += delta.reasoning_content.length;
      }
      if (typeof delta?.thinking === 'string') {
        reasoningChars += delta.thinking.length;
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
  } catch (err) {
    const body   = err?.error ?? err?.response?.data ?? err?.message;
    const detail = typeof body === 'object' ? JSON.stringify(body) : String(body ?? err.message);
    console.error(`[llmStream] ${label} stream error:`, detail);
    const enriched    = new Error(`[llmStream] ${detail}`);
    enriched.status   = err?.status ?? err?.response?.status;
    enriched.original = err;
    throw enriched;
  }
  
  if (finishReason === 'length') {
    if (text.trim().length === 0) {
      throw new Error(
        `[llmStream] Output budget exhausted before visible content. ` +
        `Verify thinking={"type":"disabled"} and increase max_tokens. ` +
        `reasoningChars=${reasoningChars}`
      );
    }
    throw new Error(
      `[llmStream] Visible response truncated after ${text.length} chars. ` +
      `Increase max_tokens or continue generation from the partial response.`
    );
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
  wlog.cost(`[${tag}] tokens: ${prompt_tokens ?? '?'} in / ${completion_tokens ?? '?'} out / ${total_tokens ?? '?'} total${costStr}`);
}

module.exports = { parseJson, llmStream, logUsage, wlog, applyMultiplier, computePeriodType };
