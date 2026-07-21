#!/usr/bin/env node
'use strict';

/**
 * Smoke-test the Vertex AI OpenAI-compatible endpoint used by the L1 pipeline.
 *
 * Probes each model in VERTEX_GEMINI_MODELS (default: gemini-3.5-flash, then
 * gemini-2.5-flash-lite) with a tiny request and reports which are available on
 * Vertex — so you can confirm auth, endpoint, region, and model IDs before
 * flipping VERTEX_GEMINI_ENABLED=true on the workers.
 *
 * Runs regardless of the VERTEX_GEMINI_ENABLED flag — it only needs
 * GCP_PROJECT_ID set and working ADC credentials.
 *
 * Usage:
 *   node scripts/testVertexGemini.js
 *
 * Prereqs:
 *   - GCP_PROJECT_ID (and optionally GCP_VERTEX_LOCATION, default "global")
 *   - ADC: `gcloud auth application-default login`  (or GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json>)
 *   - The Vertex AI API enabled on the project + "Vertex AI User" role
 */

require('dotenv').config();
const env = require('../config/env');
const {
  getVertexClient, getVertexAccessToken, toVertexModel, isModelUnavailableError,
} = require('../config/vertexLlm');

async function main() {
  if (!env.gcpProjectId) {
    console.error('✗ GCP_PROJECT_ID is not set. Add it to .env and retry.');
    process.exit(1);
  }

  const loc  = env.gcpVertexLocation;
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  console.log('Vertex config:');
  console.log(`  project        : ${env.gcpProjectId}`);
  console.log(`  location       : ${loc}`);
  console.log(`  endpoint host  : ${host}`);
  console.log(`  routing enabled: ${env.vertexGeminiEnabled}  (VERTEX_GEMINI_ENABLED)`);
  console.log(`  model prefs    : ${env.vertexGeminiModels.join(', ')}`);
  console.log('');

  let token;
  try {
    token = await getVertexAccessToken();
    console.log(`✓ Obtained GCP access token (len ${token.length}).\n`);
  } catch (err) {
    console.error(`✗ Could not obtain a GCP access token: ${err.message}`);
    process.exit(1);
  }

  const client  = getVertexClient();
  const reqOpts = { headers: { Authorization: `Bearer ${token}` } };

  const results = [];
  for (const configured of env.vertexGeminiModels) {
    const model = toVertexModel(configured);
    process.stdout.write(`Probing ${model} ... `);
    try {
      const resp = await client.chat.completions.create(
        {
          model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        },
        reqOpts,
      );
      const text  = resp.choices?.[0]?.message?.content?.trim() ?? '(empty)';
      const usage = resp.usage
        ? `${resp.usage.prompt_tokens ?? '?'} in / ${resp.usage.completion_tokens ?? '?'} out`
        : 'n/a';
      console.log(`AVAILABLE — reply: ${JSON.stringify(text)} | tokens: ${usage}`);
      results.push({ model, available: true });
    } catch (err) {
      const status = err?.status ?? '?';
      const kind   = isModelUnavailableError(err) ? 'UNAVAILABLE' : 'ERROR';
      console.log(`${kind} (HTTP ${status}) — ${err.message}`);
      results.push({ model, available: false, kind });
    }
  }

  console.log('');
  const firstAvailable = results.find((r) => r.available);
  if (firstAvailable) {
    console.log(`✓ L1 Vertex calls will use: ${firstAvailable.model}`);
    console.log('  (set VERTEX_GEMINI_ENABLED=true to route the L1 workers through Vertex)');
    process.exit(0);
  } else {
    console.error('✗ No configured model is available on Vertex. Check the model IDs in ' +
      'VERTEX_GEMINI_MODELS, the region, and that the models are enabled in Model Garden.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
