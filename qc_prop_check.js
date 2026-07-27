require('dotenv').config();
const orchestrator = require('./services/prowess/prowessBatchOrchestrator.service');
const apiClient = require('./services/prowess/prowessBatchApiClient');
const batchRequests = require('./services/prowess/prowessBatchRequests.service');
const AdmZip = require('adm-zip');

async function main() {
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
  const jsonEntry = zip.getEntries().find(e => e.entryName.endsWith('.json'));
  const parsed = JSON.parse(jsonEntry.getData().toString('utf8'));
  console.log('meta:', JSON.stringify(parsed.meta));

  const godrejCodes = { '83010': 'Agrovet', '83013': 'Consumer', '83018': 'Industries', '83025': 'Properties' };
  const found = parsed.data.filter(r => godrejCodes[r[0]]);
  console.log(`Godrej rows present this run: ${found.length}/4`);
  for (const r of found) console.log(' code:', r[0], godrejCodes[r[0]], '| name:', r[1]);
  const missing = Object.entries(godrejCodes).filter(([code]) => !found.some(r => r[0] === code));
  console.log('Missing:', missing.map(([c,n]) => `${n} (${c})`));

  const summary = await orchestrator.ingestOhlcvZip(getBatchResponse.buffer);
  await batchRequests.markCompleted(token, { ...summary, resolvedVia: 'godrejprop-domain-check' });
  console.log('ingest summary:', JSON.stringify(summary));
}
main().catch((e) => { console.error(e); process.exit(1); });
