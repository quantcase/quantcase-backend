'use strict';

const prisma = require('../config/prisma');
const pipelineJobRetry = require('../services/pipelineJobRetry.service');

// GET /admin/pipeline-jobs/truncated?queue=
const previewTruncated = async (req, res, next) => {
  try {
    const { queue } = req.query;
    const result = await pipelineJobRetry.previewTruncated(queue);
    res.json(result);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
};

// POST /admin/pipeline-jobs/truncated/split-retry?queue=
const splitRetryTruncated = async (req, res, next) => {
  try {
    const { queue } = req.query;
    const result = await pipelineJobRetry.bulkSplitRetryTruncated(queue);
    res.json(result);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
};

// GET /admin/pipeline-jobs/signals?ticker=&page=&size=&isInvalidated=&sourceDocType=
// Latest-first, paginated raw fetch off transcript_signals_v2 — no grouping,
// no joins. `ticker` is required: the table has ~11.8M rows and no index on
// created_at, so an unscoped "latest across everything" query times out;
// scoping to ticker lets Postgres use the existing tsv2_ticker index to
// narrow first, then sort in-memory (fast — confirmed ~150ms on real data).
// isInvalidated defaults to false (normal signals); pass true to view the
// invalidated ones instead. Admin cross-references lineageId/callId/createdAt
// against Bull Board or their own knowledge themselves.
const listSignals = async (req, res, next) => {
  try {
    const { page, size, isInvalidated, ticker, sourceDocType } = req.query;
    const where = {
      ticker,
      is_invalidated: isInvalidated === true,
      ...(sourceDocType ? { source_doc_type: sourceDocType } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.transcriptSignalV2.count({ where }),
      prisma.transcriptSignalV2.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * size,
        take: size,
        select: {
          id: true, call_id: true, ticker: true, company: true, fiscal_year: true, quarter: true,
          source_doc_type: true, signal_type: true, lineage_id: true, source_hash: true,
          is_invalidated: true, created_at: true, extractor_model: true, prompt_v: true,
        },
      }),
    ]);

    res.json({
      total, page, size,
      signals: rows.map(r => ({
        id:            r.id,
        callId:        r.call_id,
        ticker:        r.ticker,
        company:       r.company,
        fiscalYear:    r.fiscal_year,
        quarter:       r.quarter,
        sourceDocType: r.source_doc_type,
        signalType:    r.signal_type,
        lineageId:     r.lineage_id,
        sourceHash:    r.source_hash,
        isInvalidated: r.is_invalidated,
        createdAt:     r.created_at.toISOString(),
        extractorModel: r.extractor_model,
        promptV:       r.prompt_v,
      })),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { previewTruncated, splitRetryTruncated, listSignals };
