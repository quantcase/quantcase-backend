require('dotenv').config();
const AdmZip = require('adm-zip');
const orchestrator = require('./services/prowess/prowessBatchOrchestrator.service');
const apiClient = require('./services/prowess/prowessBatchApiClient');
const batchRequests = require('./services/prowess/prowessBatchRequests.service');
const prisma = require('./config/prisma');

async function main() {
  console.log('Triggering a brand new, independent daily batch to cross-check...');
  const { row } = await orchestrator.triggerDailyBatch();
  const token = row.token;
  console.log('token:', token);

  let getBatchResponse;
  const start = Date.now();
  while (true) {
    if (Date.now() - start > 5 * 60 * 1000) throw new Error('Timed out');
    getBatchResponse = await apiClient.getBatch(token);
    if (!getBatchResponse.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (getBatchResponse.ready) break;
    const { errcode, errdesc } = getBatchResponse.json || {};
    if (errcode && errcode !== 0) { await batchRequests.markFailed(token, errdesc); throw new Error(errdesc); }
    await new Promise(r => setTimeout(r, 10000));
  }

  const zip = new AdmZip(getBatchResponse.buffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  console.log('\nAll zip entries:');
  for (const e of entries) console.log(' -', e.entryName, e.getData().length, 'bytes');

  const lstEntry = entries.find(e => e.entryName.endsWith('.lst'));
  if (lstEntry) {
    console.log('\n--- .lst file content (first 2000 chars) ---');
    console.log(lstEntry.getData().toString('utf8').slice(0, 2000));
  }

  const jsonEntry = entries.find(e => e.entryName.endsWith('.json'));
  const rawText = jsonEntry.getData().toString('utf8');
  const parsed = JSON.parse(rawText);
  console.log('\nraw JSON byte length:', rawText.length);
  console.log('meta (full):', JSON.stringify(parsed.meta, null, 2));
  console.log('parsed.data.length:', parsed.data.length);
  console.log('parsed.head.length (rows in head):', parsed.head.length);
  console.log('parsed.head[5].length (columns):', parsed.head[5].length);

  const codes = new Set(parsed.data.map(r => r[0]));
  const names = new Set(parsed.data.map(r => r[1]));
  console.log('distinct company codes:', codes.size);
  console.log('distinct company names:', names.size);
  console.log('any duplicate code rows?', parsed.data.length !== codes.size);

  // ingest normally to not waste this real batch call
  const summary = await orchestrator.ingestOhlcvZip(getBatchResponse.buffer);
  await batchRequests.markCompleted(token, { ...summary, resolvedVia: 'double-confirm-count' });
  console.log('\ningest summary:', JSON.stringify(summary));
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
