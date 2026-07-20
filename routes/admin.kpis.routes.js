'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const ctrl      = require('../controllers/admin.kpis.controller');

const DENOMINATIONS = ['rupee', 'percentage', 'ratio', 'other'];
const KPI_TYPES = [
  'assets', 'liabilities', 'equity', 'revenue', 'cogs',
  'operating_expenses', 'profit_lines', 'cashflow',
  'customer_kpis', 'industry_specific',
];
const FREQUENCIES = ['annual', 'quarterly', 'daily'];

const listQuerySchema = z.object({
  search: z.string().optional(),
  limit:  z.coerce.number().int().positive().optional(),
  // 'true' surfaces the full registry-enabled catalogue (raw + formula
  // entries, regardless of source) instead of the QE-only Prowess subset.
  includeAllSources: z.coerce.boolean().optional(),
});

// Fields shared by create/update — computation (formula_expression,
// frequency, fallback_abbrs) and display (unit_label, description) are what
// the formulaRegistry migration added; the rest predate it (raw
// Prowess-ingestion onboarding).
//
// Deliberately NOT exposed here (both flagged as confusing, cleaned up
// 2026-07-18): `display_order` — was only ever read for the old
// constituent_of/statement_of KpiRelationship grouping, superseded by
// KpiGroup (which has its own display_order); Kpi.display_order itself is
// dead weight now, not read by any resolver path. `industry` — populated by
// the Prowess/transcript-ingestion pipelines (services/db/kpis.db.js,
// prowess_mappers/ProwessUploader.js), not something an admin types when
// defining a formula; showing it here implied it scoped the formula, which
// it never did.
const kpiFieldsSchema = z.object({
  full_form:          z.string().min(1),
  denomination:        z.enum(DENOMINATIONS).nullable().optional(),
  kpi_type:            z.enum(KPI_TYPES).nullable().optional(),
  prowess_name:        z.string().nullable().optional(),
  // Null = raw leaf. Arithmetic + CAGR/AVG/SUM/DELTA/MAX/MIN/COALESCE — see
  // utils/formulaRegistry/expressionEvaluator.js. Validated (parsed, refs
  // checked, cycle-checked) server-side before it's ever saved.
  formula_expression:  z.string().nullable().optional(),
  frequency:           z.enum(FREQUENCIES).nullable().optional(),
  fallback_abbrs:      z.array(z.string()).optional(),
  unit_label:          z.string().nullable().optional(),
  description:         z.string().nullable().optional(),
});

const createKpiSchema = kpiFieldsSchema.extend({
  abbr: z.string().min(1),
});

const updateKpiSchema = kpiFieldsSchema.partial();

// GET /admin/kpis/:abbr/preview?symbol=&frequency=&resample_mode= — query params
const previewQuerySchema = z.object({
  symbol:    z.string().min(1),
  frequency: z.enum(FREQUENCIES).optional(),
  // Debug-only override for daily-native abbrs (PRICE/PE_DAILY/MCAP_SNAPSHOT)
  // resolved at a coarser frequency -- lets admin compare 'average' vs
  // 'latest' without persisting anything. Every abbr has a fixed default
  // policy (dataFetcherMarket.js#DAILY_RESAMPLE_MODE) used everywhere else.
  resample_mode: z.enum(['average', 'latest']).optional(),
});

// POST /admin/kpis/validate-formula — live parse+reference check while
// admin is still typing (no abbr required, nothing is saved).
const validateFormulaSchema = z.object({
  formula_expression: z.string().min(1),
});

const createRelationshipSchema = z.object({
  // Free text on purpose — see feedback_generic_over_enum_design memory.
  // The only relationship_type the resolver still acts on is
  // 'variant_for_group' (company-group-scoped formula selection, e.g. BFSI).
  // 'constituent_of'/'statement_of' (flat, single-level grouping) have been
  // superseded by KpiGroup (admin.kpiGroups.routes.js) — a real tree, so
  // don't create new rows of those two types here; existing ones are left in
  // place but are no longer read by any display consumer.
  relationship_type:  z.string().min(1),
  related_kpi_abbr:    z.string().optional(),
  company_group_slug:  z.string().optional(),
  display_order:       z.coerce.number().int().optional(),
});

// GET /admin/kpis?search=&limit=&includeAllSources= — search existing KPIs
// (e.g. to check if an indicator/metric already exists before creating a new one).
router.get('/', validate(listQuerySchema, 'query'), ctrl.listKpis);

// POST /admin/kpis — create a new KPI: either a raw Prowess indicator not yet
// covered by ProwessUploader's hardcoded column maps, or a fully computed
// metric (formula_expression, optionally with fallback_abbrs/frequency).
router.post('/', validate(createKpiSchema, 'body'), ctrl.createKpi);

// POST /admin/kpis/validate-formula — parse + reference check while admin is
// still typing a formula, before anything is saved. No abbr in the URL since
// this can be used for a brand-new KPI that doesn't exist yet.
router.post('/validate-formula', validate(validateFormulaSchema, 'body'), ctrl.validateFormula);

router.get('/:abbr', ctrl.getKpi);

// PUT /admin/kpis/:abbr — edit any field, most notably formula_expression /
// fallback_abbrs / frequency for an existing metric.
router.put('/:abbr', validate(updateKpiSchema, 'body'), ctrl.updateKpi);

// GET /admin/kpis/:abbr/preview?symbol=&frequency= — resolve this KPI for a
// real company (exact same resolver as production, plus a one-level trace of
// its formula's direct references) so admin can verify a formula/fallback
// chain before trusting it.
router.get('/:abbr/preview', validate(previewQuerySchema, 'query'), ctrl.previewKpi);

// KpiRelationship — now only used for company-group-scoped variant selection
// (e.g. BFSI, 'variant_for_group'). Display grouping (expandable rollups,
// statement sections) lives in KpiGroup instead — see admin.kpiGroups.routes.js.
router.get(   '/:abbr/relationships', ctrl.listRelationships);
router.post(  '/:abbr/relationships', validate(createRelationshipSchema, 'body'), ctrl.createRelationship);
router.delete('/:abbr/relationships/:id', ctrl.deleteRelationship);

module.exports = router;
