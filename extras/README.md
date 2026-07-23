# extras/

Catch-all for **non-documentation artifacts** that were previously scattered across
`docs/` and the repo root. These are data dumps, one-off exports, ad-hoc scripts, raw
logs, and LLM prompt text — useful to keep around, but not project documentation.

Project documentation now lives under [`../docs/`](../docs/). Nothing here is loaded by the
running application **except** the OHLCV price CSVs (see below), which are a batch-ingest
input, not runtime state.

## Layout

| Folder | What's in it | Provenance |
|--------|--------------|------------|
| `data-exports/` | DB/CSV/spreadsheet dumps: `lens_scores_export.csv`, `lens_scores_broken.csv`, `rule_engine.csv`, the two `QC - Wrong Quarter Fixes` batches, `RELIANCE_signals.csv`, `skills.json`, `skills.gz` | moved from `docs/` and repo root |
| `ohlcv/` | 53 Prowess bulk price CSVs — **batch-ingest input** for `scripts/ingest_prowess_ohlcv.js` (`OHLCV_DIR` points here) | moved from `docs/ohlcv/` |
| `scripts/` | One-off / debug scripts: `check-prowess-csv.py`, `debug_signals_tmp.js` | moved from `docs/` and repo root |
| `skill-prompts/` | Raw LLM skill/prompt text: `TECHNICAL SKILL.md`, `deal-verdict.md`, `opportunity-verdict.md` (runtime prompt config lives in the DB via `skills`/`plugins`; these are archived copies) | moved from `docs/` |
| `logs/` | Captured runtime log output: `logs.md` | moved from `docs/` |
| `notes/` | Loose scratch notes: `mfdata.md` | moved from `docs/` |

## Notes

- **`ohlcv/` is code-referenced.** `scripts/ingest_prowess_ohlcv.js` and
  `services/prowess/prowessOhlcvCsvParser.js` read these CSVs from `extras/ohlcv/`. Two
  known hygiene issues live in that folder: `osc_sheet_60 (1).csv` is a byte-identical
  duplicate of `osc_sheet_60.csv` — the bulk-ingest script explicitly skips it by name
  (`f !== 'osc_sheet_60 (1).csv'`), so a full run won't double-ingest it, but that guard is
  fragile (name-based) and the admin single-file upload path has no such guard; the
  duplicate is safe to delete. `20211216 - 20220131.cs.csv` has a typo double-extension
  (harmless — still matches `*.csv`).
- `data-exports/QC - Wrong Quarter Fixes - Pre-FY25.csv` is the default input for
  `scripts/analysis/analyze_L1_v2_multi_csv.js`.
- These files are intentionally **kept in git** (moved with `git mv`, history preserved).
  If the repo needs slimming later, `data-exports/` and `ohlcv/` are the candidates to
  untrack.
