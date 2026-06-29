#!/usr/bin/env node
'use strict';

/**
 * Debug: build the L2 prompt for any ticker+lens and save it to a file.
 * Mirrors composeLens() in services/lensComposer.js exactly — no LLM call made.
 *
 * Usage:
 *   node scripts/debug_guidance_record_prompt.js RELIANCE
 *   node scripts/debug_guidance_record_prompt.js RELIANCE /tmp/out.txt guidance-credibility
 *   node scripts/debug_guidance_record_prompt.js HDFCBANK - guidance-credibility
 */

require('dotenv').config();
const fs               = require('fs');
const { PrismaClient } = require('@prisma/client');

const {
  buildSignalSummary, buildShareholdingBlock,
  normalizeValue, computeConfidenceInterval,
  L2_DEFAULT_PROMPT,
} = require('../services/lensComposer');
const { querySignalsV2 }                               = require('../services/db/signals.db');
const { fetchEquityMetrics, formatEquityMetricsBlock } = require('../services/peerMetrics');
const { lensOutputSchema }                             = require('../outputSchemas/lens');
const { computeSourceHash }                            = require('../utils/sourceHash');

const TICKER      = process.argv[2] || 'RELIANCE';
const OUTPUT_FILE = process.argv[3] && process.argv[3] !== '-'
  ? process.argv[3]
  : `/tmp/lens_prompt_${TICKER}.txt`;
const LENS_SLUG   = process.argv[4] || 'guidance-credibility';

function banner(title) {
  const line = '═'.repeat(70);
  console.log(`\n${line}\n  ${title}\n${line}`);
}

async function main() {
  const prisma = new PrismaClient();

  try {
    // ── Step 1: Load lens config ──────────────────────────────────────────────
    banner(`Step 1 — Load lens config "${LENS_SLUG}"`);

    const lensConfig = await prisma.lensConfig.findUnique({ where: { slug: LENS_SLUG } });
    if (!lensConfig) { console.error(`  ✗ LensConfig "${LENS_SLUG}" not found`); process.exit(1); }
    if (!lensConfig.is_active) { console.error(`  ✗ LensConfig "${LENS_SLUG}" is inactive`); process.exit(1); }

    const {
      signal_filters: filters, weights: weightOverrides = [], aggregation = 'weighted_sum',
      model: cfgModel, max_tokens: cfgMaxTokens, prompt_template: cfgPromptTemplate,
      balance: cfgBalance, prefilter: cfgPrefilter, show_math_block: cfgShowMathBlock,
    } = lensConfig.config;

    console.log(`  name        : ${lensConfig.name}`);
    console.log(`  version     : ${lensConfig.version}`);
    console.log(`  model       : ${cfgModel ?? 'anthropic/claude-haiku-4.5 (default)'}`);
    console.log(`  max_tokens  : ${cfgMaxTokens ?? '8000 (default)'}`);
    console.log(`  balance     : ${JSON.stringify(cfgBalance ?? '(none)')}`);
    console.log(`  prefilter   : ${JSON.stringify(cfgPrefilter ?? '(none)')}`);
    console.log(`  show_math   : ${cfgShowMathBlock ?? true}`);
    console.log(`  prompt_tmpl : ${cfgPromptTemplate ? `${cfgPromptTemplate.length} chars (DB)` : 'L2_DEFAULT_PROMPT (fallback)'}`);

    const { include_historical, current_call_only_types, ...signalFilters } = filters ?? {};
    console.log(`  include_historical      : ${include_historical ?? false}`);
    console.log(`  current_call_only_types : ${JSON.stringify(current_call_only_types ?? [])}`);
    console.log(`  signal_filters (rest)   : ${JSON.stringify(signalFilters)}`);

    // ── Step 2: Find latest call for ticker ───────────────────────────────────
    banner(`Step 2 — Latest earnings call for ${TICKER}`);

    const latestCall = await prisma.earnings_calls.findFirst({
      where: {
        company: TICKER,
        OR: [
          { transcript_text: { not: null }, NOT: { transcript_text: '' } },
          { ppt_text:        { not: null }, NOT: { ppt_text:        '' } },
        ],
      },
      orderBy: [{ fiscal_year: 'desc' }, { quarter: 'desc' }],
    });

    if (!latestCall) {
      console.error(`  ✗ No earnings call with text found for "${TICKER}"`);
      process.exit(1);
    }

    const callId = latestCall.id;
    console.log(`  callId    : ${callId}`);
    console.log(`  period    : ${latestCall.fiscal_year} ${latestCall.quarter}`);
    console.log(`  call_date : ${latestCall.call_date}`);

    // ── Step 3: Query current signals ─────────────────────────────────────────
    banner(`Step 3 — querySignalsV2 (current call)`);

    const currentSignals = await querySignalsV2({ callId, ...signalFilters });
    console.log(`  Current signals: ${currentSignals.length}`);
    const byType = {};
    for (const s of currentSignals) byType[s.signal_type] = (byType[s.signal_type] || 0) + 1;
    Object.entries(byType).sort((a, b) => b[1] - a[1])
      .forEach(([t, n]) => console.log(`    ${t.padEnd(26)}: ${n}`));

    // ── Step 4: Historical signals ────────────────────────────────────────────
    banner(`Step 4 — Historical signals (include_historical=${include_historical ?? false})`);

    let signals = currentSignals;
    if (include_historical) {
      let ticker = currentSignals[0]?.ticker;
      if (!ticker) {
        const any = await prisma.transcriptSignalV2.findFirst({ where: { call_id: callId, is_invalidated: false } });
        ticker = any?.ticker;
      }
      if (ticker) {
        const historicalSignals = await querySignalsV2({ ticker, excludeCallId: callId, ...signalFilters });
        console.log(`  Historical signals: ${historicalSignals.length} (ticker=${ticker})`);
        if (historicalSignals.length > 0) {
          const histCalls = [...new Set(historicalSignals.map(s => `${s.call_id} (${s.fiscal_year} ${s.quarter ?? ''})`))];
          console.log(`  Historical calls  : ${histCalls.slice(0, 5).join(', ')}${histCalls.length > 5 ? ` …+${histCalls.length - 5}` : ''}`);
          signals = [...currentSignals, ...historicalSignals];
        }
      } else {
        console.log('  (could not resolve ticker — skipping historical)');
      }
    } else {
      console.log('  (skipped)');
    }

    const SIGNAL_CAP = 3000;
    if (signals.length > SIGNAL_CAP) {
      console.log(`\n  ⚠  Capping ${signals.length} → ${SIGNAL_CAP} (current call first)`);
      signals = [...currentSignals, ...signals.filter(s => s.call_id !== callId)].slice(0, SIGNAL_CAP);
    }
    console.log(`\n  Total signals feeding math + summary: ${signals.length}`);

    // ── Step 5: Math (mirrors composeLens exactly) ────────────────────────────
    banner('Step 5 — Math (weighted sum)');

    const weightMap = new Map((weightOverrides || []).map(o => [o.metric, { w: o.w ?? 1.0, b: o.b ?? 0.0 }]));
    const effectiveWeights = [];
    let z = 0;
    const snapshot = [];

    for (const sig of signals) {
      if (sig.value == null || isNaN(sig.value)) continue;
      const override     = weightMap.get(sig.metric) ?? { w: sig.w, b: sig.b };
      const normalized   = normalizeValue(sig.value, sig.metric_family);
      const contribution = override.w * normalized + override.b;
      z += contribution;
      effectiveWeights.push(override.w);
      snapshot.push({ metric: sig.metric, value: sig.value, normalized, w: override.w, b: override.b, contribution });
    }

    if (aggregation === 'avg' && snapshot.length > 0) z = z / snapshot.length;

    const { lo, hi } = computeConfidenceInterval(signals.filter(s => s.value != null), effectiveWeights);
    const mathResult = { z_score: z, confidence_lo: z + lo, confidence_hi: z + hi };

    console.log(`  z_score : ${z.toFixed(4)}`);
    console.log(`  CI      : [${mathResult.confidence_lo.toFixed(3)}, ${mathResult.confidence_hi.toFixed(3)}]`);
    console.log(`  n (num) : ${snapshot.length}`);
    if (snapshot.length > 0) {
      console.log('\n  Top 10 contributions:');
      [...snapshot].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 10)
        .forEach(s => console.log(`    ${s.metric.padEnd(30)} val=${s.value} w=${s.w} contrib=${s.contribution.toFixed(4)}`));
    }

    // ── Step 6: Signals hash + cache check ───────────────────────────────────
    banner('Step 6 — Signals hash + cache check');

    const ticker = signals[0]?.ticker ?? '';
    const shareholdingHashInput = LENS_SLUG === 'promoter-activity' && ticker
      ? buildShareholdingBlock(ticker) : '';
    const signalsHash = computeSourceHash(
      signals.map(s => `${s.id}:${s.value}`).sort().join(',') + shareholdingHashInput
    );

    const existing = await prisma.lensScore.findUnique({
      where: { call_id_lens_slug: { call_id: callId, lens_slug: LENS_SLUG } },
    });
    const cachedLensData = existing?.lens_data;
    const hasCachedTopSignals = Array.isArray(cachedLensData?.top_signals) && Array.isArray(cachedLensData?.patterns);
    const wouldCacheHit = !!(existing && existing.signals_hash === signalsHash
      && existing.lens_config_v === lensConfig.version && !existing.is_stale
      && cachedLensData && hasCachedTopSignals);

    console.log(`  signals_hash   : ${signalsHash}`);
    console.log(`  existing score : ${existing
      ? `found  hash_match=${existing.signals_hash === signalsHash}  config_v_match=${existing.lens_config_v === lensConfig.version}  is_stale=${existing.is_stale}`
      : 'none'}`);
    console.log(`  would_cache_hit: ${wouldCacheHit} → LLM would be ${wouldCacheHit ? 'SKIPPED' : 'CALLED'}`);

    // ── Step 7: Build DATA_BLOCK (mirrors composeLens data assembly) ──────────
    banner('Step 7 — Build DATA_BLOCK');

    const signalSummary = buildSignalSummary(
      lensConfig.name, signals, mathResult, cfgBalance, cfgPrefilter,
      { show_math_block: cfgShowMathBlock }
    );
    console.log(`  signalSummary     : ${signalSummary.length} chars`);

    let shareholdingBlock = '';
    if (LENS_SLUG === 'promoter-activity' && ticker) {
      shareholdingBlock = buildShareholdingBlock(ticker);
      console.log(`  shareholdingBlock : ${shareholdingBlock.length} chars`);
    }

    // peerBlock only built for competition lens (requires buildPeerSignalsBlock + fetchPeerMetrics)
    // guidance-credibility never triggers this branch — omitted here.
    const peerBlock = '';

    let equityBlock = '';
    try {
      const em = await fetchEquityMetrics(callId);
      equityBlock = formatEquityMetricsBlock(em);
      console.log(`  equityBlock       : ${equityBlock.length} chars`);
    } catch (err) {
      console.log(`  equityBlock       : unavailable (${err.message})`);
    }

    const dataBlock = signalSummary + shareholdingBlock + peerBlock + equityBlock;
    console.log(`  DATA_BLOCK total  : ${dataBlock.length} chars`);

    // ── Step 8: Build final prompt ────────────────────────────────────────────
    banner('Step 8 — Build final prompt');

    const promptTemplate   = cfgPromptTemplate || L2_DEFAULT_PROMPT;
    const lensInstructions = ''; // always '' in composeLens

    const prompt = promptTemplate
      .replace('{{LENS_NAME}}',         lensConfig.name)
      .replace('{{LENS_INSTRUCTIONS}}', lensInstructions)
      .replace('{{DATA_BLOCK}}',        dataBlock);

    const outputSchema = lensConfig.config.output_schema ?? lensOutputSchema;
    const unresolved   = prompt.match(/\{\{[A-Z_]+\}\}/g) ?? [];

    console.log(`  Template source  : ${cfgPromptTemplate ? 'DB prompt_template' : 'L2_DEFAULT_PROMPT'}`);
    console.log(`  Prompt chars     : ${prompt.length} (~${Math.round(prompt.length / 4)} tokens)`);
    console.log(`  Unresolved vars  : ${unresolved.length === 0 ? 'none' : unresolved.join(', ')}`);
    console.log(`  model            : "${cfgModel ?? 'anthropic/claude-haiku-4.5'}"`);
    console.log(`  max_tokens       : ${cfgMaxTokens ?? 8000}`);
    console.log(`  response_format  : json_schema "${outputSchema.json_schema.name}" strict=${outputSchema.json_schema.strict}`);

    // ── Step 9: Save to file ──────────────────────────────────────────────────
    banner(`Step 9 — Saving to ${OUTPUT_FILE}`);

    const fileContent = [
      `# Lens: ${LENS_SLUG} | Ticker: ${TICKER} | Call: ${callId} (${latestCall.fiscal_year} ${latestCall.quarter})`,
      `# Model: ${cfgModel ?? 'anthropic/claude-haiku-4.5'} | max_tokens: ${cfgMaxTokens ?? 8000}`,
      `# signals: ${signals.length} | z_score: ${z.toFixed(4)} | would_cache_hit: ${wouldCacheHit}`,
      `# prompt_chars: ${prompt.length} | data_block_chars: ${dataBlock.length}`,
      '',
      '## PROMPT (sent as messages[0].content)',
      '─'.repeat(80),
      prompt,
      ...(equityBlock ? ['', '## EQUITY BLOCK', '─'.repeat(80), equityBlock] : []),
      ...(shareholdingBlock ? ['', '## SHAREHOLDING BLOCK', '─'.repeat(80), shareholdingBlock] : []),
    ].join('\n');

    fs.writeFileSync(OUTPUT_FILE, fileContent, 'utf8');
    console.log(`  ✓ Saved to: ${OUTPUT_FILE}`);

    // ── Summary ───────────────────────────────────────────────────────────────
    banner('Summary');
    console.log(`  Ticker        : ${TICKER}`);
    console.log(`  Lens          : ${LENS_SLUG} v${lensConfig.version}`);
    console.log(`  Latest call   : ${callId} (${latestCall.fiscal_year} ${latestCall.quarter})`);
    console.log(`  Total signals : ${signals.length}`);
    console.log(`  z_score       : ${z.toFixed(4)}`);
    console.log(`  Prompt chars  : ${prompt.length} (~${Math.round(prompt.length / 4)} tokens)`);
    console.log(`  Cache status  : ${wouldCacheHit ? '⚡ CACHE HIT — LLM skipped in live flow' : '🔄 CACHE MISS — LLM would be called'}`);
    console.log(`  Output file   : ${OUTPUT_FILE}`);

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => { console.error('Script error:', err); process.exit(1); });
