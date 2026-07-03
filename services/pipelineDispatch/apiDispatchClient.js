'use strict';

const API_URL = process.env.API_URL || 'http://localhost:8000';

// POST to a summarize-v2 style endpoint (calls/ppt/annual-report) and normalize errors.
async function dispatchEndpoint(path, { timeoutMs = 30_000 } = {}) {
  const res  = await fetch(`${API_URL}${path}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

module.exports = { API_URL, dispatchEndpoint };
