#!/usr/bin/env node
'use strict';

/**
 * Pre-cache technicals and financials for all companies in earnings_calls.
 *
 * Usage:
 *   node scripts/analysis/analyze_metrics_all.js
 *   node scripts/analysis/analyze_metrics_all.js --dispatch
 *   node scripts/analysis/analyze_metrics_all.js --dispatch --base-url http://localhost:9000
 *   node scripts/analysis/analyze_metrics_all.js --dispatch --type technicals
 *   node scripts/analysis/analyze_metrics_all.js --dispatch --type financials
 *   node scripts/analysis/analyze_metrics_all.js --dispatch --type technicals --force-refresh
 *
 * Flags:
 *   --dispatch             Actually make the API calls (dry-run by default)
 *   --base-url <url>       API base URL (default: http://localhost:8000)
 *   --type <type>          Only run one: "technicals" or "financials" (default: both)
 *   --force-refresh        Ignore existing ai_insights cache; re-run all tickers (appends ?refresh=1)
 *
 * Behaviour:
 *   - Reads all distinct company tickers from earnings_calls
 *   - Checks ai_insights for already-cached entries (technicals → "technicals", financials → "fundamentals")
 *   - Prints stats: done vs pending per type
 *   - Fetches 50 companies in parallel, with a 1 s delay between each batch
 */

require('dotenv').config();
const prisma = require('../../config/prisma');

const args         = process.argv.slice(2);
const dispatch     = args.includes('--dispatch');
const forceRefresh = args.includes('--force-refresh');
const buIdx        = args.indexOf('--base-url');
const baseUrl      = buIdx !== -1 ? args[buIdx + 1] : 'http://localhost:8000';
const typeIdx      = args.indexOf('--type');
const typeArg      = typeIdx !== -1 ? args[typeIdx + 1] : null;

const BATCH_SIZE  = 50;
const BATCH_DELAY = 1000; // ms between batches

// API path → ai_insights type name
const TYPE_MAP = {
  technicals: 'technicals',
  financials:  'fundamentals',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(symbol, apiType) {
  const url = `${baseUrl}/api/screener/${symbol}/${apiType}${forceRefresh ? '?refresh=1' : ''}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      return { symbol, apiType, status: 'ok', code: res.status };
    }
    const body = await res.text().catch(() => '');
    return { symbol, apiType, status: 'err', code: res.status, body: body.slice(0, 120) };
  } catch (err) {
    return { symbol, apiType, status: 'err', code: 0, body: err.message };
  }
}

async function main() {
  // ── 1. All distinct tickers from earnings_calls ────────────────────────────
  const rows = await prisma.$queryRawUnsafe(
    "SELECT DISTINCT company FROM earnings_calls WHERE company IS NOT NULL AND company != '' ORDER BY company"
  );
  const allTickers = rows.map((r) => r.company);
  console.log(`\nTotal distinct companies in earnings_calls: ${allTickers.length}\n`);

  // ── 2. Cached entries from ai_insights ────────────────────────────────────
  const cached = await prisma.$queryRawUnsafe(
    "SELECT DISTINCT ticker, type FROM ai_insights WHERE type IN ('technicals', 'fundamentals')"
  );
  const doneSet = new Set(cached.map((r) => `${r.ticker}::${r.type}`));

  // ── 3. Print stats per type ────────────────────────────────────────────────
  const activeApiTypes = typeArg ? [typeArg] : Object.keys(TYPE_MAP);

  console.log('  Type         API path       DB type        Done     Pending');
  console.log('  ' + '-'.repeat(60));
  for (const apiType of activeApiTypes) {
    const dbType  = TYPE_MAP[apiType];
    const done    = allTickers.filter((t) => doneSet.has(`${t}::${dbType}`)).length;
    const pending = allTickers.length - done;
    console.log(
      `  ${apiType.padEnd(12)}  /${apiType.padEnd(14)} ${dbType.padEnd(14)} ${String(done).padStart(5)}    ${String(pending).padStart(5)}`
    );
  }
  console.log();

  if (!dispatch) {
    console.log('Run with --dispatch to start pre-caching.\n');
    return;
  }

  // ── 4. Build work list (skip already cached unless --force-refresh) ──────────
  const todo = [];
  for (const ticker of allTickers) {
    for (const apiType of activeApiTypes) {
      const dbType = TYPE_MAP[apiType];
      if (forceRefresh || !doneSet.has(`${ticker}::${dbType}`)) {
        todo.push({ ticker, apiType });
      }
    }
  }

  if (forceRefresh) console.log('  *** --force-refresh: bypassing cache, re-running all tickers ***\n');
  console.log(`Dispatching ${todo.length} requests to ${baseUrl} (batch=${BATCH_SIZE}, delay=${BATCH_DELAY}ms)...\n`);

  let ok = 0, err = 0;

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch    = todo.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total    = Math.ceil(todo.length / BATCH_SIZE);

    process.stdout.write(
      `  Batch ${String(batchNum).padStart(4)}/${total}  (items ${i + 1}–${Math.min(i + BATCH_SIZE, todo.length)})  ... `
    );

    const results = await Promise.all(batch.map(({ ticker, apiType }) => fetchOne(ticker, apiType)));

    const bOk  = results.filter((r) => r.status === 'ok').length;
    const bErr = results.filter((r) => r.status === 'err').length;
    ok  += bOk;
    err += bErr;

    console.log(`ok=${bOk}  err=${bErr}`);

    for (const r of results) {
      if (r.status === 'err') {
        console.log(`    [ERR] ${r.symbol} /${r.apiType}  HTTP ${r.code}  ${r.body}`);
      }
    }

    if (i + BATCH_SIZE < todo.length) await sleep(BATCH_DELAY);
  }

  console.log(`\nDone.  ok=${ok}  err=${err}  total=${todo.length}\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
