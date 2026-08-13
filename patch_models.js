const fs = require('fs');

// 1. Update Schema
let schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
schema = schema.replace(
  'model         String            @default("~anthropic/claude-haiku-latest")',
  'extraction_model      String            @default("~anthropic/claude-haiku-latest")\n  fact_validation_model String            @default("~anthropic/claude-haiku-latest")\n  html_template_model   String            @default("~anthropic/claude-haiku-latest")\n  visual_qa_model       String            @default("~anthropic/claude-haiku-latest")'
);
fs.writeFileSync('prisma/schema.prisma', schema);

// 2. Update routes
let routes = fs.readFileSync('routes/htmlSkills.routes.js', 'utf8');
routes = routes.replace(
  'model, max_tokens',
  'extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens'
);
routes = routes.replace(
  /if \(\!model\)        return res\.status\(400\)\.json\(\{ error: 'model is required' \}\);/g,
  'if (!extraction_model) return res.status(400).json({ error: \'extraction_model is required\' });'
);
routes = routes.replace(
  'const { slug, name, data_extraction_prompt, html_template_prompt, enable_data_validation, data_validation_loops, enable_html_validation, transcript_signal_types, ppt_signal_types, annual_report_signal_types, category, model, max_tokens',
  'const { slug, name, data_extraction_prompt, html_template_prompt, enable_data_validation, data_validation_loops, enable_html_validation, transcript_signal_types, ppt_signal_types, annual_report_signal_types, category, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens'
);
routes = routes.replace(
  'const allowed = [\'name\', \'data_extraction_prompt\', \'html_template_prompt\', \'enable_data_validation\', \'data_validation_loops\', \'enable_html_validation\', \'transcript_signal_types\', \'ppt_signal_types\', \'annual_report_signal_types\', \'category\', \'model\', \'max_tokens\'',
  'const allowed = [\'name\', \'data_extraction_prompt\', \'html_template_prompt\', \'enable_data_validation\', \'data_validation_loops\', \'enable_html_validation\', \'transcript_signal_types\', \'ppt_signal_types\', \'annual_report_signal_types\', \'category\', \'extraction_model\', \'fact_validation_model\', \'html_template_model\', \'visual_qa_model\', \'max_tokens\''
);
fs.writeFileSync('routes/htmlSkills.routes.js', routes);

// 3. Update jobs.service.js
let jobs = fs.readFileSync('services/jobs.service.js', 'utf8');
jobs = jobs.replace(
  'annual_report_signal_types, model, max_tokens',
  'annual_report_signal_types, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens'
);
jobs = jobs.replace(
  'model, max_tokens,',
  'extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens,'
);
fs.writeFileSync('services/jobs.service.js', jobs);

// 4. Update htmlSkill.js worker
let worker = fs.readFileSync('workers/htmlSkill.js', 'utf8');
worker = worker.replace(
  'annual_report_signal_types, model, max_tokens',
  'annual_report_signal_types, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens'
);
worker = worker.replace(
  'annual_report_signal_types, model, max_tokens',
  'annual_report_signal_types, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens'
);
fs.writeFileSync('workers/htmlSkill.js', worker);

// 5. Update htmlSkill.service.js
let service = fs.readFileSync('services/htmlSkill.service.js', 'utf8');
service = service.replace(
  'ticker, model, max_tokens',
  'ticker, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens'
);
service = service.replace(
  /model, max_tokens,\n\s*messages/g,
  'max_tokens,\n        messages'
);
// Now we manually inject the specific models into the llmStream calls in runAgenticPipeline.
// Phase 1: Data Extraction
service = service.replace(
  "const { text, usage } = await llmStream({\n      max_tokens,\n      messages: [\n        { role: 'system', content: 'You are an expert data extraction agent. Output ONLY raw JSON.' }",
  "const { text, usage } = await llmStream({\n      model: extraction_model, max_tokens,\n      messages: [\n        { role: 'system', content: 'You are an expert data extraction agent. Output ONLY raw JSON.' }"
);
// Fact Validation
service = service.replace(
  "const { text, usage } = await llmStream({\n        max_tokens,\n        messages: [\n          { role: 'system', content: FACT_VALIDATION_PROMPT }",
  "const { text, usage } = await llmStream({\n        model: fact_validation_model, max_tokens,\n        messages: [\n          { role: 'system', content: FACT_VALIDATION_PROMPT }"
);
// Fact Validation Correction
service = service.replace(
  "const { text: correctedText, usage: cUsage } = await llmStream({\n        max_tokens,\n        messages: [\n          { role: 'system', content: 'You are a data correction agent.",
  "const { text: correctedText, usage: cUsage } = await llmStream({\n        model: fact_validation_model, max_tokens,\n        messages: [\n          { role: 'system', content: 'You are a data correction agent."
);
// HTML Template
service = service.replace(
  "const { text, usage } = await llmStream({\n      max_tokens,\n      messages: [\n        { role: 'system', content: 'Return ONLY a complete",
  "const { text, usage } = await llmStream({\n      model: html_template_model, max_tokens,\n      messages: [\n        { role: 'system', content: 'Return ONLY a complete"
);
// Visual QA
service = service.replace(
  "const { text, usage } = await llmStream({\n      max_tokens,\n      messages: [\n        { role: 'system', content: VISUAL_QA_PROMPT }",
  "const { text, usage } = await llmStream({\n      model: visual_qa_model, max_tokens,\n      messages: [\n        { role: 'system', content: VISUAL_QA_PROMPT }"
);
// Visual QA correction
service = service.replace(
  "const { text: fixedHtml, usage: fUsage } = await llmStream({\n        max_tokens,\n        messages: [\n          { role: 'system', content: 'You are a UI developer.",
  "const { text: fixedHtml, usage: fUsage } = await llmStream({\n        model: visual_qa_model, max_tokens,\n        messages: [\n          { role: 'system', content: 'You are a UI developer."
);

// Update runHtmlSkill to pass models
service = service.replace(
  'ticker, model: skill.model, max_tokens: skill.max_tokens',
  'ticker, extraction_model: skill.extraction_model, fact_validation_model: skill.fact_validation_model, html_template_model: skill.html_template_model, visual_qa_model: skill.visual_qa_model, max_tokens: skill.max_tokens'
);
// Note: HtmlSkillOutput still expects `model`. We can just store `extraction_model` there for now, or JSON. Let's just store `extraction_model` as the main model.
service = service.replace(
  /model: skill\.model/g,
  'model: skill.extraction_model'
);

// Update runHtmlSkillPreview to pass models
service = service.replace(
  'annual_report_signal_types, model, max_tokens',
  'annual_report_signal_types, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens'
);
service = service.replace(
  'ticker, model, max_tokens',
  'ticker, extraction_model, fact_validation_model, html_template_model, visual_qa_model, max_tokens'
);
// HtmlSkillOutput output create for preview uses `model`
// The variable is now extraction_model, so we need to map it.
service = service.replace(
  /prompt_v, model, input/g,
  'prompt_v, model: extraction_model, input'
);

fs.writeFileSync('services/htmlSkill.service.js', service);
