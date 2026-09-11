'use strict';

/**
 * scripts/regenerate_fundamentals_intelligence.js
 *
 * Regenerates the Fundamentals Intelligence (aiInsight) for the 8 test companies:
 *   - HDFCBANK
 *   - YESBANK
 *   - SBIN
 *   - RECLTD
 *   - BAJFINANCE
 *   - MOTILALOFS
 *   - HDFCLIFE
 *   - 20MICRONS
 *
 * Usage:
 *   node scripts/regenerate_fundamentals_intelligence.js [--symbols=HDFCBANK,YESBANK,...]
 */

require('dotenv').config();
const prisma = require('../config/prisma');
const cache = require('../config/redis');
const financials = require('../lib/financials');
const { loadSkillConfig } = require('../utils/skillConfig');
const { llmStream, parseJson, logUsage } = require('../utils/workerUtils');
const { fundamentalsIntelligencePrompt } = require('../prompts/fundamentals_intelligence');

const DEFAULT_SYMBOLS = [
  'HDFCBANK',
  'YESBANK',
  'SBIN',
  'RECLTD',
  'BAJFINANCE',
  'MOTILALOFS',
  'HDFCLIFE',
  '20MICRONS'
];

const symArg = process.argv.find(a => a.startsWith('--symbols='));
const TARGET_SYMBOLS = symArg
  ? symArg.split('=')[1].split(',').map(s => s.trim().toUpperCase())
  : DEFAULT_SYMBOLS;

async function regenerate(symbol) {
  console.log(`\n======================================================`);
  console.log(`Generating Fundamentals Intelligence for: ${symbol}`);
  console.log(`======================================================`);

  // 1. Analyze financials
  console.log('1. Fetching standardized financials…');
  const finResult = await financials.analyze(symbol);
  if (!finResult?.standardized) {
    throw new Error(`No standardized financials found for ${symbol}`);
  }

  // 2. Load skill config & prompt
  console.log('2. Loading skill config…');
  const { model, maxTokens, promptTemplate } = await loadSkillConfig('fundamentals-intelligence');
  const prompt = fundamentalsIntelligencePrompt(symbol, finResult, promptTemplate);
  console.log(`   Model: ${model}, MaxTokens: ${maxTokens}, Prompt length: ${prompt.length} chars`);

  // 3. Call LLM
  console.log('3. Querying LLM…');
  const startTime = Date.now();
  const { text, usage } = await llmStream({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });
  logUsage('screener/fundamentals', usage);
  console.log(`   LLM response received in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  if (!text) throw new Error(`Empty response from LLM for ${symbol}`);

  // 4. Parse JSON
  const insight = parseJson(text);
  console.log('4. Parsed JSON output successfully.');

  // 5. Upsert into aiInsight
  console.log('5. Saving to aiInsight table…');
  await prisma.aiInsight.upsert({
    where:  { ticker_type_fiscal_year_quarter: { ticker: symbol, type: 'fundamentals', fiscal_year: 'FY2024', quarter: 'Q4' } },
    create: { ticker: symbol, type: 'fundamentals', insight, fiscal_year: 'FY2024', quarter: 'Q4' },
    update: { insight, updated_at: new Date() },
  });

  // 6. Invalidate screener cache
  const reportTypes = ['all', 'C', 'S'];
  for (const rt of reportTypes) {
    const key = `qc:stock:${symbol}:financials:${rt}`;
    try {
      await cache.del(key);
    } catch (_) {}
  }

  // 7. Output summary
  console.log('\n--- Result Summary ---');
  console.log(`Tag:                 ${insight.tag}`);
  console.log(`Fundamental Grade:   ${insight.fundamentalGrade}`);
  console.log(`Action Bias:         ${insight.actionBias}`);
  console.log(`Actionable Insight:  ${insight.actionableInsight?.action} — ${insight.actionableInsight?.rationale}`);
  console.log(`Signals:`);
  for (const [k, v] of Object.entries(insight.signals || {})) {
    console.log(`  ${k.padEnd(16)}: ${v}`);
  }

  return insight;
}

async function main() {
  console.log(`Starting AI Insights regeneration for ${TARGET_SYMBOLS.length} companies:`);
  console.log(TARGET_SYMBOLS.join(', '));

  const results = {};
  const errors = {};

  for (const sym of TARGET_SYMBOLS) {
    try {
      results[sym] = await regenerate(sym);
    } catch (err) {
      console.error(`[ERROR] Failed for ${sym}:`, err.message);
      errors[sym] = err.message;
    }
  }

  console.log(`\n======================================================`);
  console.log(`FINAL REGENERATION REPORT`);
  console.log(`======================================================`);
  console.log(`Success: ${Object.keys(results).length}/${TARGET_SYMBOLS.length}`);
  if (Object.keys(errors).length) {
    console.log(`Failures:`, errors);
  }

  console.log('\nSummary Table:');
  const summaryRows = Object.entries(results).map(([sym, ins]) => ({
    symbol: sym,
    grade: ins.fundamentalGrade,
    tag: ins.tag,
    action: ins.actionableInsight?.action,
    growth: ins.signals?.growth,
    profitability: ins.signals?.profitability,
    balanceSheet: ins.signals?.balanceSheet,
    valuation: ins.signals?.valuation,
  }));
  console.table(summaryRows);
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
