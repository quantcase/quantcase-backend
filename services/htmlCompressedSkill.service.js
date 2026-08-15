'use strict';

const prisma = require('../config/prisma');
const { runAgenticPipeline, stripMarkdownFences } = require('./htmlSkill.service.js');
const { stripHtmlToText } = require('../utils/stripHtml');
const { resolveConfigKeyForTicker } = require('./companyGroups');
const { llmStream, logUsage } = require('../utils/workerUtils');
const { resolveCallMeta } = require('./htmlIncrementalSkill.service');

// ── Named config resolution ───────────────────────────────────────────────────

async function resolveRequiredConfigKey(ticker, configKey) {
  if (configKey) return configKey;

  const resolved = await resolveConfigKeyForTicker(ticker);
  if (resolved) return resolved;

  throw Object.assign(
    new Error(`No config resolved for ${ticker} — it isn't in any config-mapped company group. Assign it to a group with a config_key set, or pass configKey explicitly.`),
    { status: 400 },
  );
}

async function resolveEffectiveSkill(skill, configKey) {
  const config = await prisma.htmlCompressedSkillConfig.findUnique({
    where: { skill_id_key: { skill_id: skill.id, key: configKey } },
  });
  
  if (!config || !config.is_active) {
    throw Object.assign(new Error(`Config '${configKey}' not found for skill '${skill.slug}'`), { status: 404 });
  }

  const effectiveSkill = {
    ...skill,
    html_template_prompt:   config.html_template_prompt || skill.html_template_prompt,
    html_template_filename: config.html_template_filename || skill.html_template_filename,
    html_template_model:    config.html_template_model || skill.html_template_model,
  };
  const promptVKey = `${skill.slug}:${configKey}@${config.updated_at.toISOString()}`;

  return { effectiveSkill, promptVKey };
}

// ── Base context helpers ──────────────────────────────────────────────────────

async function fetchL2Context(skill, ticker, fiscal_year, quarter, historic) {
  // Queries HtmlIncrementalSkillOutput
  const baseOutput = await prisma.htmlIncrementalSkillOutput.findFirst({
    where: {
      skill_id: skill.base_l2_skill_id,
      ticker,
      fiscal_year: fiscal_year ?? null,
      quarter: quarter ?? null,
      is_historic: historic,
    },
    orderBy: { created_at: 'desc' }
  });

  if (!baseOutput || !baseOutput.extracted_json) {
    const period = [fiscal_year, quarter].filter(Boolean).join(' ') || 'the selected call';
    throw Object.assign(
      new Error(`No L2 JSON found for ${ticker} at or before ${period}. L2 must run first before compressed HTML can be generated.`),
      { status: 400 },
    );
  }

  return baseOutput;
}

// ── Public: dry-run prompt builder (no LLM) ───────────────────────────────────

async function buildCompressedHtmlSkillPrompt({ slug, ticker, callId, historic = false, configKey = null }) {
  const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlCompressedSkill not found: ${slug}`), { status: 404 });
  
  const resolvedConfigKey  = await resolveRequiredConfigKey(ticker, configKey);
  const { effectiveSkill } = await resolveEffectiveSkill(skill, resolvedConfigKey);

  const { fiscal_year, quarter } = await resolveCallMeta(callId);
  
  const baseOutput = await fetchL2Context(effectiveSkill, ticker, fiscal_year, quarter, historic);

  return {
    skill: effectiveSkill,
    extracted_json: baseOutput.extracted_json,
    html_template_prompt: effectiveSkill.html_template_prompt,
    html_template_filename: effectiveSkill.html_template_filename,
    systemPrompt: "Return ONLY a complete, standalone HTML file. No markdown. No explanation. No backticks.",
    fiscal_year,
    quarter,
    historic,
    configKey: resolvedConfigKey,
  };
}

// ── Public: full run ──────────────────────────────────────────────────────────

async function runCompressedHtmlSkill({ slug, ticker, callId, force = false, historic = false, configKey = null }, job) {
  const skill = await prisma.htmlCompressedSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlCompressedSkill not found: ${slug}`), { status: 404 });
  if (!skill.is_active) throw Object.assign(new Error(`HtmlCompressedSkill is inactive: ${slug}`), { status: 400 });

  const resolvedConfigKey              = await resolveRequiredConfigKey(ticker, configKey);
  const { effectiveSkill, promptVKey } = await resolveEffectiveSkill(skill, resolvedConfigKey);
  const prompt_v                       = promptVKey;
  
  const { fiscal_year, quarter }       = await resolveCallMeta(callId);

  if (!force) {
    const cached = await prisma.htmlCompressedSkillOutput.findFirst({
      where: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, is_historic: historic },
    });
    if (cached && cached.prompt_v === prompt_v) return { cached: true, output: cached };
  }

  const baseOutput = await fetchL2Context(effectiveSkill, ticker, fiscal_year, quarter, historic);
  let extracted_json = baseOutput.extracted_json;
  let usage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };

  // Phase 1.5: JSON Compression
  if (effectiveSkill.html_template_prompt) {
    if (job) await job.log(`[Compression] Transforming base JSON into target schema using LLM...`);
    
    const promptPayload = [
      effectiveSkill.html_template_prompt,
      '',
      '--- SOURCE JSON ---',
      JSON.stringify(extracted_json, null, 2),
      '--- END SOURCE JSON ---',
    ].join('\n');

    const { text, usage: compressionUsage } = await llmStream({
      model: effectiveSkill.html_template_model,
      max_tokens: effectiveSkill.max_tokens || 8000,
      messages: [{ role: 'user', content: promptPayload }]
    });

    usage.prompt_tokens += (compressionUsage?.prompt_tokens || 0);
    usage.completion_tokens += (compressionUsage?.completion_tokens || 0);
    usage.cost += (compressionUsage?.cost || 0);

    const parsedString = stripMarkdownFences(text);
    try {
      extracted_json = JSON.parse(parsedString);
      if (job) await job.log(`[Compression] Successfully transformed JSON.`);
    } catch (err) {
      if (job) await job.log(`[Compression] Failed to parse transformed JSON. Error: ${err.message}`);
      throw new Error(`Compression step returned invalid JSON: ${err.message}`);
    }
  }

  // Run generation bypassing extraction
  const pipelineResult = await runAgenticPipeline({
    ticker,
    html_template_model: effectiveSkill.html_template_model,
    max_tokens: effectiveSkill.max_tokens,
    html_template_prompt: effectiveSkill.html_template_prompt,
    html_template_filename: effectiveSkill.html_template_filename,
    use_template_engine: effectiveSkill.use_template_engine,
    pre_extracted_json: extracted_json,
    enable_data_validation: false, // bypassed anyway
    job,
  });

  const raw_html_unstripped = pipelineResult.raw_html;
  usage.prompt_tokens += (pipelineResult.usage?.prompt_tokens || 0);
  usage.completion_tokens += (pipelineResult.usage?.completion_tokens || 0);
  usage.cost += (pipelineResult.usage?.cost || 0);

  const raw_html     = stripMarkdownFences(raw_html_unstripped);
  // Optional text summary extraction
  const text_summary = stripHtmlToText(raw_html);

  logUsage(`html-compressed-skill:${slug}:${ticker}`, usage);

  const input_tokens  = usage?.prompt_tokens    ?? null;
  const output_tokens = usage?.completion_tokens ?? null;
  const cost_usd      = usage?.cost              ?? null;

  const existing = await prisma.htmlCompressedSkillOutput.findFirst({
    where: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, is_historic: historic },
  });

  const output = existing
    ? await prisma.htmlCompressedSkillOutput.update({
        where: { id: existing.id },
        data:  { raw_html, text_summary, prompt_v, call_id: callId ?? 'unknown', model: effectiveSkill.html_template_model, input_tokens, output_tokens, cost_usd, is_historic: historic, config_key: resolvedConfigKey },
      })
    : await prisma.htmlCompressedSkillOutput.create({
        data: {
          skill_id: skill.id,
          ticker,
          call_id:     callId ?? 'unknown',
          fiscal_year: fiscal_year ?? null,
          quarter:     quarter     ?? null,
          raw_html,
          text_summary,
          prompt_v,
          model:        effectiveSkill.html_template_model,
          input_tokens,
          output_tokens,
          cost_usd,
          is_historic: historic,
          config_key:  resolvedConfigKey,
        },
      });

  return { cached: false, output };
}

module.exports = {
  buildCompressedHtmlSkillPrompt,
  runCompressedHtmlSkill,
  resolveEffectiveSkill,
  fetchL2Context
};
