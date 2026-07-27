const prisma = require('./config/prisma');
const orchestrator = require('./services/prowess/prowessBatchOrchestrator.service');
const apiClient = require('./services/prowess/prowessBatchApiClient');
const batchRequests = require('./services/prowess/prowessBatchRequests.service');
const AdmZip = require('adm-zip');

async function main() {
  console.log('Triggering fresh daily batch with the fix in place...');
  const { row } = await orchestrator.triggerDailyBatch();
  const token = row.token;
  console.log('token:', token);

  let getBatchResponse;
  const start = Date.now();
  while (true) {
    if (Date.now() - start > 5 * 60 * 1000) throw new Error('Timed out waiting for GetBatch');
    getBatchResponse = await apiClient.getBatch(token);
    if (!getBatchResponse.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (getBatchResponse.ready) break;
    const { errcode, errdesc } = getBatchResponse.json || {};
    if (errcode && errcode !== 0) { await batchRequests.markFailed(token, errdesc); throw new Error(`Failed: ${errdesc}`); }
    await new Promise(r => setTimeout(r, 10000));
  }

  const summary = await orchestrator.ingestOhlcvZip(getBatchResponse.buffer);
  await batchRequests.markCompleted(token, { ...summary, resolvedVia: 'manual-fix-verification' });
  console.log('Ingest summary:', JSON.stringify(summary, null, 2));

  const after = await prisma.$queryRawUnsafe(`
    SELECT symbol, company_name, datetime, close, pe_consolidated, pe_standalone
    FROM nse_equity_new WHERE symbol IN ('GODREJIND','GODREJPROP','DIVERSIFIED','RESIDENTIAL')
    ORDER BY symbol, datetime DESC LIMIT 12
  `);
  console.log('After fix + re-ingest:', JSON.stringify(after, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
