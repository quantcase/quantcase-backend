'use strict';

const router      = require('express').Router();
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
const { randomUUID } = require('crypto');
const { z }        = require('zod');
const validate      = require('../middleware/validate');
const ctrl          = require('../controllers/admin.documentUpload.controller');

const DOC_TYPES = ['transcript', 'ppt', 'annual_report'];

// Admin direct-upload for companies where BSE (or the IR page) only exposes a
// raw PDF, not a crawlable link. Files are saved to local disk under
// uploads/<docType>/ and served back statically from server.js so the rest of
// the pipeline (jobs.service.js etc.) can fetch() them exactly like a BSE URL.

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', req.params.docType);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  // Server-generated filename — never trust the client-supplied original name.
  filename: (_req, _file, cb) => cb(null, `${randomUUID()}.pdf`),
});

const upload = multer({
  storage,
  limits: { fileSize: 75 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!DOC_TYPES.includes(req.params.docType)) {
      return cb(new Error(`Invalid docType "${req.params.docType}". Must be one of: ${DOC_TYPES.join(', ')}`));
    }
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Upload a PDF.`));
    }
    cb(null, true);
  },
});

const uploadBodySchema = z.object({
  company:     z.string().min(1),
  fiscal_year: z.string().min(1),
  quarter:     z.string().optional(),
  call_date:   z.string().optional(),
});

// POST /admin/documents/upload/:docType (docType: transcript|ppt|annual_report)
// multipart/form-data: file, company, fiscal_year, quarter? (required for transcript/ppt), call_date?
router.post(
  '/upload/:docType',
  upload.single('file'),
  validate(uploadBodySchema, 'body'),
  ctrl.uploadDocument,
);

module.exports = router;
