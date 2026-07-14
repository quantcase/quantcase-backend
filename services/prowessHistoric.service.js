'use strict';

/**
 * Admin wrapper around the CSV-upload ingestion paths — this is the only
 * ingestion route now; the live SendBatch/GetBatch API flow was abandoned
 * (query-domain issues on the Prowess side never resolved cleanly, and CSV
 * upload covers everything admins actually need). Preview and run both
 * parse + validate the same way; only `doInsert` differs.
 *
 *   mode 'annual'/'quarterly' → prowess_values_new, via ProwessUploader.
 *     See ProwessUploader.run() for the report shape (dynamicIndicatorsMatched /
 *     unmatchedColumns tell the admin which CSV columns need a new Kpi +
 *     prowess_name before they'll be ingested).
 *   mode 'daily' → nse_equity_new (stock OHLCV/valuation), via
 *     prowessOhlcvCsvParser — the same parser verified against both a real
 *     65k-row historic CSV dump and the live batch API's JSON output.
 *   mode 'index' → nse_equity_new as well (nse_index is deprecated — indices
 *     share the same table/PK as stocks, `symbol` is just the index name),
 *     via prowessIndexCsvParser.
 */

const fs = require('fs');
const path = require('path');
const { ProwessUploader } = require('../prowess_mappers/ProwessUploader');
const { parseOhlcvCsv, buildNameToSymbolMap } = require('./prowess/prowessOhlcvCsvParser');
const { parseIndexCsv } = require('./prowess/prowessIndexCsvParser');
const { upsertBatch } = require('./prowess/prowessOhlcvIngester');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const IDENTITY_CSV = path.join(__dirname, '..', 'lib', 'osc_identity.csv');
let _nameToSymbolCache = null;
function nameToSymbolMap() {
  if (!_nameToSymbolCache) _nameToSymbolCache = buildNameToSymbolMap(IDENTITY_CSV);
  return _nameToSymbolCache;
}

async function processDailyCsv({ csvPath, doInsert, rowLimit }) {
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const { type, records, skippedName } = parseOhlcvCsv(csvText, nameToSymbolMap());
  const limited = rowLimit ? records.slice(0, Number(rowLimit)) : records;

  const report = {
    mode: 'daily', table: 'nse_equity_new', inserted: false,
    type, recordsParsed: limited.length, skippedName,
  };

  if (!doInsert) return report;

  const inserted = await upsertBatch(limited, type);
  return { ...report, inserted: true, insertStats: { attempted: limited.length, inserted } };
}

async function processIndexCsv({ csvPath, doInsert, rowLimit }) {
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const { records, skippedRows } = parseIndexCsv(csvText);
  const limited = rowLimit ? records.slice(0, Number(rowLimit)) : records;

  const report = {
    mode: 'index', table: 'nse_equity_new', inserted: false,
    recordsParsed: limited.length, skippedRows,
  };

  if (!doInsert) return report;

  const inserted = await upsertBatch(limited, 'ohlcv');
  return { ...report, inserted: true, insertStats: { attempted: limited.length, inserted } };
}

async function processHistoricCsv({ mode, csvPath, doInsert, doClear, rowLimit }) {
  if (!['annual', 'quarterly', 'daily', 'index'].includes(mode)) {
    throw new HttpError(400, `Invalid mode "${mode}". Must be "annual", "quarterly", "daily", or "index".`);
  }

  try {
    if (mode === 'daily') {
      return await processDailyCsv({ csvPath, doInsert, rowLimit });
    }
    if (mode === 'index') {
      return await processIndexCsv({ csvPath, doInsert, rowLimit });
    }

    const uploader = new ProwessUploader({
      table: 'prowess_values_new',
      csvPath,
      doInsert,
      doClear: !!doClear,
      rowLimit: rowLimit ? Number(rowLimit) : undefined,
    });
    return await uploader.run(mode);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // ProwessUploader (and the CSV parsers) throw plain Errors for expected
    // validation failures — surface those as 422s instead of a generic 500.
    throw new HttpError(422, err.message);
  } finally {
    fs.unlink(csvPath, () => {});
  }
}

module.exports = { processHistoricCsv, HttpError };
