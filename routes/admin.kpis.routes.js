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

const listQuerySchema = z.object({
  search: z.string().optional(),
  limit:  z.coerce.number().int().positive().optional(),
});

const createKpiSchema = z.object({
  abbr:          z.string().min(1),
  full_form:     z.string().min(1),
  denomination:  z.enum(DENOMINATIONS).optional(),
  kpi_type:      z.enum(KPI_TYPES).optional(),
  industry:      z.array(z.string()).optional(),
  // Raw Prowess column/indicator name this Kpi should resolve from.
  // Defaults to `abbr` server-side when omitted.
  prowess_name:  z.string().optional(),
});

// GET /admin/kpis?search=&limit= — search existing KPIs (e.g. to check if an
// indicator already exists before creating a new one, or to pick one to alias).
router.get('/', validate(listQuerySchema, 'query'), ctrl.listKpis);

// POST /admin/kpis — create a new KPI, e.g. for a quarterly/annual Prowess
// indicator that isn't covered by ProwessUploader's hardcoded column maps yet.
router.post('/', validate(createKpiSchema, 'body'), ctrl.createKpi);

module.exports = router;
