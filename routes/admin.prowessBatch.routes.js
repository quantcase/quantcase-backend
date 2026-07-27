'use strict';

const router = require('express').Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { randomUUID } = require('crypto');
const { z }  = require('zod');
const validate = require('../middleware/validate');
const ctrl     = require('../controllers/admin.prowessBatch.controller');

// Live Prowess SendBatch/GetBatch flow. The uploaded file here is the
// proprietary CMIE binary batch file (built by the admin via Prowess's own
// tooling) — we relay it to SendBatch as-is and never parse it ourselves,
// see prowess_mappers/ProwessUploader.js. Deleted after submission; Prowess
// has it server-side once SendBatch succeeds.

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'prowess-batch');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, _file, cb) => cb(null, randomUUID()),
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const sendBodySchema = z.object({
  // 'daily' = OHLCV/valuation query → nse_equity_new (auto-ingested on resolve).
  // 'annual'/'quarterly' = company filings query → prowess_values_new (resolved zip
  // captured but not yet auto-ingested — see prowessBatchOrchestrator.service.js).
  mode: z.enum(['daily', 'annual', 'quarterly']),
  note: z.string().optional(),
});

// POST /admin/prowess/batch/send — multipart/form-data: batchfile, mode, note?
router.post('/send', upload.single('batchfile'), validate(sendBodySchema, 'body'), ctrl.sendBatch);

// POST /admin/prowess/batch/daily/run — submits the fixed daily_ohlcv.bt template checked
// into the repo (services/prowess/daily_ohlcv.bt), no upload needed.
router.post('/daily/run', ctrl.runDaily);

// POST /admin/prowess/batch/:token/check — on-demand poll (no waiting for the scheduler tick)
router.post('/:token/check', ctrl.checkBatch);

// GET /admin/prowess/batch/:token — current DB state
router.get('/:token', ctrl.getBatchStatus);

// GET /admin/prowess/batch?status=pending — list, most recent first
router.get('/', ctrl.listBatches);

// POST /admin/prowess/batch/abort-all — cancels every pending batch for this API key
router.post('/abort-all', ctrl.abortAll);

module.exports = router;
