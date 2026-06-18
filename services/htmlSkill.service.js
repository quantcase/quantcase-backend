'use strict';

const prisma = require('../config/prisma');
const { querySignalsV2 } = require('./db/signals.db');
const { llmStream, logUsage } = require('../utils/workerUtils');

/**
 * Format V2 signals into a readable DATA_BLOCK string for the LLM prompt.
 */
function buildDataBlock(signals) {
  if (!signals || signals.length === 0) return 'No signals found for this ticker/period.';

  return signals.map(s => {
    const parts = [`[${s.signal_type}] ${s.metric ?? ''}`.trim()];
    if (s.value != null)       parts.push(`value: ${s.value} ${s.unit ?? ''}`.trim());
    if (s.raw_value != null)   parts.push(`raw: ${s.raw_value}`);
    if (s.context)             parts.push(`context: ${s.context}`);
    if (s.call_date)           parts.push(`date: ${s.call_date}`);
    return parts.join(' | ');
  }).join('\n');
}

/**
 * Build the system + user prompt for an HtmlSkill without calling the LLM.
 * Returns { skill, signals, systemPrompt, userPrompt, signal_count }.
 */
async function buildHtmlSkillPrompt({ slug, ticker }) {
  const skill = await prisma.htmlSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlSkill not found: ${slug}`), { status: 404 });

  const signals = await querySignalsV2({ ticker, signal_types: skill.signal_types });
  const dataBlock = buildDataBlock(signals);

  const systemPrompt = [
    'You are a financial analyst assistant.',
    'Return ONLY a complete, standalone HTML file. No markdown. No explanation. No backticks.',
    'The HTML must be self-contained with inline CSS and be renderable in an iframe.',
  ].join('\n');

  const userPrompt = [
    skill.skill_prompt,
    '',
    '--- DATA BLOCK ---',
    dataBlock,
    '--- END DATA BLOCK ---',
  ].join('\n');

  return { skill, signals, systemPrompt, userPrompt, signal_count: signals.length };
}

/**
 * Run an HtmlSkill against a ticker.
 * Returns the saved HtmlSkillOutput row.
 *
 * @param {object} opts
 * @param {string}  opts.slug
 * @param {string}  opts.ticker
 * @param {string}  [opts.fiscal_year]
 * @param {string}  [opts.quarter]
 * @param {boolean} [opts.force]       Skip cache and always re-run
 */
async function runHtmlSkill({ slug, ticker, fiscal_year, quarter, force = false }) {
  const skill = await prisma.htmlSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(`HtmlSkill not found: ${slug}`), { status: 404 });
  if (!skill.is_active) throw Object.assign(new Error(`HtmlSkill is inactive: ${slug}`), { status: 400 });

  const prompt_v = `${slug}@${skill.updated_at.toISOString()}`;

  // Cache check — skip if force=true
  if (!force) {
    const cached = await prisma.htmlSkillOutput.findFirst({
      where: {
        skill_id: skill.id,
        ticker,
        fiscal_year: fiscal_year ?? null,
        quarter: quarter ?? null,
      },
    });
    if (cached && cached.prompt_v === prompt_v) return { cached: true, output: cached };
  }

  // Fetch V2 signals filtered by this skill's signal_types
  const signals = await querySignalsV2({
    ticker,
    signal_types: skill.signal_types,
  });

  const dataBlock = buildDataBlock(signals);

  const systemPrompt = [
    'You are a financial analyst assistant.',
    'Return ONLY a complete, standalone HTML file. No markdown. No explanation. No backticks.',
    'The HTML must be self-contained with inline CSS and be renderable in an iframe.',
  ].join('\n');

  const userPrompt = [
    skill.skill_prompt,
    '',
    '--- DATA BLOCK ---',
    dataBlock,
    '--- END DATA BLOCK ---',
  ].join('\n');

  const { text: raw_html, usage } = await llmStream({
    model:      skill.model,
    max_tokens: skill.max_tokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });

  logUsage(`html-skill:${slug}:${ticker}`, usage);

  const input_tokens  = usage?.prompt_tokens     ?? null;
  const output_tokens = usage?.completion_tokens  ?? null;
  const cost_usd      = usage?.cost               ?? null;

  const existing = await prisma.htmlSkillOutput.findFirst({
    where: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null },
  });

  const output = existing
    ? await prisma.htmlSkillOutput.update({
        where: { id: existing.id },
        data: { raw_html, prompt_v, model: skill.model, input_tokens, output_tokens, cost_usd },
      })
    : await prisma.htmlSkillOutput.create({
        data: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, raw_html, prompt_v, model: skill.model, input_tokens, output_tokens, cost_usd },
      });

  return { cached: false, output };
}

module.exports = { runHtmlSkill, buildHtmlSkillPrompt };
