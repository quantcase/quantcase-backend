'use strict';

const { internalAuthHeaders } = require('../../lib/internalAuth');

const API_URL = process.env.API_URL || 'http://localhost:8000';

// POST to an internal admin/API endpoint and normalize errors. `body` is
// optional — L1's summarize-v2 style endpoints take everything from the URL
// path and send nothing; routes that need a JSON body (e.g. html-incremental-
// skills' /run, which takes ticker/callId in the body) pass one.
// Every call carries an internal service JWT — the global auth gate rejects
// unauthenticated requests, self-calls included.
async function dispatchEndpoint(path, { timeoutMs = 30_000, body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method:  'POST',
    headers: {
      ...internalAuthHeaders(),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body:    body !== undefined ? JSON.stringify(body) : undefined,
    signal:  AbortSignal.timeout(timeoutMs),
  });
  const respBody = await res.json();
  if (!res.ok) throw new Error(respBody.error ?? `HTTP ${res.status}`);
  return respBody;
}

module.exports = { API_URL, dispatchEndpoint };
