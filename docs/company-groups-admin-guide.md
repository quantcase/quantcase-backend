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

**`filter_type: "dynamic"`** — `filter_config` can combine any of the four
keys below. If more than one is present, a company must match **all** of
them (intersection) to be in the group.

```jsonc
{
  // Companies with these documents present in the DB
  "coverage": {
    "transcript": true,
    "ppt": true,
    "annualReport": false,
    "match": "any"   // "any" = has at least one of the checked doc types; "all" = has all of them
  },

  // Companies with these documents present but NOT yet extracted (L1 backlog).
  // Same shape as `coverage`, one level stricter.
  "pendingExtraction": {
    "transcript": true,
    "match": "any"
  },

  // Market cap range in ₹ crore, using each company's latest known price
  "marketCap": { "min": 5000, "max": null },

  // Sector/industry match (earnings_calls.basic_industry values)
  "industries": ["Banks", "NBFC"]
}
```

Any subset of these four keys is valid — e.g. a group with only `marketCap`
set, or one combining `industries` + `pendingExtraction` ("mid-cap banks
still needing L1 extraction").

`coverage.match` / `pendingExtraction.match`:
- `"any"` — company qualifies if it has **any one** of the checked doc types.
- `"all"` — company must have **every one** of the checked doc types.

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
  filter-based, expose the four dimensions as independent toggles (coverage,
  pending extraction, market cap range, industries) — any combination is
  valid, and none selected means an empty group (worth a warning: *"No
  filters selected — this group will always be empty."*).
- `match: "any" | "all"` toggle on coverage/pendingExtraction: label as
  *"Match any of these"* vs *"Match all of these"*.
- On the L1 dispatch screen's group dropdown: show the live count next to
  each group name (e.g. "Large Cap Banks (42)") so the admin isn't surprised
  by scope before hitting Preview.
