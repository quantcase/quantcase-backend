'use strict';

/**
 * CMIE Prowess batch API client — SendBatch / GetBatch / AbortAll / GetReport.
 *
 * Endpoints only accept multipart/form-data (apikey + a proprietary binary
 * batchfile the admin uploads as-is — we never construct this file ourselves,
 * see prowess_mappers/ProwessUploader.js docblock for why).
 *
 * Confirmed response shapes (verified against a real SendBatch/GetBatch round
 * trip, no `format` param needed on either call):
 *   SendBatch → always JSON: { errcode: 0, errdesc: "...", token: "..." }
 *               (errcode !== 0 means the submission itself was rejected)
 *   GetBatch  → Content-Type gated:
 *               application/json  → NOT READY yet: { message, errcode, errdesc }
 *               anything else     → READY: raw body is the result ZIP file
 *
 * SendBatch is the expensive call — this client does not retry anything.
 * Retry/no-retry policy is the caller's responsibility.
 */

const fs   = require('fs');
const path = require('path');
const env  = require('../../config/env');

function assertConfigured() {
  if (!env.prowessApiKey) {
    throw new Error('PROWESS_API_KEY is not set — cannot call the Prowess API');
  }
}

// A bare Blob has no filename, so the multipart part would be missing
// `filename="..."` in its Content-Disposition header — CMIE's server needs
// that to recognize the batchfile part (confirmed: omitting it produced a
// generic "authentication failure" response instead of a file-related one).
function fileField(filePath) {
  const buf = fs.readFileSync(filePath);
  return new File([buf], path.basename(filePath), { type: 'application/octet-stream' });
}

async function postForm(path, fields) {
  assertConfigured();
  const url = `${env.prowessApiBaseUrl}${path}`;
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, value);
  }
  const res = await fetch(url, { method: 'POST', body: form });
  const contentType = res.headers.get('content-type') || '';
  return { res, contentType, ok: res.ok, status: res.status };
}

/** Always-JSON endpoints (SendBatch, AbortAll). */
async function postFormJson(path, fields) {
  const { res, ok, status } = await postForm(path, fields);
  const rawBody = await res.text();
  let json = null;
  try { json = rawBody ? JSON.parse(rawBody) : null; } catch { /* non-JSON body */ }
  return { ok, status, json, rawBody };
}

/**
 * Submit a batch file. Returns { ok, status, json: {errcode, errdesc, token}, rawBody }.
 * format='json' asks CMIE to return .json result files (meta/head/data) instead of
 * pipe-delimited .txt — only honored for OSC/WS-type query outputs per CMIE's docs.
 */
async function sendBatch(batchFilePath, { format } = {}) {
  return postFormJson('/sendbatch', {
    apikey: env.prowessApiKey,
    batchfile: fileField(batchFilePath),
    format,
  });
}

/**
 * Poll a previously submitted batch by token. Branches on Content-Type since
 * "not ready" is JSON and "ready" is a raw ZIP body.
 * Returns { ok, status, ready, json, buffer } — json set when not ready,
 * buffer (Node Buffer) set when ready.
 */
async function getBatch(token) {
  const { res, contentType, ok, status } = await postForm('/getbatch', {
    apikey: env.prowessApiKey,
    token,
  });

  if (contentType.includes('application/json')) {
    const rawBody = await res.text();
    let json = null;
    try { json = rawBody ? JSON.parse(rawBody) : null; } catch { /* non-JSON body */ }
    return { ok, status, ready: false, json, rawBody, buffer: null };
  }

  const arrayBuffer = await res.arrayBuffer();
  return { ok, status, ready: true, json: null, buffer: Buffer.from(arrayBuffer) };
}

/** Cancel all currently pending batches for this API key. */
async function abortAll() {
  return postFormJson('/abortall', {
    apikey: env.prowessApiKey,
  });
}

/** Synchronous single-company report — still requires a batchfile per CMIE's spec. Untested against the live API so far. */
async function getReport(company, batchFilePath, { format = 'json' } = {}) {
  return postFormJson('/getreport', {
    apikey: env.prowessApiKey,
    company,
    batchfile: fileField(batchFilePath),
    format,
  });
}

module.exports = { sendBatch, getBatch, abortAll, getReport };
