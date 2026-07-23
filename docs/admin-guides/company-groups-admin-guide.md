[Docs](../README.md) · [Admin guides](../README.md#existing-reference-material) · Company Groups — Admin Guide

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
    "window": 8,             // optional — only look at each company's 8 most recent known quarters
    "minCount": 8            // optional — how many of those 8 must satisfy `status` (defaults to `window`)
  },

  // Same shape as transcript, but for PPTs
  "ppt": { "status": "pending" },

  // Annual report still uses the older lastN shape (see callout below) —
  // window/minCount aren't wired up for this one yet
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

**`window` / `minCount` / `maxCount`** (on `transcript` / `ppt` only —
`annualReport` still uses the older `lastN` shape below, pending its own
rework):

- `window` — instead of checking "ever, across all history", look only at
  each company's own **N most recent known reporting quarters** — whether or
  not the document actually exists for each one. A quarter with no
  transcript still counts as one of the N slots. Omit for all-time.
- `minCount` — how many of those `window` quarters must satisfy `status`, at
  minimum. Defaults to `window` itself (i.e. *every one of them* — "N
  consecutive quarters"), or to `1` if `window` is omitted (i.e. "at least
  once, ever").
- `maxCount` — the counterpart ceiling: **at most** this many of those
  `window` quarters may satisfy `status`. Optional, no cap if omitted.
  Combined with `minCount` this turns the check into a real *range* — e.g.
  "between 12 and 16 of the last 16" (some gaps tolerated, not zero, but not
  too many either). Flip it around with `minCount: 0` to hunt for *sparse*
  coverage instead of good coverage — "at most 2 of the last 8" surfaces a
  signal backlog, which `minCount` alone can't express (there was no way to
  say "zero is fine, but I want to see the count anyway" before this).

This one shape covers every variation the admin might want:

| Intent | Config |
|---|---|
| 8 consecutive quarters with a transcript present | `{ "status": "present", "window": 8 }` |
| 8 consecutive quarters with a signal already extracted | `{ "status": "extracted", "window": 8 }` |
| At least 4 of the latest 8 quarters extracted (gaps OK) | `{ "status": "extracted", "window": 8, "minCount": 4 }` |
| At least 4 quarters ever extracted, no recency bound | `{ "status": "extracted", "minCount": 4 }` |
| Between 12 and 16 of the last 16 extracted (some gaps OK, not too many) | `{ "status": "extracted", "window": 16, "minCount": 12, "maxCount": 16 }` |
| At most 2 of the last 8 extracted (sparse coverage / backlog finder) | `{ "status": "extracted", "window": 8, "minCount": 0, "maxCount": 2 }` |

The important distinction from the old (now removed) `lastN` field: `window`
is built from *every* known reporting quarter for the company, not just the
quarters where the document happens to already exist. That's what makes
"consecutive" mean something — if `lastN` had simply taken the last N
quarters *that already had a transcript*, a company with gaps in its history
would never show those gaps; it'd always look "fully covered." `window`
counts the gap as a quarter that fails `status`, so a genuine "8 in a row"
requirement (`minCount` defaulting to `window`) can actually fail when there's
a real gap.

**`rules`** (`transcript`/`ppt` only, optional) — for compound conditions the
single window/minCount/maxCount clause can't express. It's an array of
`{ window?, minCount?, maxCount? }` clauses, **ANDed together**.
`{ window, minCount, maxCount }` at the top level is just shorthand for a
single-clause `rules` array — every existing config keeps working unchanged.

| Intent | Config |
|---|---|
| At least 4 of the last 8 quarters, **and** at least 6 ever (i.e. at least 2 more outside that recent window) | `{ "status": "extracted", "rules": [{ "window": 8, "minCount": 4 }, { "minCount": 6 }] }` |

No separate "outside the window" concept was needed — the second rule (no
`window` = all history, a superset of the first rule's window) can only be
satisfied by periods beyond the first rule's 8 once the first rule already
caps at 4 within them. Any number of clauses can be chained the same way.

> Previously-known gap, now fixed: `status: "pending"`/`"extracted"` used to
> time out on large all-time or annual-report checks. That was a real query
> bottleneck (missing index + an inefficient existence check), fixed at the
> DB/query level — all three statuses are now fast (a few seconds) across
> `transcript`, `ppt`, and `annualReport`, with or without `window`/`lastN`.
> Safe to offer `pending`/`extracted` everywhere, including on the Annual
> report card.

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

> [!NOTE]
> There is currently no "dry-run resolve an arbitrary filter_config
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
  *"Already extracted"*. Default to "Present" pre-selected.
- **Transcript/PPT cards specifically** (`window`/`minCount`/`maxCount`):
  render as three optional number fields —
  *"Only look at the N most recent quarters"* (`window`, placeholder "All
  history"), *"...of which at least this many must match"* (`minCount`,
  placeholder/default "All of them"), and *"...but no more than this many"*
  (`maxCount`, placeholder "No limit"). If `window` is filled in and
  `minCount`/`maxCount` are both left blank, that reads as "N consecutive
  quarters" (the strictest reading — zero gaps allowed). **This strict
  default is easy to reach by accident** — filling in only `window` implies
  `minCount = window`, i.e. "every single one, no gaps," which is a much
  smaller/stricter set than admins tend to expect from "look at the last N
  quarters." Put a live-updating hint or the `/resolve` count right next to
  these fields so the admin sees the actual match count before saving, not
  after. Hint text: *"Leave minCount/maxCount blank to require all N
  (consecutive). Lower minCount to allow gaps, e.g. 16 and 12 means 'at least
  12 of the last 16 quarters.' Add a maxCount to cap it too — e.g. 12 and 16
  means 'between 12 and 16' — or set minCount to 0 with a low maxCount to
  find sparse/backlog coverage instead of good coverage."*
- **Annual report card**: still the older single *"Only look at the N most
  recent years"* field (`lastN`) for now — it hasn't been reworked to the
  `window`/`minCount`/`maxCount` model yet.
- **Multiple rules on Transcript/PPT** — an "Add another rule" link under the
  window/minCount/maxCount fields that adds another `{window, minCount,
  maxCount}` row, ANDed with the rows above it (e.g. "at least 4 of the last
  8 quarters" + "at least 6 ever"). Compound rules can already be set via
  direct API/`PUT` calls if an admin needs one before this ships — worth
  prioritizing over other v2 work now that we've hit a real case (an admin
  wanted "16 transcript, 16 ppt, 1 year annual" and got a much smaller group
  than expected, because the single-field UI could only express the
  strict-consecutive reading, not "most of the last 16").
- Since filters chain as AND only, don't offer an any/all toggle anymore —
  if an admin wants "transcript OR ppt", that's two separate groups.
- On the L1 dispatch screen's group dropdown: show the live count next to
  each group name (e.g. "Large Cap Banks (42)") so the admin isn't surprised
  by scope before hitting Preview.
