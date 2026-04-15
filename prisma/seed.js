const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ─── Prompt templates (static portions stored in DB) ─────────────────────────
const { PROMPT_TEMPLATE: TRANSCRIPT_TEMPLATE }        = require('../prompts/transcript_call');
const { PROMPT_TEMPLATE: QE_TEMPLATE }                = require('../prompts/quarterly_earnings');
const { PROMPT_TEMPLATE: DEAL_TEMPLATE }              = require('../prompts/deal_analysis');
const { DEFAULT_INSTRUCTIONS: INDUSTRY_INSTRUCTIONS, PROMPT_TEMPLATE: INDUSTRY_TEMPLATE } = require('../prompts/of-prompts/industry-prompt');
const { DEFAULT_INSTRUCTIONS: COMP_INSTRUCTIONS, PROMPT_TEMPLATE: COMP_TEMPLATE }         = require('../prompts/of-prompts/competition-prompt');
const { DEFAULT_INSTRUCTIONS_NONBFSI: FIN_INSTRUCTIONS_NONBFSI, STATIC_SECTION_NONBFSI: FIN_TEMPLATE_NONBFSI } = require('../prompts/of-prompts/financial-strength-prompt');
const { DEFAULT_INSTRUCTIONS: CUST_INSTRUCTIONS, PROMPT_TEMPLATE: CUST_TEMPLATE }         = require('../prompts/of-prompts/customer-traction-prompt');
const { PROMPT_TEMPLATE_WITH_SCHEMA: FINAL_TAKEAWAYS_TEMPLATE }                            = require('../prompts/of-prompts/final-takeaways-prompt');
const { PROMPT_TEMPLATE: SUGGESTION_TEMPLATE }        = require('../prompts/wealthos/suggestion_generation');
const { PROMPT_TEMPLATE: MESSAGE_TEMPLATE }           = require('../prompts/wealthos/message_generation');
const { PROMPT_TEMPLATE: DI_TEMPLATE }                = require('../prompts/decision_intelligence');
const { PROMPT_TEMPLATE: MGMT_TEMPLATE, OUTPUT_SCHEMA: MGMT_SCHEMA } = require('../prompts/management_analysis');

// ─── QE KPIs ──────────────────────────────────────────────────────────────────

const QE_KPIS = [
  // Assets
  { abbr: 'TOTAL_ASSETS',       full_form: 'Total Assets',                                                                  kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'NONCURR_ASSETS',     full_form: 'Total Non-Current Assets',                                                      kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'ASSET_PPE',          full_form: 'Property, Plant and Equipment',                                                 kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'ASSET_CWIP',         full_form: 'Capital Work-in-Progress',                                                      kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'INV_NONCURR',        full_form: 'Non-Current Investments',                                                       kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'LOANS_NONCURR',      full_form: 'Long-Term Loans and Advances',                                                  kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'OTH_ASSET_NC',       full_form: 'Other Non-Current Assets',                                                     kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'CURR_ASSETS',        full_form: 'Total Current Assets',                                                          kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'INVENTORY',          full_form: 'Inventories',                                                                   kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'INV_CURR',           full_form: 'Current Investments',                                                           kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'TRADE_RECV',         full_form: 'Trade Receivables',                                                             kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'CASH_EQUIV',         full_form: 'Cash and Cash Equivalents',                                                     kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'BANK_BAL_OTHER',     full_form: 'Other Bank Balances',                                                           kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'LOANS_CURR',         full_form: 'Short-Term Loans and Advances',                                                 kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'TOTAL_FIN_ASSETS',   full_form: 'Total Financial Assets',                                                        kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'TOTAL_NONFIN_ASSETS',full_form: 'Total Non-Financial Assets',                                                    kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'BANK_BAL',           full_form: 'Bank Balances Other Than Cash and Cash Equivalents',                            kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'LOANS_ADV',          full_form: 'Financial Assets - Loans',                                                      kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'ASSET_GW',           full_form: 'Goodwill',                                                                      kpi_type: 'assets',              denomination: 'rupee' },
  { abbr: 'ASSET_INTANG',       full_form: 'Other Intangible Assets',                                                       kpi_type: 'assets',              denomination: 'rupee' },

  // Liabilities
  { abbr: 'TOTAL_LIAB',         full_form: 'Total Liabilities',                                                             kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'NONCURR_LIAB',       full_form: 'Total Non-Current Liabilities',                                                 kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'DEBT_LT',            full_form: 'Long-Term Borrowings',                                                          kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'DTL',                full_form: 'Deferred Tax Liabilities (Net)',                                                 kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'PROV_LT',            full_form: 'Long-Term Provisions',                                                          kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'CURR_LIAB',          full_form: 'Total Current Liabilities',                                                     kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'DEBT_ST',            full_form: 'Short-Term Borrowings',                                                         kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'TRADE_PAY',          full_form: 'Trade Payables',                                                                kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'OTH_LIAB_CURR',      full_form: 'Other Current Liabilities',                                                    kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'PROV_ST',            full_form: 'Short-Term Provisions',                                                         kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'TOTAL_FIN_LIAB',     full_form: 'Total Financial Liabilities',                                                   kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'TOTAL_NONFIN_LIAB',  full_form: 'Total Non-Financial Liabilities',                                               kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'DEBT_NONCURR',       full_form: 'Financial Liabilities - Borrowings',                                            kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'OTHER_FIN_LIAB',     full_form: 'Other Financial Liabilities',                                                   kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'PROVISIONS',         full_form: 'Provisions',                                                                    kpi_type: 'liabilities',         denomination: 'rupee' },
  { abbr: 'OTHER_NONFIN_LIAB',  full_form: 'Other Non-Financial Liabilities',                                               kpi_type: 'liabilities',         denomination: 'rupee' },

  // Equity
  { abbr: 'NET_WORTH',          full_form: 'Total Equity / Net Worth',                                                      kpi_type: 'equity',              denomination: 'rupee' },
  { abbr: 'EQ_SHARE_CAP',       full_form: 'Equity Share Capital',                                                          kpi_type: 'equity',              denomination: 'rupee' },
  { abbr: 'RES_SURPLUS',        full_form: 'Other Equity / Reserves and Surplus',                                           kpi_type: 'equity',              denomination: 'rupee' },
  { abbr: 'SHARE_WARRANTS',     full_form: 'Money Received Against Share Warrants',                                         kpi_type: 'equity',              denomination: 'rupee' },
  { abbr: 'MINORITY_INT',       full_form: 'Non-Controlling Interests / Minority Interest',                                 kpi_type: 'equity',              denomination: 'rupee' },

  // Revenue
  { abbr: 'TOTAL_INCOME',       full_form: 'Total Income',                                                                  kpi_type: 'revenue',             denomination: 'rupee' },
  { abbr: 'REV_OP',             full_form: 'Revenue from Operations',                                                       kpi_type: 'revenue',             denomination: 'rupee' },
  { abbr: 'OTH_INC',            full_form: 'Other Income',                                                                  kpi_type: 'revenue',             denomination: 'rupee' },

  // COGS
  { abbr: 'TOTAL_COGS',         full_form: 'Total Cost of Goods Sold',                                                      kpi_type: 'cogs',                denomination: 'rupee' },
  { abbr: 'COST_MAT',           full_form: 'Cost of Materials Consumed',                                                    kpi_type: 'cogs',                denomination: 'rupee' },
  { abbr: 'PURCH_STOCK',        full_form: 'Purchases of Stock-in-Trade',                                                   kpi_type: 'cogs',                denomination: 'rupee' },
  { abbr: 'INV_CHG',            full_form: 'Changes in Inventories of Finished Goods, WIP and Stock-in-Trade',             kpi_type: 'cogs',                denomination: 'rupee' },
  { abbr: 'FIN_COST',           full_form: 'Finance Costs / Interest Expense',                                              kpi_type: 'cogs',                denomination: 'rupee' },

  // Operating expenses
  { abbr: 'TOTAL_OPEX',         full_form: 'Total Operating Expenses',                                                      kpi_type: 'operating_expenses',  denomination: 'rupee' },
  { abbr: 'EMP_EXP',            full_form: 'Employee Benefit Expense',                                                      kpi_type: 'operating_expenses',  denomination: 'rupee' },
  { abbr: 'DEP_AMORT',          full_form: 'Depreciation and Amortisation',                                                 kpi_type: 'operating_expenses',  denomination: 'rupee' },
  { abbr: 'OTH_EXP',            full_form: 'Other Expenses',                                                                kpi_type: 'operating_expenses',  denomination: 'rupee' },
  { abbr: 'PROV_CONT',          full_form: 'Provisions and Contingencies',                                                  kpi_type: 'operating_expenses',  denomination: 'rupee' },

  // Profit lines
  { abbr: 'TOTAL_TAX_EXP',      full_form: 'Total Tax Expense',                                                             kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'PBT_PRE_EXC',        full_form: 'Profit Before Exceptional Items and Tax',                                       kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'EXC_ITEMS',          full_form: 'Exceptional Items',                                                             kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'PBT',                full_form: 'Profit Before Tax',                                                             kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'TAX_EXP',            full_form: 'Tax Expense',                                                                   kpi_type: 'profit_lines',        denomination: 'rupee' },
  { abbr: 'PAT',                full_form: 'Profit After Tax',                                                              kpi_type: 'profit_lines',        denomination: 'rupee' },

  // Cashflow
  { abbr: 'NET_CASH_CHANGE',    full_form: 'Net Change in Cash and Cash Equivalents',                                       kpi_type: 'cashflow',            denomination: 'rupee' },
  { abbr: 'CFO',                full_form: 'Cash Flow from Operating Activities',                                           kpi_type: 'cashflow',            denomination: 'rupee' },
  { abbr: 'CFI',                full_form: 'Cash Flow from Investing Activities',                                           kpi_type: 'cashflow',            denomination: 'rupee' },
  { abbr: 'CFF',                full_form: 'Cash Flow from Financing Activities',                                           kpi_type: 'cashflow',            denomination: 'rupee' },
];

// ─── Seed function ────────────────────────────────────────────────────────────

async function seed() {
  console.log('Seeding KPI table...');
  let inserted = 0, failed = 0;

  for (const kpi of QE_KPIS) {
    try {
      await prisma.kpi.upsert({
        where:  { abbr: kpi.abbr },
        update: {},
        create: { ...kpi, source: 'QE' },
      });
      inserted++;
    } catch (err) {
      console.error(`Failed to seed ${kpi.abbr}:`, err.message);
      failed++;
    }
  }
  console.log(`QE KPIs: ${inserted} upserted, ${failed} failed`);
  console.log('Seeding complete.');
}

// ─── Skills & Plugins seed ───────────────────────────────────────────────────

const decisionIntelligenceSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'decision_intelligence',
    strict: false,
    schema: {
      type: 'object',
      properties: {
        tag:           { type: 'string' },
        lens:          { type: 'string', enum: ['Value', 'Growth'] },
        idealFor:      { type: 'string', enum: ['Investment', 'Swing', 'Positional'] },
        timeframe:     { type: 'string', enum: ['6M+', '3-6M', '0-3M'] },
        currentRegime: {
          type: 'object',
          properties: {
            label:       { type: 'string' },
            description: { type: 'string' },
          },
        },
        actionBias: { type: 'string' },
        actionableInsight: {
          type: 'object',
          properties: {
            action:               { type: 'string', enum: ['Buy', 'Sell', 'Hold', 'Avoid', 'Ignore'] },
            firstShift:           { type: 'string' },
            existingHolderAction: { type: 'string' },
            reEvaluateCondition:  { type: 'string' },
          },
        },
        whatCanChange:   { type: 'array', items: { type: 'string' } },
        strategyViews: {
          type: 'object',
          properties: {
            growth: { type: 'string' },
            value:  { type: 'string' },
          },
        },
        riskAlerts:     { type: 'array', items: { type: 'string' } },
        convictionLevel: { type: 'string', enum: ['Low', 'Medium', 'High'] },
        indicators: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name:           { type: 'string' },
              growthWatchout: { type: 'string' },
              valueWatchout:  { type: 'string' },
              tag:            { type: 'string' },
              explanation:    { type: 'string' },
              sentiment:      { type: 'string', enum: ['positive', 'negative', 'transitional'] },
            },
          },
        },
      },
      required: ['tag', 'lens', 'idealFor', 'timeframe', 'currentRegime', 'actionBias', 'actionableInsight', 'whatCanChange', 'strategyViews', 'riskAlerts', 'convictionLevel', 'indicators'],
    },
  },
};

const wealthosSuggestionSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'wealthos_suggestions',
    strict: true,
    schema: {
      type:  'array',
      items: {
        type:       'object',
        properties: {
          client_id:        { type: 'string' },
          reason:           { type: 'string' },
          suggested_action: { type: 'string' },
          talking_points:   { type: 'array', items: { type: 'string' } },
          message:          { type: 'string' },
          priority:         { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
        required:             ['client_id', 'reason', 'suggested_action', 'talking_points', 'message', 'priority'],
        additionalProperties: false,
      },
    },
  },
};

const wealthosMessageSchema = {
  type: 'json_schema',
  json_schema: {
    name:   'wealthos_message',
    strict: true,
    schema: {
      type:       'object',
      properties: {
        subject: { type: ['string', 'null'] },
        body:    { type: 'string' },
        channel: { type: 'string', enum: ['call', 'email', 'whatsapp'] },
      },
      required:             ['subject', 'body', 'channel'],
      additionalProperties: false,
    },
  },
};

const SKILLS_SEED = [
  {
    name: 'summarization', promptKey: 'transcriptExtractorPrompt', maxTokens: 16000,
    description: 'Extract entities, milestones, governance signals and KPIs from earnings call transcripts',
    promptTemplate: TRANSCRIPT_TEMPLATE,
    defaultInstructions: null,
  },
  {
    name: 'qe_extraction', promptKey: 'quarterlyEarningsPrompt', maxTokens: 16000,
    description: 'Extract structured quarterly financial KPIs from earnings reports',
    promptTemplate: QE_TEMPLATE,
    defaultInstructions: null,
  },
  {
    name: 'deal_analysis', promptKey: 'dealAnalysisPrompt', maxTokens: 16000,
    description: 'Generate bear/base/bull scenario deal analysis for a stock',
    promptTemplate: DEAL_TEMPLATE,
    defaultInstructions: null,
  },
  {
    name: 'ofactor_industry', promptKey: 'ofactorIndustryPrompt', maxTokens: 16000,
    description: 'Analyse industry positioning and market dynamics for opportunity scoring',
    promptTemplate: INDUSTRY_TEMPLATE,            // non-BFSI default; BFSI built at runtime via _buildPromptTemplate
    defaultInstructions: INDUSTRY_INSTRUCTIONS,
  },
  {
    name: 'ofactor_competition', promptKey: 'ofactorCompetitionPrompt', maxTokens: 16000,
    description: 'Analyse competitive landscape vs peers for opportunity scoring',
    promptTemplate: COMP_TEMPLATE,
    defaultInstructions: COMP_INSTRUCTIONS,
  },
  {
    name: 'ofactor_financial_strength', promptKey: 'ofactorFinancialStrengthPrompt', maxTokens: 16000,
    description: 'Assess financial strength metrics for opportunity scoring',
    promptTemplate: FIN_TEMPLATE_NONBFSI,         // non-BFSI default; BFSI variant (FIN_TEMPLATE_BFSI) used at runtime when bfsi=true
    defaultInstructions: FIN_INSTRUCTIONS_NONBFSI,
  },
  {
    name: 'ofactor_customer_traction', promptKey: 'ofactorCustomerTractionPrompt', maxTokens: 16000,
    description: 'Evaluate customer traction and growth signals for opportunity scoring',
    promptTemplate: CUST_TEMPLATE,
    defaultInstructions: CUST_INSTRUCTIONS,
  },
  {
    name: 'ofactor_final_takeaways', promptKey: 'ofactorFinalTakeawaysPrompt', maxTokens: 16000,
    description: 'Synthesise all opportunity factor sections into final takeaways',
    promptTemplate: FINAL_TAKEAWAYS_TEMPLATE,
    defaultInstructions: null,
  },
  {
    name: 'wealthos_suggestion', promptKey: 'wealthosSuggestionPrompt', maxTokens: 8000,
    description: 'Generate personalised wealth management suggestions for clients',
    outputSchema: wealthosSuggestionSchema,
    promptTemplate: SUGGESTION_TEMPLATE,
    defaultInstructions: null,
  },
  {
    name: 'wealthos_message', promptKey: 'wealthosMessagePrompt', maxTokens: 2000,
    description: 'Generate a personalised client outreach message',
    outputSchema: wealthosMessageSchema,
    promptTemplate: MESSAGE_TEMPLATE,
    defaultInstructions: null,
  },
  {
    name: 'management-analysis', promptKey: 'managementAnalysisPrompt', maxTokens: 16000,
    description: 'Forensic management quality analysis — guidance vs actuals, red flags, MQI score, investment thesis',
    outputSchema: MGMT_SCHEMA,
    promptTemplate: MGMT_TEMPLATE,
    defaultInstructions: null,
  },
  {
    name: 'technical-intelligence', promptKey: 'decisionIntelligencePrompt', maxTokens: 8000,
    description: 'Generate decision intelligence summary from technical analysis signals',
    outputSchema: decisionIntelligenceSchema,
    promptTemplate: DI_TEMPLATE,
    defaultInstructions: null,
  },
];

const PLUGINS_SEED = [
  {
    name: 'management', category: 'management',
    description: 'Transcript summarisation followed by quarterly earnings KPI extraction',
    skills: ['summarization', 'qe_extraction', 'management-analysis'],
  },
  {
    name: 'deal', category: 'deal',
    description: 'Bear/base/bull deal analysis for a stock',
    skills: ['deal_analysis'],
  },
  {
    name: 'opportunity', category: 'opportunity',
    description: 'Full opportunity factor analysis pipeline: industry → competition → financial strength → customer traction → final takeaways',
    skills: ['ofactor_industry', 'ofactor_competition', 'ofactor_financial_strength', 'ofactor_customer_traction', 'ofactor_final_takeaways'],
  },
  {
    name: 'wealthos', category: 'wealthos',
    description: 'Generate client suggestions then draft outreach messages',
    skills: ['wealthos_suggestion', 'wealthos_message'],
  },
  {
    name: 'technicals', category: 'technicals',
    description: 'Generate decision intelligence from technical analysis signals',
    skills: ['technical-intelligence'],
  },
];

async function seedSkillsAndPlugins() {
  console.log('Seeding Skills...');
  const skillMap = {};

  for (const s of SKILLS_SEED) {
    const skill = await prisma.skill.upsert({
      where:  { name: s.name },
      update: {
        description:         s.description,
        promptKey:           s.promptKey,
        maxTokens:           s.maxTokens,
        outputSchema:        s.outputSchema        ?? null,
        promptTemplate:      s.promptTemplate      ?? null,
        defaultInstructions: s.defaultInstructions ?? null,
      },
      create: {
        name:                s.name,
        slug:                s.slug ?? s.name,
        description:         s.description,
        promptKey:           s.promptKey,
        maxTokens:           s.maxTokens,
        outputSchema:        s.outputSchema        ?? null,
        promptTemplate:      s.promptTemplate      ?? null,
        defaultInstructions: s.defaultInstructions ?? null,
      },
    });
    skillMap[s.name] = skill.id;
    console.log(`  Skill upserted: ${s.name}`);
  }

  console.log('Seeding Plugins...');
  for (const p of PLUGINS_SEED) {
    const plugin = await prisma.plugin.upsert({
      where:  { name: p.name },
      update: { description: p.description },
      create: { name: p.name, description: p.description, category: p.category },
    });
    console.log(`  Plugin upserted: ${p.name}`);

    for (let i = 0; i < p.skills.length; i++) {
      const skillName = p.skills[i];
      const skillId   = skillMap[skillName];
      if (!skillId) throw new Error(`Seed: skill "${skillName}" not found for plugin "${p.name}"`);

      await prisma.pluginSkill.upsert({
        where:  { pluginId_skillId: { pluginId: plugin.id, skillId } },
        update: { order: i + 1 },
        create: { pluginId: plugin.id, skillId, order: i + 1 },
      });
      console.log(`    PluginSkill: ${p.name} → ${skillName} (order ${i + 1})`);
    }
  }

  console.log('Skills & Plugins seeding complete.');
}

seed()
  .then(() => seedSkillsAndPlugins())
  .catch(console.error)
  .finally(() => prisma.$disconnect());
