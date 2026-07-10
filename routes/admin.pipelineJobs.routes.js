'use strict';

const router = require('express').Router();
const { z }  = require('zod');
const validate = require('../middleware/validate');
const c = require('../controllers/admin.pipelineJobs.controller');
const { KNOWN_QUEUES } = require('../services/pipelineJobRetry.service');

const scopeQuerySchema = z.object({ queue: z.enum(KNOWN_QUEUES).optional() });

const signalsQuerySchema = z.object({
  // ticker is required, not optional: transcript_signals_v2 has ~11.8M rows
  // and no index on created_at, so an unscoped "latest across everything"
  // query times out (tested — 60s+, confirmed via EXPLAIN it'd be a full
  // scan+sort). Scoping to ticker lets Postgres use the existing tsv2_ticker
  // index to narrow first (confirmed fast: ~150ms via EXPLAIN on a real
  // ticker) instead of adding a new index.
  ticker:        z.string().min(1),
  page:          z.coerce.number().int().min(1).default(1),
  size:          z.coerce.number().int().min(1).max(200).default(50),
  // z.coerce.boolean() would treat "false" as truthy (non-empty string) —
  // enum + explicit transform avoids that trap.
  isInvalidated: z.enum(['true', 'false']).optional().transform(v => v === 'true'),
  sourceDocType: z.enum(['transcript', 'ppt', 'annual_report']).optional(),
});

router.get( '/truncated',             validate(scopeQuerySchema, 'query'), c.previewTruncated);
router.post('/truncated/split-retry', validate(scopeQuerySchema, 'query'), c.splitRetryTruncated);
router.get( '/signals',               validate(signalsQuerySchema, 'query'), c.listSignals);

module.exports = router;
