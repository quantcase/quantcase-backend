'use strict';

const router  = require('express').Router();
const multer  = require('multer');
const privateEquityController = require('../controllers/privateEquity.controller');

// Store uploaded file in memory; 50 MB limit covers large DRHP PDFs
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'text/plain'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Upload a PDF or plain-text file.`));
  },
});

router.post(
  '/drhp-analyser',
  upload.single('document'),
  privateEquityController.analyseDrhp,
);

router.get('/drhp-analyses', privateEquityController.getDrhpAnalyses);

module.exports = router;
