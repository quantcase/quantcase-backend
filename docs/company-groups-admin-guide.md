# Company Groups — Admin Guide

For the frontend team, to build a "manage company groups" admin screen and to
wire group selection into pipeline-dispatch flows (L1 today; L2/L3 later).
Written for non-backend readers — if you just need request/response shapes,
skip to **Section 3**.

## 1. What this is for

Instead of typing out a ticker list every time an admin runs a dispatch, they
can define a **Company Group** once — either a hand-picked list, or a filter
("every company with a market cap over 5,000cr", "everything with an annual
report URL but no extracted signals yet") — and pick it from a dropdown
wherever a ticker list is needed.

Filter-based groups are **live, not snapshots**: a "market cap > 5,000cr"
group always reflects today's prices, and a "has annual report" group always
reflects whatever's in the DB right now. There's nothing to "refresh" — every
time a group is used, its membership is recomputed on the spot. Only
manually-curated groups are static, because that's the point of them (an
admin explicitly chose those tickers).

## 2. Group shape

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` (uuid) | Server-generated, read-only. Not needed for lookups — use `slug` everywhere. |
| `slug` | `string` | Unique identifier, used everywhere a group is referenced. Auto-generated from `name` if omitted on create. |
| `name` | `string` | Display name. |
| `description` | `string?` | Optional free text — explain the intent so other admins understand it later. |
| `filter_type` | `"manual"` \| `"dynamic"` | Which shape `filter_config` takes. |
| `filter_config` | `object` | See below. |
| `created_at` | `string` (ISO datetime) | Read-only. |
| `updated_at` | `string` (ISO datetime) | Read-only, bumped on every `PUT`. |

`GET /`, `GET /:slug`, `POST /`, and `PUT /:slug` all return the full object
above (as `data`). Nothing is omitted or renamed between create/read/update —
what you get back from `POST` is exactly what a later `GET /:slug` returns.

**`filter_type: "manual"`**
```json
{ "tickers": ["CANBK", "MSUMI", "IEX"] }
```
Just an explicit list. Nothing computed.

**`filter_type: "dynamic"`** — `filter_config` is a flat set of independent
filters. Each one you include is **ANDed** with the others (chained in
series) — a company must satisfy every filter present to be in the group.
There's no "OR" between filters; if you want that, make two groups.

```jsonc
{
  // Ticker starts with a letter in this (inclusive) range
  "nameRange": { "from": "A", "to": "C" },

  // Transcript-based. status defaults to "present" if omitted.
  "transcript": {
    "status": "present",   // "present" | "pending" | "extracted"
    "lastN": 4              // optional — only look at each company's 4 most recent quarters
  },

  // Same shape as transcript, but for PPTs
  "ppt": { "status": "pending" },

  // Same idea, but lastN counts fiscal years (reports), not quarters
  "annualReport": { "status": "extracted", "lastN": 2 },

  // Market cap range in ₹ crore, using each company's latest known price
  "marketCap": { "min": 5000, "max": null },

  // Sector/industry match (earnings_calls.basic_industry values)
  "industries": ["Banks", "NBFC"]
}
```

Any subset of these six keys is valid — e.g. a group with only `marketCap`
set, or one combining `industries` + `ppt: {status:"pending"}` ("banks with a
PPT backlog").

**`status`** (on `transcript` / `ppt` / `annualReport`, default `"present"`):
- `"present"` — the document exists in the DB (URL is set).
- `"pending"` — document exists but has **no** non-invalidated L1 signal yet
  (the extraction backlog for that doc type).
- `"extracted"` — document exists **and** already has a non-invalidated
  signal (the inverse of `"pending"`).

**`lastN`** (optional, on `transcript` / `ppt` / `annualReport`): instead of
checking "ever, across all history", restricts the check to each company's
own N most recent reporting periods (quarters for transcript/ppt, fiscal
years for annualReport). Omit it to check all-time. This is what makes
"latest 2 quarters" groups stay correct forever without editing — there's no
hardcoded fiscal year/quarter anywhere.

> Known gap: `status: "pending"` or `"extracted"` can time out on this DB.
> `status: "present"` is always safe (doesn't touch signals at all).
> `transcript`/`ppt` with `pending`/`extracted` are safe **as long as
> `lastN` is set** (unscoped all-time checks can time out from candidate-list
> size). `annualReport` with `pending`/`extracted` timed out even with
> `lastN: 1` in testing — that doc type needs a backend fix (likely a DB
> index pass) before it's reliable, independent of `lastN`. Until fixed,
> the create/edit form should avoid offering `pending`/`extracted` on the
> Annual report card, or mark it experimental.

## 3. Endpoint reference

Base path: `/admin/company-groups`

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | List all groups. |
| `POST` | `/` | Create a group. Body: the group shape from Section 2 (`slug` optional). |
| `GET` | `/:slug` | Get one group's definition. |
| `PUT` | `/:slug` | Update a group (partial body accepted). |
| `DELETE` | `/:slug` | Delete a group. |
| `GET` | `/:slug/resolve` | **Live preview** — resolves the group right now and returns the ticker list. Read-only, no side effects, safe to call as often as you like (e.g. every time the admin edits a filter in a form, to show a live count). |

All responses are `{ success: true, data: ... }`. Errors are
`{ success: false, error: "..." }` with the appropriate HTTP status
(404 for an unknown slug, etc).

`GET /:slug/resolve` response:
```json
{ "success": true, "data": { "tickers": ["CANBK", "HDFCBANK", "..."], "count": 42 } }
```

**Suggested screen flow**: as the admin fills in a filter form, call
`/resolve` against a draft/unsaved config (you'll need a way to resolve an
*unsaved* filter — see note below) or just call it right after `POST`/`PUT`
so they can see "this group currently matches 42 companies" before moving on.

> Note: there is currently no "dry-run resolve an arbitrary filter_config
> without saving" endpoint — resolution only works against a saved group.
> If you need live-preview-while-editing in the create/edit form (recommended
> UX), flag it and we'll add a `POST /company-groups/resolve-preview` that
> takes a `filter_config` body directly. Until then, the simplest flow is:
> save → resolve → let the admin edit again if the count looks wrong.

## 4. Using a group in L1 dispatch

The existing L1 multi-dispatch options (`/admin/pipeline-dispatch/l1-multi/*`
— see `pipeline-dispatch-l1-multi-admin-guide.md`) now accept an optional
`groupSlug` field alongside `tickers`/`all`:

```json
{ "groupSlug": "large-cap-banks", "latest": 1 }
```

If `groupSlug` is set, it takes precedence over `tickers`/`all` — the group's
resolved ticker list is used instead. `startFrom` still applies on top of it
if you need to resume a partial run.

`GET /admin/pipeline-dispatch/l1-multi/options` now also returns:
```jsonc
{
  "defaultTickers": [...],
  "companies": [...],
  "companyGroups": [
    { "slug": "large-cap-banks", "name": "Large Cap Banks", "filter_type": "dynamic" }
  ]
}
```
Use `companyGroups` to populate a "run against a saved group" dropdown as a
third option next to "default list" / "pick tickers manually" on the L1
dispatch screen.

**L2/L3**: not wired up yet — those admin-triggered dispatch flows don't
exist yet. When they're built, they'll accept the same `groupSlug` field.

## 5. Suggested UI copy

- Group list screen: show `name`, `description`, `filter_type`, and a live
  ticker count (call `/resolve` per row, or lazily on expand if the list is
  long — resolving is a real DB query, not free).
- Create/edit form: radio between "Manual list" and "Filter-based". For
  filter-based, expose each of the six filters as its own independent
  checkbox/card (matches what's already built): **Alphabet range**,
  **Transcript**, **PPT**, **Annual report**, **Market cap range**,
  **Industry**. Checking one reveals its own mini-config inline (e.g.
  checking "Transcript" reveals a status dropdown + optional "latest N
  quarters" number field). None selected → warn: *"No filters selected —
  this group will always be empty."*
- For Transcript/PPT/Annual report cards, the status dropdown: label the
  three options as *"Present"*, *"Not yet extracted"* (pending), and
  *"Already extracted"*. Default to "Present" pre-selected. The "latest N"
  field is optional — label it *"Only look at the N most recent
  [quarters/years]"* with a placeholder like *"All history"* when empty.
- Since filters chain as AND only, don't offer an any/all toggle anymore —
  if an admin wants "transcript OR ppt", that's two separate groups.
- On the L1 dispatch screen's group dropdown: show the live count next to
  each group name (e.g. "Large Cap Banks (42)") so the admin isn't surprised
  by scope before hitting Preview.
