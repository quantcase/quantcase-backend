'use strict';

const OpenAI = require('openai');
const { GoogleAuth } = require('google-auth-library');
const env = require('./env');

/**
 * Vertex AI OpenAI-compatible client for Gemini, used to route the L1 pipeline's
 * Gemini calls through Google Cloud (so they draw on GCP credits) instead of
 * OpenRouter. Only the L1 summarization workers opt in (they pass
 * `{ vertex: true }` to llmStream); everything else stays on OpenRouter.
 *
 * Auth is GCP Application Default Credentials (ADC): a short-lived OAuth2 access
 * token, refreshed automatically by google-auth-library. There is NO static API
 * key. Locally run `gcloud auth application-default login`; in production run
 * under a service account (GOOGLE_APPLICATION_CREDENTIALS, or the runtime's
 * attached identity) with the "Vertex AI User" role.
 *
 * Endpoint shape (per Google's OpenAI-compatibility docs):
 *   https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/endpoints/openapi
 *   (LOCATION="global" uses the host aiplatform.googleapis.com)
 * The OpenAI SDK appends /chat/completions. Gemini model IDs keep the
 * `google/` prefix (e.g. "google/gemini-2.5-flash-lite"), and PDF input uses the
 * same `data:application/pdf;base64,...` block the workers already build.
 */

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

let _client = null;
let _auth   = null;
// Vertex models proven unavailable this process (404 / not-found). Once a model
// in the preference list fails this way, we skip it on subsequent calls instead
// of re-probing (and re-paying the latency) every time.
const _unavailable = new Set();

/** True only when Vertex routing is switched on and a project is configured. */
function vertexEnabled() {
  return Boolean(env.vertexGeminiEnabled && env.gcpProjectId);
}

function buildBaseURL() {
  const loc  = env.gcpVertexLocation;
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${env.gcpProjectId}/locations/${loc}/endpoints/openapi`;
}

/** Singleton OpenAI client pointed at Vertex. The real credential is the
 *  per-request Bearer token (see getVertexAccessToken) — apiKey is a placeholder. */
function getVertexClient() {
  if (!_client) {
    _client = new OpenAI({ baseURL: buildBaseURL(), apiKey: 'vertex-adc-placeholder' });
  }
  return _client;
}

/** Fetch a valid GCP access token. google-auth-library caches and refreshes it. */
async function getVertexAccessToken() {
  if (!_auth) _auth = new GoogleAuth({ scopes: SCOPE });
  const token = await _auth.getAccessToken();
  if (!token) {
    throw new Error('[vertexLlm] Could not obtain a GCP access token — check ADC ' +
      '(`gcloud auth application-default login`) or GOOGLE_APPLICATION_CREDENTIALS.');
  }
  return token;
}

/** Vertex requires the `google/` provider prefix on Gemini model IDs. */
function toVertexModel(model) {
  return model.startsWith('google/') ? model : `google/${model}`;
}

function isGeminiModel(model) {
  return typeof model === 'string' && (model.startsWith('google/') || model.startsWith('gemini'));
}

/**
 * Vertex's OpenAI-compatible endpoint does NOT accept the `type: "file"` content
 * block that OpenRouter uses for PDFs — it 400s with
 * "Unrecognized 'type' field ... found: 'file'". It expects inline media
 * (including PDFs) as an `image_url` block whose URL is the
 * `data:<mime>;base64,...` URI. This converts the L1 workers' existing PDF
 * payloads so they work unchanged on Vertex.
 */
function toVertexContentBlock(block) {
  if (block && block.type === 'file' && block.file && block.file.file_data) {
    return { type: 'image_url', image_url: { url: block.file.file_data } };
  }
  return block;
}

function toVertexMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) =>
    (m && Array.isArray(m.content)) ? { ...m, content: m.content.map(toVertexContentBlock) } : m,
  );
}

/** Ordered model preference for L1 Vertex calls, with known-unavailable models
 *  dropped. If every configured model has been flagged unavailable, fall back to
 *  the full list so we still attempt (availability can change between runs). */
function vertexModelCandidates() {
  const all   = env.vertexGeminiModels.map(toVertexModel);
  const avail = all.filter((m) => !_unavailable.has(m));
  return avail.length ? avail : all;
}

function markModelUnavailable(model) {
  _unavailable.add(model);
}

/** Heuristic: does this error mean the model isn't offered on Vertex (so we
 *  should try the next candidate) vs. a genuine request error we must surface? */
function isModelUnavailableError(err) {
  if (err?.status === 404) return true;
  const msg = String(err?.message || '').toLowerCase();
  return /not found|not supported|does not exist|is not available|was not found|unknown model|no such model|publisher model/.test(msg);
}

module.exports = {
  vertexEnabled,
  getVertexClient,
  getVertexAccessToken,
  toVertexModel,
  isGeminiModel,
  toVertexMessages,
  vertexModelCandidates,
  markModelUnavailable,
  isModelUnavailableError,
};
