-- Speeds up the "signal count per metric" scan in services/kpiDedup.service.js
-- (phase 6, GROUP BY metric over live signals), which was hitting nginx's
-- 60s proxy_read_timeout / DB statement_timeout on transcript_signals_v2
-- (~12.3M live rows, 2.18M pages) before this index existed. Partial index
-- (WHERE is_invalidated = false) can't be expressed in prisma/schema.prisma,
-- so it's applied here manually rather than via `db:push` — `db:push` won't
-- know about it and won't try to drop/recreate it.
--
-- Run via a direct/session DB connection (DIRECT_DATABASE_URL, not the
-- pgbouncer transaction-pool DATABASE_URL) — CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, which transaction-mode pgbouncer
-- can silently wrap it in.
--
-- CONCURRENTLY alone was not enough to get the planner to use the index —
-- transcript_signals_v2's visibility map was only 61.7% covered (relallvisible/
-- relpages), so an Index Only Scan still needed heap fetches for ~38% of
-- rows and the planner correctly preferred a seq scan. A plain VACUUM (not
-- FULL — no rewrite, no exclusive lock) after building the index fixed this;
-- re-run VACUUM transcript_signals_v2 if the query plan regresses back to a
-- seq scan after heavy write activity on this table.
--
-- Applied 2026-07-13: build took ~4:54, VACUUM took ~2:43. Query went from
-- timing out (>60-120s) to 7.2s (7,905 heap fetches out of 12.26M rows).

SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS tsv2_metric_callid_live
  ON transcript_signals_v2 (metric, call_id)
  WHERE is_invalidated = false;

VACUUM transcript_signals_v2;
