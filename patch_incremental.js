const fs = require('fs');

// --- 1. Schema ---
let schema = fs.readFileSync('prisma/schema.prisma', 'utf8');

const replacementBlock = `
  data_extraction_prompt           String
  html_template_prompt             String
  extraction_model                 String                       @default("~anthropic/claude-haiku-latest")
  fact_validation_model            String                       @default("~anthropic/claude-haiku-latest")
  html_template_model              String                       @default("~anthropic/claude-haiku-latest")
  visual_qa_model                  String                       @default("~anthropic/claude-haiku-latest")
  enable_data_validation           Boolean                      @default(true)
  data_validation_loops            Int                          @default(1)
  enable_html_validation           Boolean                      @default(false)`;

schema = schema.replace(
  'skill_prompt                     String\n  category                         PluginCategory\n  model                            String                       @default("~anthropic/claude-haiku-latest")',
  'category                         PluginCategory' + replacementBlock
);

const configReplacementBlock = `
  data_extraction_prompt           String
  html_template_prompt             String
  extraction_model                 String                       @default("~anthropic/claude-haiku-latest")
  fact_validation_model            String                       @default("~anthropic/claude-haiku-latest")
  html_template_model              String                       @default("~anthropic/claude-haiku-latest")
  visual_qa_model                  String                       @default("~anthropic/claude-haiku-latest")
  enable_data_validation           Boolean                      @default(true)
  data_validation_loops            Int                          @default(1)
  enable_html_validation           Boolean                      @default(false)`;

schema = schema.replace(
  'skill_prompt                     String\n  transcript_signal_types          String[]',
  configReplacementBlock.trim() + '\n  transcript_signal_types          String[]'
);

schema = schema.replace(
  'raw_html       String\n  text_summary   String?\n  prompt_v       String\n  model          String',
  'raw_html       String\n  extracted_json Json?\n  audit_logs     Json?\n  text_summary   String?\n  prompt_v       String\n  model          String'
);

fs.writeFileSync('prisma/schema.prisma', schema);

// --- 2. Routes ---
let routes = fs.readFileSync('routes/htmlIncrementalSkills.routes.js', 'utf8');
const oldFields = ['skill_prompt', 'model'];
const newFields = ['data_extraction_prompt', 'html_template_prompt', 'extraction_model', 'fact_validation_model', 'html_template_model', 'visual_qa_model', 'enable_data_validation', 'data_validation_loops', 'enable_html_validation'];

routes = routes.replace(
  /const allowed = \['name', 'skill_prompt', 'transcript_signal_types'/g,
  "const allowed = ['name', '" + newFields.join("', '") + "', 'transcript_signal_types'"
);

routes = routes.replace(
  /if \(!skill_prompt\) \{[\s\S]*?\}/g,
  "if (!data_extraction_prompt || !html_template_prompt) return res.status(400).json({ error: 'data_extraction_prompt and html_template_prompt are required' });"
);

routes = routes.replace(
  /const \{ slug, name, skill_prompt, category, model, max_tokens,/g,
  "const { slug, name, " + newFields.join(", ") + ", category, max_tokens,"
);

routes = routes.replace(
  /slug, name, skill_prompt, category,/g,
  "slug, name, " + newFields.join(", ") + ", category,"
);

routes = routes.replace(
  /const \{ name, skill_prompt, transcript_signal_types,/g,
  "const { name, " + newFields.join(", ") + ", transcript_signal_types,"
);

routes = routes.replace(
  /name, skill_prompt, transcript_signal_types,/g,
  "name, " + newFields.join(", ") + ", transcript_signal_types,"
);

fs.writeFileSync('routes/htmlIncrementalSkills.routes.js', routes);

