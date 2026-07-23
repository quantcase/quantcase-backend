[Docs](../README.md) · [Admin guides](../README.md#existing-reference-material) · HTML Incremental Skills — Admin Guide

# HTML Incremental Skills — Admin Guide

For the frontend team, to build a help section for the admin tool at
`/api/html-incremental-skills`. Written for non-backend readers — if you just
need field-by-field UI copy, skip to **Section 4** and **Section 6**.

## 1. What this is for

This is the "let a skill build on its own prior analysis" version of the
regular HTML skills flow. Instead of re-generating a full analysis from
scratch every quarter, a skill can be run **incrementally**: feed the LLM only
the *new* signals since the last analysis, plus that last analysis itself as
context, and ask it to produce an updated view. Cheaper, faster, and — because
the model sees its own prior conclusions — more consistent quarter to quarter.

The two modes (below) map directly onto backtesting workflows:
- **Historic** answers "what would this skill have concluded as of period X,
  using everything known up to that point?" — useful for generating a clean
  run at a fixed point in time to use as a comparison baseline, or for
  reproducing what a ticker's analysis looked like historically.
- **Incremental** answers "given what changed since the baseline, what's the
  updated view?" — useful for simulating how the skill's output would have
  evolved call-by-call if it had been run incrementally in production, which
  is the actual intended steady-state usage.

Running historic at several past periods for the same ticker, then chaining
incremental runs forward from a chosen one, lets an admin reconstruct — and
sanity-check — the whole decision trail a live incremental deployment would
have produced.

## 2. Historic vs Incremental — same engine, two settings

Both modes share one code path. A run is defined by three things: a **target
period** (from `callId`), a **lower bound** (how far back signals are allowed
to come from), and an **upper bound** (never look past the target period,
in either mode — this stops a Q3 run from accidentally seeing Q4 data that
already landed in the DB by the time you're testing).

| | Historic | Incremental |
|---|---|---|
| Requires a base (prior output)? | No | **Yes** — 400 error if none exists |
| Lower bound on signals | None — pulls everything up to the target period | The base's own period (exclusive) — only the delta since then |
| Upper bound on signals | Target period (from `callId`) | Target period (from `callId`) |
| Prior-analysis text included in prompt? | No | **Yes** — the base output's summary is prepended as a `PRIOR ANALYSIS` block |
| Which recency caps apply | `historic_max_*` fields (falls back to the normal `max_*` fields if unset) | the normal `max_*` fields |

So: **historic is "everything up to callId, capped by N periods, no memory of
a prior run." Incremental is "only what's new since the base, capped by N
periods, plus the base's own conclusions as context."** The `callId` cap
behaves identically in both — it's what makes historic runs safe to use for
backtesting a specific point in time rather than always reflecting today's
full DB state.

If a ticker has never had a historic run, incremental will 400. The UI should
offer "run historic first" whenever `GET /:slug/outputs/:ticker` 404s.

## 3. The global pin — what it's actually for

`pinned_fiscal_year` / `pinned_quarter` / `pinned_historic` live on the
**skill**, not on a ticker. Setting them fixes the "base" used for
**every ticker's incremental run under that skill** to one exact period.

Why this matters for backtesting: without a pin, each ticker's incremental
run just uses *that ticker's own* most recent output as base — which drifts,
since different tickers get run at different times. That makes cross-ticker
comparison unreliable (ticker A's incremental delta might be measured from
last quarter, ticker B's from six months ago). Pinning forces every ticker
onto the same starting line — e.g. "every ticker's incremental run this cycle
is measured against its FY2025 Q3 historic output" — so results are
comparable across the whole universe.

Consequence: if a ticker doesn't have an output at the exact pinned period,
it has **no base at all** (not a fallback to its own latest) — it 400s until
someone runs a historic pass for it at that period. That backfill-across-all-
tickers step is a scheduler job for later; today, pinning only changes which
*existing* output counts as base, it doesn't generate missing ones.

Clearing the pin (`null` all three fields) reverts every ticker to its own
"N most recent outputs" (`max_base_analyses`) fallback — no global anchor.

## 4. Config fields (skill CRUD — `POST /`, `PUT /:slug`)

**Signal type whitelists** — which L1 signal types are eligible at all for
this skill (empty array/omitted = whitelist not enforced, so behavior depends
on the caps below):
- `transcript_signal_types`, `ppt_signal_types`, `annual_report_signal_types`,
  `market_data_signal_types` — arrays of signal-type strings.

**Recency caps** — how many distinct periods of each source type are pulled,
most-recent-first (applies to both modes, historic falls back to these if its
own override is unset):
- `max_transcript_qtrs` — max distinct transcript quarters
- `max_ppt_qtrs` — max distinct PPT quarters
- `max_annual_report_years` — max distinct annual-report years
- `max_market_data_months` — how many months of PE/CMP timeseries to attach

**Historic-only overrides** — same four caps, but only used in historic mode
(nullable; falls back to the caps above when unset). Typically set larger
than the normal caps, since a historic run is meant to look back further than
an incremental delta run:
- `historic_max_transcript_qtrs`, `historic_max_ppt_qtrs`,
  `historic_max_annual_report_years`, `historic_max_market_data_months`

**Base context behavior**:
- `max_base_analyses` — when no global pin is set, how many of the ticker's
  own most recent outputs to stitch together as base context (usually 1).
- `strip_html` — if true, prior-analysis context is sent as parsed markdown
  (via the HTML→Markdown converter) instead of raw HTML — cheaper on tokens,
  no loss of tables/chart data/embedded dashboard content.
- `pinned_fiscal_year`, `pinned_quarter`, `pinned_historic` — the global pin
  (see Section 3). All three null = no pin, per-ticker fallback applies.

**LLM / lifecycle**:
- `model`, `max_tokens` — LLM call config.
- `is_active` — soft-disable a skill; `POST /:slug/run` 400s if inactive.

## 5. Endpoint reference

**Config**
- `GET /` — list skills (`?includeInactive=true` to include disabled ones)
- `GET /:slug` — one skill's full config, including current pin state
- `POST /` — create a skill
- `PUT /:slug` — update any of the fields in Section 4
- `DELETE /:slug` — soft-delete (`is_active: false`)

**Signal previews** (for config-editor badges / "what would this pull" UI)
- `GET /signals/count/:ticker?slug=&historic=&max_transcript_qtrs=...` —
  `by_source` breakdown (transcript/ppt/annual_report), matching the
  original `/api/html-skills` shape. `historic=false` requires `slug` and
  returns `base_context_count`/`base_missing` reflecting the *current* base
  (pin-aware). Optional cap query params let the UI live-preview "what if I
  changed this cap" without saving.
- `GET /:slug/signals/:ticker?historic=` — the actual signal rows (not just
  counts) that would go into the window, same pin-aware bounding logic.
  Re-fetch after changing the pin — the result changes with it.

**Prompt & run**
- `GET /:slug/prompt/:ticker?callId=&historic=` — dry-run: returns the exact
  system/user prompt and signal counts without calling the LLM. Good for a
  "preview" button before committing to a real (billed) run.
- `POST /:slug/run` — body `{ ticker, callId, force?, historic? }`. Enqueues
  the actual LLM job. `callId` is required in both modes. `force: true`
  bypasses the prompt-version cache and re-runs even if a matching cached
  output exists.

**Outputs**
- `GET /:slug/outputs/:ticker?historic=` — latest output (omit `historic` to
  get the latest regardless of mode — useful for the "has this ticker ever
  been run" check).
- `GET /:slug/outputs/:ticker/history?page=&size=` — paginated list of all
  past outputs for the ticker (for browsing what's available, e.g. to decide
  what period to pin).
- `GET /:slug/outputs/:ticker/:fiscal_year/:quarter?historic=` — one exact
  output by period (`quarter` = `"null"` literal string for annual-report-only
  periods). `historic` defaults to **false** here since a period can have both
  a historic and an incremental row.

## 6. Suggested UI copy

- Skill config screen: a "Global Base Pin" section — Fiscal Year / Quarter /
  Mode (Historic or Incremental) dropdowns + a Clear button. Helper text:
  *"When set, every ticker's incremental run uses its own output at this
  exact period as the baseline. Tickers without a run at this period can't
  run incrementally until one exists."*
- Ticker run screen: if `base_missing: true` comes back from the signals
  preview, show *"No base analysis at the pinned period ({fy} {q}) for this
  ticker yet — run historic mode for that period first."*
- Historic vs Incremental toggle: *"Historic: full analysis using everything
  known up to the selected call. Incremental: analysis of what's changed
  since the pinned/most-recent prior run."*
