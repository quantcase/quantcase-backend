'use strict';

const router       = require('express').Router();
const multer       = require('multer');
const { z }        = require('zod');
const authenticate = require('../middleware/authenticate');
const validate     = require('../middleware/validate');
const ctrl         = require('../controllers/portfolio.controller');

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Upload CSV or XLSX.`));
  },
});

const addHoldingSchema = z.object({
  ticker: z.string().min(1),
});

// All portfolio routes require authentication
router.use(authenticate);

// ─── User Portfolio ──────────────────────────────────────────────────────────
router.get('/user',         ctrl.getUserPortfolio);
router.post('/user/upload', upload.single('file'), ctrl.uploadUserPortfolio);

// ─── Investor Dashboard ──────────────────────────────────────────────────────
router.get('/mod-synopsis', ctrl.getModSynopsis);
router.get('/summary',      ctrl.getHoldingsSummary);
router.get('/whats-moving', ctrl.getWhatsMoving);

// ─── Shadow Portfolio ────────────────────────────────────────────────────────
router.get('/shadow',      ctrl.getShadowPortfolio);
router.post('/shadow/add', validate(addHoldingSchema, 'body'), ctrl.addToShadowPortfolio);

// ─── Holdings CRUD ───────────────────────────────────────────────────────────
router.patch('/holdings/:holdingId',  ctrl.updateHolding);
router.delete('/holdings/:holdingId', ctrl.deleteHolding);

// Holding notes have moved to the unified journal (POST /api/journal/journals/
// :journalId/tickers/:ticker/entries). See docs/JOURNAL_FRONTEND_INTEGRATION.md.

module.exports = router;
