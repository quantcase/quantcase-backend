const fs = require('fs');
let code = fs.readFileSync('patch_htmlSkill.tmp.js', 'utf8');

// Replace runHtmlSkill
const runHtmlSkillRe = /async function runHtmlSkill\(\{[\s\S]*?return \{ cached: false, output \};\n\}/;
const runHtmlSkillNew = `async function runHtmlSkill({
  slug, ticker, fiscal_year, quarter, force = false,
  transcript_signal_types, ppt_signal_types, annual_report_signal_types,
  max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
}, job) {
  const skill = await prisma.htmlSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(\`HtmlSkill not found: \${slug}\`), { status: 404 });
  if (!skill.is_active) throw Object.assign(new Error(\`HtmlSkill is inactive: \${slug}\`), { status: 400 });

  const prompt_v = \`\${slug}@\${skill.updated_at.toISOString()}\`;

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

  const rawSignals = await querySignalsV2({ ticker });
  const signals    = applySignalLimits(rawSignals, {
    max_transcript_qtrs:        max_transcript_qtrs        ?? skill.max_transcript_qtrs,
    max_ppt_qtrs:               max_ppt_qtrs               ?? skill.max_ppt_qtrs,
    max_annual_report_years:    max_annual_report_years     ?? skill.max_annual_report_years,
    transcript_signal_types:    transcript_signal_types     ?? skill.transcript_signal_types,
    ppt_signal_types:           ppt_signal_types            ?? skill.ppt_signal_types,
    annual_report_signal_types: annual_report_signal_types  ?? skill.annual_report_signal_types,
  });

  const dataBlock = buildDataBlock(signals);

  const mdTypes = new Set(skill.market_data_signal_types ?? []);
  const mdMonths = skill.max_market_data_months;
  const [peData, cmpData] = await Promise.all([
    (mdTypes.has('pe')  && mdMonths != null) ? fetchNsePeTimeseries(ticker,  mdMonths) : null,
    (mdTypes.has('cmp') && mdMonths != null) ? fetchNseCmpTimeseries(ticker, mdMonths) : null,
  ]);
  const marketDataBlock = buildMarketDataBlock(peData, cmpData);

  const { raw_html, extracted_json, audit_logs, usage } = await runAgenticPipeline({
    ticker, model: skill.model, max_tokens: skill.max_tokens,
    data_extraction_prompt: skill.data_extraction_prompt,
    html_template_prompt: skill.html_template_prompt,
    enable_data_validation: skill.enable_data_validation,
    data_validation_loops: skill.data_validation_loops,
    enable_html_validation: skill.enable_html_validation,
    dataBlock, marketDataBlock, job
  });

  logUsage(\`html-skill:\${slug}:\${ticker}\`, usage);

  const input_tokens  = usage?.prompt_tokens     ?? null;
  const output_tokens = usage?.completion_tokens  ?? null;
  const cost_usd      = usage?.cost               ?? null;

  const existing = await prisma.htmlSkillOutput.findFirst({
    where: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null },
  });

  const output = existing
    ? await prisma.htmlSkillOutput.update({
        where: { id: existing.id },
        data: { raw_html, extracted_json, audit_logs, prompt_v, model: skill.model, input_tokens, output_tokens, cost_usd },
      })
    : await prisma.htmlSkillOutput.create({
        data: { skill_id: skill.id, ticker, fiscal_year: fiscal_year ?? null, quarter: quarter ?? null, raw_html, extracted_json, audit_logs, prompt_v, model: skill.model, input_tokens, output_tokens, cost_usd },
      });

  return { cached: false, output };
}`;
code = code.replace(runHtmlSkillRe, runHtmlSkillNew);

// Replace runHtmlSkillPreview
const runHtmlSkillPreviewRe = /async function runHtmlSkillPreview\(\{[\s\S]*?return \{ cached: false, output \};\n\}/;
const runHtmlSkillPreviewNew = `async function runHtmlSkillPreview({ ticker, data_extraction_prompt, html_template_prompt, enable_data_validation, data_validation_loops, enable_html_validation, transcript_signal_types, ppt_signal_types, annual_report_signal_types, model, max_tokens, max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years, market_data_signal_types = [], max_market_data_months = null, force = false }, job) {
  const previewSkill = await getPreviewSkill();
  
  // NOTE: previewCacheKey should ideally use all these fields but it's preview so we can just generate a random v for force or include them.
  const prompt_v = Date.now().toString();

  const rawSignals = await querySignalsV2({ ticker });
  const signals    = applySignalLimits(rawSignals, {
    max_transcript_qtrs,
    max_ppt_qtrs,
    max_annual_report_years,
    transcript_signal_types:    transcript_signal_types    ?? [],
    ppt_signal_types:           ppt_signal_types           ?? [],
    annual_report_signal_types: annual_report_signal_types ?? [],
  });

  const dataBlock = buildDataBlock(signals);

  const mdTypes = new Set(market_data_signal_types ?? []);
  const [peData, cmpData] = await Promise.all([
    (mdTypes.has('pe')  && max_market_data_months != null) ? fetchNsePeTimeseries(ticker,  max_market_data_months) : null,
    (mdTypes.has('cmp') && max_market_data_months != null) ? fetchNseCmpTimeseries(ticker, max_market_data_months) : null,
  ]);
  const marketDataBlock = buildMarketDataBlock(peData, cmpData);

  const { raw_html, extracted_json, audit_logs, usage } = await runAgenticPipeline({
    ticker, model, max_tokens,
    data_extraction_prompt, html_template_prompt,
    enable_data_validation, data_validation_loops, enable_html_validation,
    dataBlock, marketDataBlock, job
  });

  logUsage(\`html-skill-preview:\${ticker}\`, usage);

  const input_tokens  = usage?.prompt_tokens    ?? null;
  const output_tokens = usage?.completion_tokens ?? null;
  const cost_usd      = usage?.cost              ?? null;

  const existing = await prisma.htmlSkillOutput.findFirst({
    where: { skill_id: previewSkill.id, ticker, fiscal_year: null, quarter: null },
  });

  const output = existing
    ? await prisma.htmlSkillOutput.update({
        where: { id: existing.id },
        data:  { raw_html, extracted_json, audit_logs, prompt_v, model, input_tokens, output_tokens, cost_usd },
      })
    : await prisma.htmlSkillOutput.create({
        data: { skill_id: previewSkill.id, ticker, fiscal_year: null, quarter: null, raw_html, extracted_json, audit_logs, prompt_v, model, input_tokens, output_tokens, cost_usd },
      });

  return { cached: false, output };
}`;
code = code.replace(runHtmlSkillPreviewRe, runHtmlSkillPreviewNew);

fs.writeFileSync('services/htmlSkill.service.js', code);
