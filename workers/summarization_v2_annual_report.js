'use strict';

const { Worker }      = require('bullmq');
const { PDFDocument } = require('pdf-lib');
const connection      = require('../config/redis');
const prisma          = require('../config/prisma');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { annualReportExtractorPromptV2 }  = require('../prompts/annual_report_call_v2');
const { upsertNewKpis }                  = require('../services/db/kpis.db');
const { loadSkillConfig }                = require('../utils/skillConfig');
const { computeSourceHash, computePromptVersion } = require('../utils/sourceHash');
const { downloadPdfCached }              = require('../utils/pdfCache');

const SKILL_SLUG      = 'summarization-v2-annual-report';
const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31';

// ─── PDF helpers ──────────────────────────────────────────────────────────────

async function extractPageRange(arrayBuffer, pageStart, pageEnd) {
  const srcDoc = await PDFDocument.load(arrayBuffer);
  const subDoc = await PDFDocument.create();
  const indices = Array.from({ length: pageEnd - pageStart }, (_, i) => pageStart + i);
  const pages   = await subDoc.copyPages(srcDoc, indices);
  pages.forEach(p => subDoc.addPage(p));
  return subDoc.saveAsBase64();
}

function pdfContent(base64) {
  return { type: 'file', file: { file_data: `data:application/pdf;base64,${base64}` } };
}

// ─── KPI reference ────────────────────────────────────────────────────────────

async function getExistingKpisForPrompt(basicIndustry) {
  const transcriptWhere = basicIndustry
    ? { source: 'transcript', industry: { has: basicIndustry } }
    : { source: 'transcript' };
  const [qeKpis, transcriptKpis] = await Promise.all([
    prisma.kpi.findMany({ where: { source: 'QE' } }),
    prisma.kpi.findMany({ where: transcriptWhere }),
  ]);
  return [...qeKpis, ...transcriptKpis]
    .filter(k => !/^new_kpis/i.test(k.abbr))
    .map(k => ({
      id:           k.id,
      abbr:         k.abbr,
      full_form:    k.full_form,
      kpi_type:     k.kpi_type    ?? undefined,
      denomination: k.denomination ?? undefined,
      source:       k.source,
    }));
}

// ─── Metric extraction ────────────────────────────────────────────────────────

function extractMetric(sig) {
  switch (sig.signal_type) {
    case 'financial_figure':    return sig.metric ?? null;
    case 'guidance':            return sig.metric ?? null;
    case 'growth_forecast':     return sig.metric ?? null;
    case 'capital_allocation':  return sig.metric ?? sig.category ?? null;
    case 'risk_factor':         return sig.topic  ?? null;
    case 'contingent_liability':return sig.topic  ?? null;
    case 'governance_signal':   return sig.topic  ?? null;
    case 'strategic_claim':     return sig.topic  ?? null;
    case 'm_and_a':             return sig.topic  ?? null;
    case 'kpi':                 return sig.metric ?? null;
    case 'leadership_statement':return sig.topic  ?? null;
    case 'milestone':           return sig.metric ?? null;
    case 'ongoing':             return sig.metric ?? null;
    case 'industry_signal':     return sig.topic  ?? null;
    case 'disclosure_quality':  return sig.topic  ?? null;
    case 'earnings_quality':    return sig.metric ?? null;
    case 'guidance_revision':   return sig.metric ?? null;
    default:                    return sig.metric ?? sig.topic ?? null;
  }
}

// ─── Signal writer ────────────────────────────────────────────────────────────

async function writeSignals(lineageId, reportId, ticker, company, reportMeta, signals, sourceHash, promptV, model) {
  if (!signals.length) return 0;
  const rows = signals.map(sig => ({
    call_id:         reportId,
    ticker,
    company,
    fiscal_year:     reportMeta.fiscal_year ?? null,
    quarter:         null,
    call_date:       reportMeta.call_date   ?? null,
    signal_type:     sig.signal_type        ?? 'unknown',
    source_doc_type: 'annual_report',
    source_context:  sig.source_context     ?? null,
    source_stmt_id:  sig.source_statement_id ?? null,
    signal_seq_id:   sig.signal_id          ?? null,
    metric:          extractMetric(sig),
    impact:          sig.impact             ?? null,
    severity:        sig.severity           ?? null,
    statement:       sig.statement          ?? null,
    data:            sig,
    source_hash:     sourceHash,
    prompt_v:        promptV,
    extractor_model: model,
    lineage_id:      lineageId,
  }));
  const result = await prisma.transcriptSignalV2.createMany({ data: rows, skipDuplicates: false });
  return result.count;
}

// ─── Derive fiscal year end date from fiscal_year string ─────────────────────
// annual_reports.fiscal_year is like "FY2024-25" — map to "2025-03-31"

function deriveArFyEnd(fiscalYear) {
  if (!fiscalYear) return null;
  // Handle "FY2024-25" → year-end is the second year, March 31
  const dashMatch = fiscalYear.match(/FY(\d{4})-(\d{2,4})/);
  if (dashMatch) {
    const endYear = dashMatch[2].length === 2
      ? parseInt(dashMatch[1].slice(0, 2) + dashMatch[2], 10)
      : parseInt(dashMatch[2], 10);
    return `${endYear}-${FISCAL_YEAR_END}`;
  }
  // Handle plain "FY2025"
  const plainMatch = fiscalYear.match(/FY(\d{4})/);
  if (plainMatch) return `${plainMatch[1]}-${FISCAL_YEAR_END}`;
  return null;
}

function derivePriorArFyEnd(arFyEnd) {
  if (!arFyEnd) return null;
  const year = parseInt(arFyEnd.slice(0, 4), 10);
  return `${year - 1}-${FISCAL_YEAR_END}`;
}

// ─── Job processor ────────────────────────────────────────────────────────────
// Each job = one PDF chunk (page range). The dispatcher in jobs.service.js
// splits the annual report PDF into chunks and enqueues N jobs sharing one lineageId.

async function processSummarizationV2AnnualReportJob(job) {
  const { reportId, annualReportUrl, pageStart, pageEnd, lineageId, chunkIndex, totalChunks } = job.data;
  console.log(`[${SKILL_SLUG}] Job ${job.id} — reportId: ${reportId} chunk ${chunkIndex}/${totalChunks} (pages ${pageStart + 1}–${pageEnd})`);

  if (!annualReportUrl) throw new Error(`No annual report URL for report ${reportId}`);
  await job.updateProgress(10);

  const skillConfig = await loadSkillConfig(SKILL_SLUG);
  const sourceHash  = computeSourceHash(`ar:${annualReportUrl}:${pageStart}:${pageEnd}`);
  const promptV     = computePromptVersion(SKILL_SLUG, skillConfig.updatedAt);

  // Skip if this exact chunk has already been processed
  const existing = await prisma.transcriptSignalV2.count({
    where: { call_id: reportId, source_hash: sourceHash, prompt_v: promptV, is_invalidated: false },
  });
  if (existing > 0) {
    console.log(`[${SKILL_SLUG}] Chunk ${chunkIndex} already processed — skipping`);
    await job.updateProgress(100);
    return { cached: true, reportId, chunkIndex };
  }

  // Load annual report metadata
  const report = await prisma.annual_reports.findUnique({ where: { id: BigInt(reportId) } });
  if (!report) throw new Error(`Annual report ${reportId} not found`);

  // Look up basic_industry from earnings_calls using company name
  const callMeta = await prisma.earnings_calls.findFirst({
    where:  { company: report.company },
    select: { basic_industry: true },
  });
  const basicIndustry = callMeta?.basic_industry ?? null;

  const existingKpis = await getExistingKpisForPrompt(basicIndustry);
  console.log(`[${SKILL_SLUG}] ${existingKpis.length} KPIs loaded`);
  await job.updateProgress(20);

  const arFyEnd     = deriveArFyEnd(report.fiscal_year);
  const priorArFyEnd = derivePriorArFyEnd(arFyEnd);

  console.log(`[${SKILL_SLUG}] Downloading annual report PDF (cached)...`);
  const arrayBuffer = await downloadPdfCached(annualReportUrl);
  const base64      = await extractPageRange(arrayBuffer, pageStart, pageEnd);
  await job.updateProgress(40);

  const { model, maxTokens, outputSchema } = skillConfig;
  const promptText = annualReportExtractorPromptV2(
    existingKpis,
    arFyEnd,
    priorArFyEnd,
    report.company,
    report.company,  // NSE symbol — same as company ticker in this DB
    null,            // BSE code not stored
    report.call_date,
  );
  const content = [{ type: 'text', text: promptText }, pdfContent(base64)];

  const llmParams = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  if (outputSchema) llmParams.response_format = outputSchema;

  console.log(`[${SKILL_SLUG}] Calling LLM for chunk ${chunkIndex}/${totalChunks}...`);
  const { text: responseText, usage } = await llmStream(llmParams);
  logUsage(SKILL_SLUG, usage);
  if (!responseText) throw new Error(`Empty LLM response for chunk ${chunkIndex}`);
  await job.updateProgress(80);

  const extracted = parseJson(responseText);
  const signals   = extracted.signals  ?? [];
  const newKpis   = extracted.new_kpis ?? [];
  console.log(`[${SKILL_SLUG}] Chunk ${chunkIndex}: ${signals.length} signals, ${newKpis.length} new_kpis`);

  if (newKpis.length > 0) {
    const kpiResult = await upsertNewKpis({ kpis: [], new_kpis: newKpis }, basicIndustry, 'transcript');
    if (kpiResult.failed?.length > 0) console.warn(`[${SKILL_SLUG}] new_kpis failures:`, kpiResult.failed);
  }

  const written = await writeSignals(
    lineageId, reportId,
    report.company, report.company,
    report, signals,
    sourceHash, promptV, model,
  );
  console.log(`[${SKILL_SLUG}] Wrote ${written} signals`);

  await job.updateProgress(100);
  return { reportId, chunkIndex, totalChunks, signalsWritten: written, lineageId };
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker('summarization_v2_annual_report', processSummarizationV2AnnualReportJob, {
  connection,
  concurrency: 150,
  limiter: { max: 150, duration: 1000 },
});

worker.on('completed', job       => console.log(`[${SKILL_SLUG}] Job ${job.id} completed`));
worker.on('failed',    (job, err) => console.error(`[${SKILL_SLUG}] Job ${job.id} failed:`, err.message));
worker.on('error',     err       => console.error(`[${SKILL_SLUG}] Worker error:`, err));

console.log('Summarization V2 Annual Report worker ready');

module.exports = worker;
