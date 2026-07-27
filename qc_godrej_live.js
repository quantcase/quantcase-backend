const prisma = require('./config/prisma');
const orchestrator = require('./services/prowess/prowessBatchOrchestrator.service');
const batchRequests = require('./services/prowess/prowessBatchRequests.service');
const apiClient = require('./services/prowess/prowessBatchApiClient');
const AdmZip = require('adm-zip');

async function main() {
  console.log('Triggering fresh daily batch...');
  const { row } = await orchestrator.triggerDailyBatch();
  const token = row.token;
  console.log('token:', token);

  let getBatchResponse;
  const start = Date.now();
  while (true) {
    if (Date.now() - start > 5 * 60 * 1000) throw new Error('Timed out waiting for GetBatch');
    getBatchResponse = await apiClient.getBatch(token);
    if (!getBatchResponse.ok) { console.log('transient error, retrying...'); await new Promise(r => setTimeout(r, 5000)); continue; }
    if (getBatchResponse.ready) break;
    const { errcode, errdesc, message } = getBatchResponse.json || {};
    console.log('not ready:', message, errcode, errdesc);
    if (errcode && errcode !== 0) { await batchRequests.markFailed(token, errdesc || `errcode ${errcode}`); throw new Error(`Failed: ${errdesc}`); }
    await new Promise(r => setTimeout(r, 10000));
  }

  console.log('Ready! Inspecting raw zip for Godrej entries BEFORE name-matching...');
  const zip = new AdmZip(getBatchResponse.buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  for (const e of entries) {
    console.log('entry:', e.entryName, e.getData().length, 'bytes');
  }

  const jsonEntry = entries.find(e => e.entryName.endsWith('.json'));
  if (jsonEntry) {
    const parsed = JSON.parse(jsonEntry.getData().toString('utf8'));
    console.log('meta:', JSON.stringify(parsed.meta));
    console.log('head[4] (dates) sample:', parsed.head[4].slice(0,5));
    console.log('head[5] (fields):', parsed.head[5]);
    const godrejRows = parsed.data.filter(row => row.some(c => typeof c === 'string' && c.toLowerCase().includes('godrej')));
    console.log(`Found ${godrejRows.length} raw data rows mentioning "godrej":`);
    for (const r of godrejRows) {
      console.log(' code:', r[0], '| name:', r[1], '| rest:', r.slice(2, 8));
    }
  }

  // Now actually ingest it normally, exactly like the real poller does, so this run counts.
  console.log('\nIngesting normally via ingestOhlcvZip...');
  const summary = await orchestrator.ingestOhlcvZip(getBatchResponse.buffer);
  await batchRequests.markCompleted(token, { ...summary, resolvedVia: 'manual-debug-run' });
  console.log('Ingest summary:', JSON.stringify(summary, null, 2));

  // Check GODREJIND/GODREJPROP post-ingest
  const after = await prisma.$queryRawUnsafe(`
    SELECT symbol, datetime, pe, eps, pe_consolidated, pe_standalone
    FROM nse_equity_new WHERE symbol IN ('GODREJIND','GODREJPROP')
    ORDER BY symbol, datetime DESC LIMIT 4
  `);
  console.log('GODREJIND/PROP after ingest:', JSON.stringify(after, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
