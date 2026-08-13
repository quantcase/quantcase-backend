const fs = require('fs');
let code = fs.readFileSync('services/htmlSkill.service.js', 'utf8');

// 1. Add imports
code = code.replace(
  "const { llmStream, logUsage } = require('../utils/workerUtils');",
  "const { llmStream, logUsage } = require('../utils/workerUtils');\nconst { FACT_VALIDATION_PROMPT, VISUAL_QA_PROMPT } = require('../prompts/validationPrompts');"
);

// 2. buildHtmlSkillPrompt update
code = code.replace(
  /async function buildHtmlSkillPrompt\(.*?\) \{[\s\S]*?return \{ skill, signals, systemPrompt, userPrompt, signal_count: signals\.length, raw_signal_count: rawSignals\.length \};\n\}/g,
  `async function buildHtmlSkillPrompt({
  slug, ticker,
  transcript_signal_types, ppt_signal_types, annual_report_signal_types,
  max_transcript_qtrs, max_ppt_qtrs, max_annual_report_years,
}) {
  const skill = await prisma.htmlSkill.findUnique({ where: { slug } });
  if (!skill) throw Object.assign(new Error(\`HtmlSkill not found: \${slug}\`), { status: 404 });

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

  return { 
    skill, signals, signal_count: signals.length, raw_signal_count: rawSignals.length,
    data_extraction_prompt: skill.data_extraction_prompt,
    html_template_prompt: skill.html_template_prompt,
    dataBlock, marketDataBlock
  };
}`
);

// We need an orchestrator helper function
const orchestratorCode = `
async function runAgenticPipeline({
  ticker, model, max_tokens, data_extraction_prompt, html_template_prompt,
  enable_data_validation, data_validation_loops, enable_html_validation,
  dataBlock, marketDataBlock, job
}) {
  const audit_logs = { fact_validation: [], visual_qa: [] };
  let extracted_json = null;
  let raw_html = null;
  let usageAcc = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };

  const mergeUsage = (u) => {
    if (u) {
      usageAcc.prompt_tokens += (u.prompt_tokens || 0);
      usageAcc.completion_tokens += (u.completion_tokens || 0);
      usageAcc.cost += (u.cost || 0);
    }
  };

  const notifyProgress = async (percent, stage) => {
    if (job) await job.updateProgress({ percent, stage });
  };
  const logJob = async (msg) => {
    if (job) await job.log(msg);
  };

  // Phase 1: Data Extraction
  await notifyProgress(20, 'extracting_data');
  await logJob(\`[Phase 1] Extracting data with reasoning ON...\`);
  
  let jsonString = '';
  let jsonParseSuccess = false;
  let parseAttempts = 0;
  
  // Format Validation Loop (JSON)
  let currentExtractionPrompt = [
    data_extraction_prompt,
    '',
    '--- DATA BLOCK ---',
    dataBlock,
    '--- END DATA BLOCK ---',
    marketDataBlock,
  ].join('\\n');

  while (!jsonParseSuccess && parseAttempts < 3) {
    const { text, usage } = await llmStream({
      model, max_tokens,
      messages: [
        { role: 'system', content: 'You are an expert data extraction agent. Output ONLY raw JSON.' },
        { role: 'user', content: currentExtractionPrompt }
      ],
      // reasoning can be handled by OpenRouter if supported by model string, we assume the model inherits it
    });
    mergeUsage(usage);
    jsonString = stripMarkdownFences(text);
    try {
      extracted_json = JSON.parse(jsonString);
      jsonParseSuccess = true;
      await logJob(\`[Phase 1] JSON extraction successful.\`);
    } catch (e) {
      parseAttempts++;
      await logJob(\`[Phase 1] JSON parse error: \${e.message}. Retrying (\${parseAttempts}/3)...\`);
      currentExtractionPrompt = \`You previously generated invalid JSON. Fix the syntax error and return ONLY valid JSON.\\n\\nError: \${e.message}\\n\\nInvalid Output:\\n\${jsonString}\`;
    }
  }
  
  if (!jsonParseSuccess) throw new Error("Failed to generate valid JSON after 3 attempts.");

  // Feedback Loop 1: Fact Validation
  if (enable_data_validation) {
    await notifyProgress(40, 'validating_facts');
    let validationLoops = data_validation_loops || 1;
    for (let i = 0; i < validationLoops; i++) {
      await logJob(\`[Loop 1] Running fact validation (Pass \${i+1}/\${validationLoops})...\`);
      const { text, usage } = await llmStream({
        model, max_tokens,
        messages: [
          { role: 'system', content: FACT_VALIDATION_PROMPT },
          { role: 'user', content: \`--- ORIGINAL DATA ---\\n\${dataBlock}\\n\\n--- EXTRACTED JSON ---\\n\${JSON.stringify(extracted_json, null, 2)}\` }
        ]
      });
      mergeUsage(usage);
      const critiqueStr = stripMarkdownFences(text);
      let critique = [];
      try { critique = JSON.parse(critiqueStr); } catch(e) { critique = [critiqueStr]; }
      
      if (!Array.isArray(critique)) critique = [critique];
      
      audit_logs.fact_validation.push(critique);
      
      if (critique.length === 0) {
        await logJob(\`[Loop 1] No hallucinations found.\`);
        break; // Passed
      }
      
      await logJob(\`[Loop 1] Found errors: \${JSON.stringify(critique)}. Correcting JSON...\`);
      
      // Correction Pass
      const { text: correctedText, usage: cUsage } = await llmStream({
        model, max_tokens,
        messages: [
          { role: 'system', content: 'You are a data correction agent. Update the JSON based on the critique and return ONLY valid JSON.' },
          { role: 'user', content: \`--- CRITIQUE ---\\n\${JSON.stringify(critique)}\\n\\n--- CURRENT JSON ---\\n\${JSON.stringify(extracted_json, null, 2)}\` }
        ]
      });
      mergeUsage(cUsage);
      const correctedJsonStr = stripMarkdownFences(correctedText);
      try {
        extracted_json = JSON.parse(correctedJsonStr);
      } catch(e) {
        await logJob(\`[Loop 1] Failed to parse corrected JSON, sticking with previous version.\`);
      }
    }
  }

  // Phase 2: HTML Generation
  await notifyProgress(60, 'rendering_html');
  await logJob(\`[Phase 2] Rendering HTML template...\`);
  
  let htmlRenderSuccess = false;
  let htmlAttempts = 0;
  let currentHtmlPrompt = [
    html_template_prompt,
    '',
    '--- VALIDATED JSON DATA ---',
    JSON.stringify(extracted_json, null, 2),
    '--- END JSON DATA ---',
  ].join('\\n');

  while (!htmlRenderSuccess && htmlAttempts < 3) {
    const { text, usage } = await llmStream({
      model, max_tokens,
      messages: [
        { role: 'system', content: 'Return ONLY a complete, standalone HTML file. No markdown. No explanation.' },
        { role: 'user', content: currentHtmlPrompt }
      ]
    });
    mergeUsage(usage);
    raw_html = stripMarkdownFences(text);
    
    if (raw_html.toLowerCase().includes('<html') || raw_html.toLowerCase().includes('<div') || raw_html.toLowerCase().includes('<style')) {
      htmlRenderSuccess = true;
      await logJob(\`[Phase 2] HTML rendering successful.\`);
    } else {
      htmlAttempts++;
      await logJob(\`[Phase 2] Missing HTML structure. Retrying (\${htmlAttempts}/3)...\`);
      currentHtmlPrompt = \`You did not output valid HTML code. Return ONLY raw HTML.\\n\\nInvalid Output:\\n\${raw_html}\`;
    }
  }
  
  if (!htmlRenderSuccess) throw new Error("Failed to generate valid HTML structure after 3 attempts.");

  // Feedback Loop 2: Visual QA
  if (enable_html_validation) {
    await notifyProgress(80, 'visual_qa');
    await logJob(\`[Loop 2] Running visual QA...\`);
    const { text, usage } = await llmStream({
      model, max_tokens,
      messages: [
        { role: 'system', content: VISUAL_QA_PROMPT },
        { role: 'user', content: raw_html }
      ]
    });
    mergeUsage(usage);
    const qaStr = stripMarkdownFences(text);
    let bugs = [];
    try { bugs = JSON.parse(qaStr); } catch(e) { bugs = [qaStr]; }
    
    if (!Array.isArray(bugs)) bugs = [bugs];
    audit_logs.visual_qa.push(bugs);
    
    if (bugs.length > 0) {
      await logJob(\`[Loop 2] Found visual bugs: \${JSON.stringify(bugs)}. Correcting HTML...\`);
      const { text: fixedHtml, usage: fUsage } = await llmStream({
        model, max_tokens,
        messages: [
          { role: 'system', content: 'You are a UI developer. Fix the formatting bugs in the HTML and return ONLY the corrected HTML.' },
          { role: 'user', content: \`--- BUGS ---\\n\${JSON.stringify(bugs)}\\n\\n--- CURRENT HTML ---\\n\${raw_html}\` }
        ]
      });
      mergeUsage(fUsage);
      raw_html = stripMarkdownFences(fixedHtml);
    } else {
      await logJob(\`[Loop 2] No visual bugs found.\`);
    }
  }

  return { raw_html, extracted_json, audit_logs, usage: usageAcc };
}
`;
code += '\n' + orchestratorCode;

// 3. update runHtmlSkill and runHtmlSkillPreview
// We'll replace the bodies entirely.
fs.writeFileSync('patch_htmlSkill.tmp.js', code);
