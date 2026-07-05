# Pipeline Dispatch — L1 Multi — Admin Guide

For the frontend team, to build an admin screen for on-demand L1 extraction
(transcript + PPT + annual report signal extraction) at
`/admin/pipeline-dispatch/l1-multi`. Written for non-backend readers — if you
just need request/response shapes, skip to **Section 3**.

## 1. What this is for

L1 extraction normally happens two ways today: automatically (a cron job
scans for anything new every day) or manually from a developer's terminal
(a CLI script with a fixed ticker list and various flags). This admin surface
is the manual path, made clickable: an admin picks a ticker set and some
options in a form and hits **Run** — nothing here is scheduled or automatic.
Every run is one-off and explicit.

There is **no cron/auto mode** on this screen by design — if it needs to
happen on a schedule, that's the separate automatic pipeline job, not this
one. This is for "we changed something and need to re-extract these 12
tickers" or "let's do a scoped backfill for this sector."

Two calls of the same shape:
- **Preview** — read-only. Shows what *would* be queued (how many calls,
  which quarters, whether transcript/PPT/annual-report URLs exist) without
  actually dispatching anything. Free, instant, safe to spam.
- **Run** — actually dispatches. Each item queues a real LLM extraction job
  (costs money, takes time). Always show Preview results first and let the
  admin confirm before offering Run.

## 2. Options — same body shape for Preview and Run

| Field | Type | Meaning |
|---|---|---|
| `groupSlug` | `string` | Use a saved [Company Group](./company-groups-admin-guide.md) instead of picking tickers by hand. Takes precedence over `tickers`/`all` if set. See `GET /l1-multi/options` → `companyGroups` for the picker list. |
| `tickers` | `string[]` | Explicit ticker list to process. Ignored if `groupSlug` is set. Omit both to fall back to the default list (see `GET /l1-multi/options`). |
| `all` | `boolean` | If `true` (and no `groupSlug`), ignores `tickers` entirely and processes **every** company that has any earnings call in the DB. Slow — there are ~2,000. |
| `startFrom` | `string` | Alphabetical cursor — keeps only tickers `>=` this value (after `tickers`/`all` is resolved). Useful for resuming a long `--all` run that got interrupted partway through. |
| `limit` | `number` | Cap on how many of a ticker's most-recent calls/reports are considered. Annual reports default to the 3 most recent if neither `limit` nor `latest` is set. |
| `latest` | `number` | Same idea as `limit` ("N most recent quarters"), takes precedence if both are set. |
| `force` | `boolean` | Re-extract even if signals already exist for that document — invalidates the old ones first. Without this, anything already extracted is skipped. |
| `arOnly` | `boolean` | Annual reports only — skips transcript and PPT entirely. |
| `noAr` | `boolean` | Skips annual reports entirely. |

`arOnly` and `noAr` are mutually exclusive in intent — don't let the UI check
both at once (that would process nothing).

Everything is optional. An empty body (`{}`) means: default ticker list,
all available history per ticker, skip anything already extracted, all three
document types.

## 3. Endpoint reference

**Options / pickers**
- `GET /admin/pipeline-dispatch/l1-multi/options` — `{ defaultTickers: string[], companies: string[], companyGroups: [{slug, name, filter_type}] }`. Use `defaultTickers` to preselect the picker, `companies` (every distinct company in the DB) if you want a searchable "add a custom ticker" input, and `companyGroups` to offer "run against a saved group" (see [Company Groups guide](./company-groups-admin-guide.md)) — pass the chosen group's `slug` as `groupSlug` in preview/run.

**Preview** — `POST /admin/pipeline-dispatch/l1-multi/preview`
- Body: the options shape from Section 2.
- Response:
  ```jsonc
  {
    "tickerCount": 3,
    "tickers": ["CANBK", "MSUMI", "IEX"],
    "perTicker": [
      {
        "symbol": "CANBK",
        "calls": {
          "shown": 2, "total": 14,
          "items": [
            { "id": "...", "fiscal_year": 2026, "quarter": "Q1", "hasTranscript": true, "hasPpt": true }
          ]
        },
        "annualReports": {
          "shown": 2, "total": 5,
          "items": [
            { "id": "...", "fiscal_year": 2025, "hasUrl": true }
          ]
        }
      }
    ]
  }
  ```
- No side effects, not logged anywhere — call it as often as you like while the admin is tweaking options.

**Run** — `POST /admin/pipeline-dispatch/l1-multi/run`
- Body: same options shape.
- Response is immediate and *does not* mean the work is done:
  ```json
  { "success": true, "message": "L1 multi-dispatch triggered", "run_id": "..." }
  ```
- The actual dispatch loop runs in the background on the server. Use `run_id`
  to poll status (Section 4).

**Run history** — `GET /admin/pipeline-dispatch/l1-multi/runs?limit=20`
- `{ count, runs: [...] }` — most recent first, default 20, max 100.

## 4. Polling a run

Each run row (`SchedulerRun`) looks like this while in flight and once done:

| Field | While running | On success | On failure |
|---|---|---|---|
| `status` | `"running"` | `"completed"` | `"failed"` |
| `ended_at` | `null` | timestamp | timestamp |
| `records_processed` | `null` | total items queued (an int) | `null` |
| `error` | `null` | `null` | error message string |
| `metadata` | `null` | `{ queued, skipped, noSource, failed, tickerCount, perTicker }` | `null` |

`metadata.perTicker` is the same per-ticker breakdown shape as the totals
(not the detailed preview shape) — `[{ symbol, queued, skipped, noSource, failed }]`.

Poll `GET /l1-multi/runs?limit=1` (or filter client-side by `id === run_id`
from the trigger response) every few seconds until `status` is no longer
`"running"`.

## 5. Suggested UI copy

- Run button, disabled until Preview has been called at least once for the
  current option set: *"Preview before running — this queues real extraction
  jobs and can't be cancelled once started."*
- `force` checkbox: *"Re-run tickers that already have extracted signals
  (discards the old ones)."* Off by default.
- `all` checkbox: warn when checked — *"This will scan every company in the
  database (~2,000). Consider `startFrom` to resume a partial run."*
- While a run is `"running"`: *"Dispatching... this can take a while for
  large ticker sets. You can navigate away — check back under Run History."*
- On `"failed"`: show `error` verbatim plus a note that partial progress
  (whatever queued before the failure) is not rolled back.
