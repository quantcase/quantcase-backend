const fs = require('fs');

// Export runAgenticPipeline from htmlSkill.service.js
let htmlService = fs.readFileSync('services/htmlSkill.service.js', 'utf8');
if (!htmlService.includes('runAgenticPipeline')) {
  throw new Error("runAgenticPipeline not found in htmlSkill.service.js");
}
if (!htmlService.includes('module.exports = {')) {
  throw new Error("module.exports not found");
}
htmlService = htmlService.replace(
  'module.exports = {',
  'module.exports = {\n  runAgenticPipeline,'
);
fs.writeFileSync('services/htmlSkill.service.js', htmlService);

let incService = fs.readFileSync('services/htmlIncrementalSkill.service.js', 'utf8');
incService = incService.replace(
  "const { llmStream, logUsage } = require('../utils/workerUtils');",
  "const { llmStream, logUsage } = require('../utils/workerUtils');\nconst { runAgenticPipeline } = require('./htmlSkill.service.js');"
);

// We need to replace `llmStream` calls in `runHtmlIncrementalSkill`
// It currently looks something like:
// const { text, usage } = await llmStream({ ... })
// Let's replace the whole block that calls the LLM.
const llmBlockRegex = /const \{ text, usage \} = await llmStream\(\{[\s\S]*?\}\);[\s\S]*?const raw_html = stripMarkdownFences\(text\);/g;

const newLlmBlock = `
  const { raw_html, extracted_json, audit_logs, usage } = await runAgenticPipeline({
    ticker,
    extraction_model: config.extraction_model ?? skill.extraction_model,
    fact_validation_model: config.fact_validation_model ?? skill.fact_validation_model,
    html_template_model: config.html_template_model ?? skill.html_template_model,
    visual_qa_model: config.visual_qa_model ?? skill.visual_qa_model,
    max_tokens: config.max_tokens ?? skill.max_tokens,
    data_extraction_prompt: config.data_extraction_prompt ?? skill.data_extraction_prompt,
    html_template_prompt: config.html_template_prompt ?? skill.html_template_prompt,
    enable_data_validation: config.enable_data_validation ?? skill.enable_data_validation,
    data_validation_loops: config.data_validation_loops ?? skill.data_validation_loops,
    enable_html_validation: config.enable_html_validation ?? skill.enable_html_validation,
    dataBlock, marketDataBlock, job
  });
`;
incService = incService.replace(llmBlockRegex, newLlmBlock);

// update HTML creation
incService = incService.replace(
  /raw_html,\n\s*prompt_v/g,
  'raw_html, extracted_json, audit_logs,\n        prompt_v'
);
incService = incService.replace(
  /raw_html,\n\s*text_summary:/g,
  'raw_html, extracted_json, audit_logs,\n        text_summary:'
);

// Update model fallback
incService = incService.replace(
  /model: config.model \?\? skill.model/g,
  'model: config.extraction_model ?? skill.extraction_model'
);

fs.writeFileSync('services/htmlIncrementalSkill.service.js', incService);

// Now update buildHtmlIncrementalSkillPrompt
incService = incService.replace(
  /skill_prompt: config\.skill_prompt \?\? skill\.skill_prompt/g,
  `data_extraction_prompt: config.data_extraction_prompt ?? skill.data_extraction_prompt,
    html_template_prompt: config.html_template_prompt ?? skill.html_template_prompt,
    extraction_model: config.extraction_model ?? skill.extraction_model,
    fact_validation_model: config.fact_validation_model ?? skill.fact_validation_model,
    html_template_model: config.html_template_model ?? skill.html_template_model,
    visual_qa_model: config.visual_qa_model ?? skill.visual_qa_model,
    enable_data_validation: config.enable_data_validation ?? skill.enable_data_validation,
    data_validation_loops: config.data_validation_loops ?? skill.data_validation_loops,
    enable_html_validation: config.enable_html_validation ?? skill.enable_html_validation`
);
fs.writeFileSync('services/htmlIncrementalSkill.service.js', incService);
