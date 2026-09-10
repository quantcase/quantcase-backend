'use strict';

const router = require('express').Router();
const multer = require('multer');
const ctrl   = require('../../controllers/wealthos/import.controller');

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB
});

router.post('/preview', upload.single('file'), ctrl.preview);
router.post('/execute', upload.single('file'), ctrl.execute);
router.get('/history', ctrl.history);

module.exports = router;
