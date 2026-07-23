# LLM Integration

Every LLM call in the backend goes through **one function** — `llmStream` in [`utils/workerUtils.js`](../utils/workerUtils.js). It always streams `chat.completions`, accumulates the deltas into a single string, captures token usage, and by default routes to **OpenRouter**. The three L1 summarization workers can opt their Gemini calls onto **Vertex AI** instead. Nothing else in the codebase talks to a provider SDK directly.

## `llmStream(params, opts)`

```js
const { text, usage } = await llmStream(
  { model, max_tokens, messages, response_format },  // OpenAI chat.completions params
  { vertex: true },                                  // opts — only L1 workers pass this
);
```

- **Always streaming.** `runChatStream` opens `client.chat.completions.create({ ...params, stream: true })`, iterates chunks, and concatenates `chunk.choices[0].delta.content`. Streaming keeps the HTTP connection alive across long (multi-minute) generations that would otherwise time out.
- **Usage capture.** The final chunk's `usage` (tokens, and OpenRouter's `cost`) is returned alongside `text`; `logUsage(tag, usage)` prints it.
- **Truncation is an error.** If a stream ends with `finish_reason === 'length'`, `llmStream` **throws** rather than returning a partial/invalid JSON body. This is what surfaces as the "Response truncated at token limit" failures in `pipeline_job_failures` — the fix is smaller inputs, not silently accepting a cut-off answer.
- **Returns raw text.** Callers pass the result through `parseJson` (below) to get the structured object.

### Helpers exported alongside it

| Helper | Purpose |
|--------|---------|
| `parseJson(text)` | Strips a ```` ```json ```` … ```` ``` ```` fence if present, then `JSON.parse`; throws with a 500-char snippet on failure. |
| `logUsage(tag, usage)` | Logs `prompt/completion/total` tokens and `cost` from the final stream chunk. |
| `applyMultiplier(val, mult)` | Normalises an LLM numeric value by its unit multiplier, rounded to 4 dp to kill float drift. |
| `computePeriodType(start, end)` | Derives `quarterly` / `half_yearly` / `annual` / `multi_year` from a date range. |
| `wlog` | Colourised console logger (`info` / `done` / `cost` / `warn` / `error`). |

## Routing: OpenRouter vs Vertex

The decision is made on the first line of `llmStream`:

```js
const useVertex = Boolean(opts.vertex) && isGeminiModel(params.model) && vertexEnabled();
```

All three conditions must hold to leave OpenRouter. `vertexEnabled()` is `VERTEX_GEMINI_ENABLED === 'true' && GCP_PROJECT_ID` set. So the switch is **fully reversible by env** — with the flag off (or a non-Gemini model, or a caller that didn't pass `{ vertex: true }`) everything transparently stays on OpenRouter.

```mermaid
flowchart TD
  call["llmStream(params, opts)"]
  q1{"opts.vertex === true?"}
  q2{"isGeminiModel(params.model)?"}
  q3{"VERTEX_GEMINI_ENABLED=true<br/>AND GCP_PROJECT_ID set?"}
  or["OpenRouter<br/>config/llm.js<br/>(routed Anthropic-native)"]
  vx["Vertex AI<br/>config/vertexLlm.js<br/>(Gemini, GCP ADC auth)"]

  call --> q1
  q1 -- no --> or
  q1 -- yes --> q2
  q2 -- no --> or
  q2 -- yes --> q3
  q3 -- no --> or
  q3 -- yes --> vx
```

**Who passes `{ vertex: true }`?** Only the three L1 summarization workers: [`summarization_v2.js`](../workers/summarization_v2.js), [`summarization_v2_ppt.js`](../workers/summarization_v2_ppt.js), [`summarization_v2_annual_report.js`](../workers/summarization_v2_annual_report.js). Everything else — L2 `lensComposer`, L3 `aiInsightSynthesis` / `overviewSynthesis` / `technicals`, `postHtmlAnalysis`, the HTML skills, WealthOS, screener — omits the flag and always uses OpenRouter.

### OpenRouter path

[`config/llm.js`](../config/llm.js) is an `openai` SDK client pointed at `https://openrouter.ai/api/v1`, authed with `OPENROUTER_API_KEY`. OpenRouter is used specifically because it routes **Anthropic-native** (avoiding Bedrock's lack of PDF support), so Anthropic model IDs (e.g. the Claude models named in `lens_configs` / skill rows) and PDF `{type:"file"}` blocks work as-is.

### Vertex path

[`config/vertexLlm.js`](../config/vertexLlm.js) is an `openai` SDK client pointed at Vertex's OpenAI-compatible endpoint:

```
https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/endpoints/openapi
```

(`LOCATION="global"` uses the bare `aiplatform.googleapis.com` host.) Key behaviours:

- **Auth via GCP ADC.** No static key — the real credential is a short-lived OAuth2 Bearer token fetched per request from `google-auth-library` (`getVertexAccessToken`), which caches and auto-refreshes it. Locally: `gcloud auth application-default login`; in prod: a service account with the *Vertex AI User* role. The client's `apiKey` is a placeholder; the token is passed as an `Authorization` header on each call.
- **Model preference, not the skill's model.** The Vertex path ignores the per-skill DB model and walks `env.vertexGeminiModels` (default `google/gemini-3.5-flash`, then `google/gemini-2.5-flash-lite`). If a model returns a "not offered on Vertex" error (`isModelUnavailableError` — 404 or a not-found message), it is marked unavailable in an in-process `Set` (`markModelUnavailable`) and the loop falls through to the next candidate; later calls skip the dead probe.
- **PDF block rewrite.** OpenRouter accepts PDFs as `{type:"file", file:{file_data:"data:application/pdf;base64,…"}}`; Vertex rejects that (`400 Unrecognized 'type' field … 'file'`). `toVertexMessages` rewrites those into `{type:"image_url", image_url:{url:"data:application/pdf;base64,…"}}`, which Gemini reads fine. The L1 workers build the same PDF payload for both paths — the rewrite is invisible to them.
- **`max_tokens` clamp.** Vertex hard-`400`s (no body) on `max_tokens` above the Gemini output ceiling, so `llmStream` clamps to `GEMINI_MAX_OUTPUT_TOKENS = 65535`.

## Per-skill runtime config

`llmStream` receives `model`, `max_tokens`, and `response_format` from the caller — most workers get these from the **database**, not from code, via `loadSkillConfig(slug)` ([`utils/skillConfig.js`](../utils/skillConfig.js)):

- Reads a row from the `skills` table keyed by `slug` (e.g. `summarization-v2`, `ai-insight-synthesis`, `overview-synthesis`, `technical-intelligence`), returning `{ model, maxTokens, outputSchema, promptKey, promptTemplate, updatedAt }`.
- Cached in-process for 60 s to avoid a DB hit per job.
- `promptKey` is resolved to an actual prompt-builder function through [`lib/skillsRegistry.js`](../lib/skillsRegistry.js) (`SKILLS_REGISTRY` / `getPromptFn`) — prompts are dynamic JS functions taking context args, so they can't be stored as raw text; the DB stores a key + an optional `promptTemplate` string the function interpolates.
- `skill.updatedAt` feeds `computePromptVersion` → `prompt_v`, which is baked into downstream cache keys so editing a prompt invalidates stale outputs (see [pipeline.md](./pipeline.md#caching--invalidation)).

Structured output uses OpenAI-style `response_format` (JSON-schema) objects from [`outputSchemas/`](../outputSchemas) (e.g. `lens.js`, `aiInsight.js`, `overview.js`) — or a schema stored on the skill/lens/config row itself.

## Adding an LLM-backed step

1. Add a `skills` row (model, maxTokens, promptKey, optional outputSchema/promptTemplate) and register the prompt function in `lib/skillsRegistry.js` if it's a new key.
2. In the worker: `const cfg = await loadSkillConfig('your-slug')`, build the prompt, call `llmStream({ model: cfg.model, max_tokens: cfg.maxTokens, messages, response_format: cfg.outputSchema })`, then `parseJson`.
3. Only pass `{ vertex: true }` if the step is a Gemini/PDF extraction that should draw on GCP credits.
4. Bake a `source_hash` / `prompt_v` cache check in front of the LLM call so unchanged inputs skip it.

## See also

- [pipeline.md](./pipeline.md) — where each `llmStream` call sits in L1 → L2 → L3
- [configuration.md](./configuration.md) — `OPENROUTER_API_KEY`, `VERTEX_GEMINI_ENABLED`, `GCP_PROJECT_ID`, `VERTEX_GEMINI_MODELS` and related env vars
- [architecture.md](./architecture.md) — the worker process that hosts these calls
