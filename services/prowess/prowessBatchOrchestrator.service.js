'use strict';

/**
 * Shared SendBatch/GetBatch orchestration — used by both the admin-triggered
 * routes (controllers/admin.prowessBatch.controller.js) and the scheduler
 * poller (scheduler/handlers/prowessBatchPoll.js), so "what happens when a
 * batch resolves" lives in exactly one place.
 *
 * GetBatch response contract (confirmed against a real round trip):
 *   Content-Type: application/json → not ready yet, body is {message, errcode, errdesc}
 *   Content-Type: anything else    → ready, body is the raw result ZIP
 *
 * Only mode 'daily' (OHLCV/valuation, via prowessOhlcvCsvParser) is actually
 * parsed into DB rows so far — that's the shape this was verified against.
 * 'annual'/'quarterly' batches are marked completed with the zip's file list
 * captured in `result`, but not auto-ingested; feeding that into
 * prowess_values_new needs its own confirmed-format pass, same reasoning as
 * why this file didn't guess at GetBatch's shape before testing it for real.
 */

const path = require('path');
const AdmZip = require('adm-zip');

const apiClient = require('./prowessBatchApiClient');
const batchRequests = require('./prowessBatchRequests.service');
const { parseOhlcvCsv, parseOhlcvJson, buildNameToSymbolMap } = require('./prowessOhlcvCsvParser');
const { parseIndexCsv, parseIndexJson } = require('./prowessIndexCsvParser');
const { upsertBatch } = require('./prowessOhlcvIngester');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const IDENTITY_CSV = path.join(__dirname, '..', '..', 'lib', 'osc_identity.csv');
let _nameToSymbolCache = null;
function nameToSymbolMap() {
  if (!_nameToSymbolCache) _nameToSymbolCache = buildNameToSymbolMap(IDENTITY_CSV);
  return _nameToSymbolCache;
}

function extractToken(sendResponse) {
  return sendResponse.json?.token ? String(sendResponse.json.token) : null;
}

// Fixed daily OHLCV query, checked into the repo so it ships with every
// deploy instead of requiring an admin to re-upload the same .bt file each
// time -- see the file itself for field list; only fields
// prowessOhlcvCsvParser.js recognizes ever reach nse_equity_new, same as the
// CSV-upload path.
const DAILY_BATCH_FILE = path.join(__dirname, 'combined_ohlcv_new.bt');

/** Submits the fixed daily template -- no upload needed, resolves/ingests exactly like any other 'daily' batch (see pollAndResolve). */
async function triggerDailyBatch() {
  return sendBatchAndTrack({
    filePath: DAILY_BATCH_FILE,
    mode: 'daily',
    requestMeta: { source: 'daily-template', file: 'combined_ohlcv_new.bt' },
  });
}

async function sendBatchAndTrack({ filePath, mode, requestMeta }) {
  // JSON output (meta/head/data) is far more reliably parseable than CMIE's default
  // pipe-delimited .txt — only honored for OSC/WS-type outputs, which is what the
  // daily OHLCV query flow produces.
  const format = mode === 'daily' ? 'json' : undefined;
  const sendResponse = await apiClient.sendBatch(filePath, { format });
  if (!sendResponse.ok || sendResponse.json?.errcode !== 0) {
    throw new HttpError(502, `Prowess SendBatch failed: ${sendResponse.json?.errdesc || sendResponse.rawBody?.slice(0, 500)}`);
  }

  const token = extractToken(sendResponse);
  if (!token) {
    throw new HttpError(502, `Prowess SendBatch succeeded but no token was returned: ${sendResponse.rawBody?.slice(0, 500)}`);
  }

  const row = await batchRequests.createBatchRequest({ token, mode, requestMeta });
  return { row, rawSendResponse: sendResponse.json };
}

/**
 * CMIE returns a query-level failure (e.g. a batch file referencing session-bound
 * state the API can't resolve) as a normal 200 zip containing a TOKEN.err file —
 * not as a GetBatch-level error. Must be checked before treating a resolved zip
 * as a successful result.
 */
function findQueryError(zip) {
  const errEntry = zip.getEntries().find((e) => !e.isDirectory && e.entryName.endsWith('.err'));
  return errEntry ? errEntry.getData().toString('utf8').trim() : null;
}

/**
 * Parses a resolved OHLCV/valuation zip and upserts what it can into nse_equity_new.
 * CMIE's real batch output is .json (meta/head/data, requested via format=json — see
 * sendBatchAndTrack, confirmed against a real response) or pipe-delimited .txt by
 * default. .txt entries are captured but not parsed — that pipe-delimited layout
 * isn't documented in enough detail to parse without guessing.
 */
async function ingestOhlcvZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !/\.(err|lst)$/i.test(e.entryName));

  const nameToSymbol = nameToSymbolMap();
  const fileSummaries = [];
  const stockSymbols = new Set();
  let totalRows = 0;

  for (const entry of entries) {
    if (entry.entryName.endsWith('.json')) {
      let parsedJson;
      try { parsedJson = JSON.parse(entry.getData().toString('utf8')); } catch (e) {
        fileSummaries.push({ file: entry.entryName, parsed: false, reason: `invalid JSON: ${e.message}` });
        continue;
      }
      // Index data vs OHLCV data
      if (parsedJson.head && parsedJson.head[5] && parsedJson.head[5].includes('Index Name')) {
        const { records, skippedRows } = parseIndexJson(parsedJson);
        if (records.length) await upsertBatch(records, 'ohlcv');
        totalRows += records.length;
        fileSummaries.push({ file: entry.entryName, type: 'index', recordsParsed: records.length, skippedName: skippedRows, nrowExpected: parsedJson.meta?.nrow });
      } else {
        const { type, records, skippedName } = parseOhlcvJson(parsedJson, nameToSymbol);
        if (records.length) {
          await upsertBatch(records, type);
          for (const r of records) {
            if (r.symbol) stockSymbols.add(r.symbol);
          }
        }
        totalRows += records.length;
        fileSummaries.push({ file: entry.entryName, type, recordsParsed: records.length, skippedName, nrowExpected: parsedJson.meta?.nrow });
      }
    } else if (entry.entryName.endsWith('.csv')) {
      const { type, records, skippedName } = parseOhlcvCsv(entry.getData().toString('utf8'), nameToSymbol);
      if (records.length) {
        await upsertBatch(records, type);
        for (const r of records) {
          if (r.symbol) stockSymbols.add(r.symbol);
        }
      }
      totalRows += records.length;
      fileSummaries.push({ file: entry.entryName, type, recordsParsed: records.length, skippedName });
    } else {
      fileSummaries.push({ file: entry.entryName, parsed: false, reason: 'unrecognized/unparsed format (likely pipe-delimited .txt)' });
    }
  }

  return { filesProcessed: entries.length, totalRowsIngested: totalRows, stockSymbols: Array.from(stockSymbols), files: fileSummaries };
}

/** Polls one token and updates its ProwessBatchRequest row accordingly. Idempotent on already-resolved rows. */
async function pollAndResolve(token) {
  const row = await batchRequests.getByToken(token);
  if (!row) throw new HttpError(404, `No batch request found for token "${token}".`);
  if (row.status !== 'pending') return row;

  const getBatchResponse = await apiClient.getBatch(token);

  if (!getBatchResponse.ok) {
    return row; // transient HTTP error — leave pending, next poll retries
  }

  if (!getBatchResponse.ready) {
    // Per CMIE's docs, "message" (IN_QUEUE/PROCESSING/PROCESSED/ZIP WAITING TO BE
    // QUEUED/ZIP INQUEUE/ZIP PROCESSING) always comes with errcode 0 — it's a
    // status, not an error. A nonzero errcode here is the only real failure signal.
    const { errcode, errdesc } = getBatchResponse.json || {};
    if (errcode && errcode !== 0) {
      return batchRequests.markFailed(token, errdesc || `errcode ${errcode}`);
    }
    return row; // still processing — leave pending
  }

  // Ready — buffer is the result ZIP. CMIE reports a query-level failure (e.g. a
  // batch file whose domain references session-bound state) as a normal 200 zip
  // containing a TOKEN.err file, not as a GetBatch-level error — check first.
  const zip = new AdmZip(getBatchResponse.buffer);
  const queryError = findQueryError(zip);
  if (queryError) {
    return batchRequests.markFailed(token, queryError);
  }

  if (row.mode === 'daily') {
    const summary = await ingestOhlcvZip(getBatchResponse.buffer);
    return batchRequests.markCompleted(token, { ...summary, resolvedVia: 'getbatch' });
  }

  // annual/quarterly (or any other mode): capture what's in the zip, don't guess at parsing it yet.
  const files = zip.getEntries().filter((e) => !e.isDirectory).map((e) => e.entryName);
  return batchRequests.markCompleted(token, { files, ingested: false, reason: 'auto-ingest not implemented for this mode yet', resolvedVia: 'getbatch' });
}

module.exports = { sendBatchAndTrack, triggerDailyBatch, pollAndResolve, ingestOhlcvZip, HttpError };
