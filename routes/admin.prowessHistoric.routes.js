'use strict';

const router = require('express').Router();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { randomUUID } = require('crypto');
const { z }  = require('zod');
const validate = require('../middleware/validate');
const ctrl     = require('../controllers/admin.prowessHistoric.controller');

// The single admin ingestion path: annual/quarterly Prowess CSV exports
// (via prowess_mappers/ProwessUploader.js) and daily stock OHLCV CSV exports
// (via prowessOhlcvCsvParser.js). Files are temp uploads only — deleted after
// processing (see services/prowessHistoric.service.js) since, unlike document
// uploads, nothing downstream needs to fetch them again.

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'prowess-historic');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, _file, cb) => cb(null, `${randomUUID()}.csv`),
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.csv') {
      return cb(new Error(`Unsupported file type: expected a .csv file, got "${file.originalname}".`));
    }
    cb(null, true);
  },
});

const uploadBodySchema = z.object({
  mode:     z.enum(['annual', 'quarterly', 'daily', 'index']),
  doClear:  z.preprocess(v => v === 'true' || v === true, z.boolean()).optional(),
  rowLimit: z.string().regex(/^\d+$/).optional(),
});

// POST /admin/prowess/historic/preview — multipart/form-data: file, mode (annual|quarterly|daily|index)
router.post('/preview', upload.single('file'), validate(uploadBodySchema, 'body'), ctrl.previewHistoricCsv);

// POST /admin/prowess/historic/run — same payload, actually inserts into prowess_values_new
router.post('/run', upload.single('file'), validate(uploadBodySchema, 'body'), ctrl.runHistoricCsv);

module.exports = router;
