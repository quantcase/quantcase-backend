/**
 * Test script: run the summarization pipeline using PDF file blocks from concalls.csv
 * instead of DB transcript/PPT text. Mirrors the QE worker's approach.
 *
 * Usage:
 *   node scripts/testConcallFile.js [row_index]   # default row = 0
 *   node scripts/testConcallFile.js 5             # use 6th row in CSV
 *
 * Does NOT write to the database — prints extracted JSON to stdout.
 */

require('dotenv').config();

const fs        = require('fs');
const path      = require('path');
const { parse } = require('csv-parse/sync');
const prisma    = require('../config/prisma');
const openRouter = require('../config/llm');
const { parseJson }  = require('../utils/workerUtils');
const { buildDataBlock, PROMPT_TEMPLATE } = require('../prompts/transcript_call');
const { loadSkillConfig } = require('../utils/skillConfig');

const CSV_PATH       = path.join(__dirname, 'concalls.csv');
const FISCAL_YEAR_END = process.env.FISCAL_YEAR_END || '03-31';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildPdfBlock(url, filename) {
  console.log(`  Downloading ${filename}: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`PDF download failed: HTTP ${response.status} for ${url}`);
  const buffer = await response.arrayBuffer();
  const base64  = Buffer.from(buffer).toString('base64');
  return {
    type: 'file',
    file: { filename, file_data: `data:application/pdf;base64,${base64}` },
  };
}

async function getExistingKpisForPrompt(basicIndustry) {
  const qeKpis = await prisma.kpi.findMany({ where: { source: 'QE' } });
  const transcriptWhere = basicIndustry
    ? { source: 'transcript', industry: { has: basicIndustry } }
    : { source: 'transcript' };
  const transcriptKpis = await prisma.kpi.findMany({ where: transcriptWhere });
  return [...qeKpis, ...transcriptKpis].map(k => ({
    id:           k.id,
    abbr:         k.abbr,
    full_form:    k.full_form,
    kpi_type:     k.kpi_type     ?? undefined,
    denomination: k.denomination ?? undefined,
    source:       k.source,
  }));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const rowIndex = parseInt(process.argv[2] ?? '0', 10);

  // Parse CSV
  const raw  = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  console.log(`CSV loaded: ${rows.length} rows`);

  if (rowIndex >= rows.length) {
    console.error(`Row index ${rowIndex} out of range (0–${rows.length - 1})`);
    process.exit(1);
  }

  const row = rows[rowIndex];
  console.log(`\nUsing row ${rowIndex}:`, {
    company:        row.company,
    fiscal_year:    row.fiscal_year,
    quarter:        row.quarter,
    call_date:      row.call_date,
    transcript_url: row.transcript_url,
    ppt_url:        row.ppt_url,
  });

  // Build PDF file blocks
  const contentBlocks = [];

  const transcriptUrl = row.transcript_url?.trim();
  const pptUrl        = row.ppt_url?.trim();

  if (!transcriptUrl && !pptUrl) {
    console.error('No transcript_url or ppt_url in this row — nothing to send.');
    process.exit(1);
  }

  if (transcriptUrl) contentBlocks.push(await buildPdfBlock(transcriptUrl, 'transcript.pdf'));
  if (pptUrl)        contentBlocks.push(await buildPdfBlock(pptUrl, 'presentation.pdf'));

  // Load KPIs from DB
  console.log('\nLoading KPIs from DB...');
  const existingKpis = await getExistingKpisForPrompt(null); // no industry info in CSV
  console.log(`Loaded ${existingKpis.length} KPIs`);

  // Build prompt — use "See attached file(s)" as the transcript placeholder
  // so the model reads from the file blocks, not inline text.
  const callDate = row.call_date?.trim() || 'unknown';
  const { model, maxTokens, promptTemplate } = await loadSkillConfig('summarization');

  const dataBlock = buildDataBlock(
    'See the attached PDF file(s) for the full transcript and/or presentation.',
    existingKpis,
    callDate,
    FISCAL_YEAR_END
  );
  const prompt = (promptTemplate ?? PROMPT_TEMPLATE).replace('{{DATA_BLOCK}}', dataBlock);

  console.log(`\nPrompt length: ${prompt.length} chars`);
  console.log(`Model: ${model}, maxTokens: ${maxTokens}`);

  // Add prompt as the last content block
  contentBlocks.push({ type: 'text', text: prompt });

  // Call LLM
  console.log('\nCalling LLM...');
  const stream = await openRouter.chat.completions.create({
    model,
    max_tokens: maxTokens,
    provider:   { order: ['Anthropic'], allow_fallbacks: false },
    messages:   [{ role: 'user', content: contentBlocks }],
    stream:     true,
  });

  let responseText = '';
  for await (const chunk of stream) responseText += chunk.choices[0]?.delta?.content ?? '';

  if (!responseText) throw new Error('Empty response from LLM');
  console.log(`\nRaw response length: ${responseText.length} chars`);

  // Parse and display
  const extractedData = parseJson(responseText);

  const outputPath = path.join(__dirname, `concall_test_output_row${rowIndex}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(extractedData, null, 2));

  console.log('\n✓ Extraction complete');
  console.log(`  entities.people:        ${extractedData.entities?.people?.length ?? 0}`);
  console.log(`  milestones.future_goals: ${extractedData.milestones?.future_goals?.financial_targets?.length ?? 0} financial targets`);
  console.log(`  kpis extracted:         ${extractedData.kpis?.length ?? 0}`);
  console.log(`  new_kpis:               ${extractedData.new_kpis?.length ?? 0}`);
  console.log(`\nFull output saved to: ${outputPath}`);
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
