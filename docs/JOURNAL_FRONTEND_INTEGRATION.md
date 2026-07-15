# Investment Journal — Frontend Integration Guide

This document describes the **unified Journal** feature and how the frontend should
migrate onto it. The backend is fully implemented; this guide covers the API contract,
the new data model, and the exact old→new endpoint mapping so the FE team can delete
the old flows.

> **What changed, in one line:** the old **Watchlist**, **Holding Notes**, and the old
> single-thesis **Journal** are gone. They are replaced by **one** concept — a *journal*
> — reached entirely under `/api/journal`.

---

## The model

A **journal** is a named container that tracks stock tickers — like a watchlist. Each
ticker inside a journal can carry **multiple timestamped entries**. An entry is either:

- a **plain note** (`noteText`), or
- a **full thesis** (`dimension` + `subFactors` + `thesis` + `conviction`), which the
  backend evaluates for "thesis health" (intact / partial / broken) and may attach an
  AI nudge to.

Every user automatically gets **two default journals**:

| Journal | `kind` | How it's filled | Deletable / Renamable |
|---------|--------|------------------|-----------------------|
| **Holdings** | `holdings` | Auto-populated (add-only) from the user's real holdings: smallcase holdings + smallcase basket constituents + uploaded portfolio + shadow portfolio | ❌ No |
| **Tracking** | `tracking` | User-managed (add tickers you want to watch) | ❌ No |

Users can also create **custom** journals (`kind: 'custom'`), which behave like Tracking.
A ticker may live in **multiple** journals at once.

Key behaviours to know on the FE:

- **Defaults are created lazily.** The first `GET /journals` call for a user creates the
  two defaults if they don't exist — you never create them yourself, and you'll always
  get at least these two back.
- **Holdings journal is add-only.** New holdings get added on every sync; a stock the
  user has exited is **never auto-removed** (it may show as stale). If the user manually
  removes a still-held ticker from Holdings, it will **reappear** on the next sync.
- **Tickers are uppercase.** Send any case; the backend normalises to uppercase. The
  `:ticker` in a URL path is matched case-insensitively for the same reason.

---

## Auth & conventions

| Item | Value |
|------|-------|
| Base path | `/api/journal` |
| Auth | **Every** endpoint requires the QuantCase user JWT as `Authorization: Bearer <token>`. The user is taken from the token — **never** pass `user_id` in the query/body anymore. |
| Success shape | `{ "success": true, "data": ... }` (HTTP `201` on creates, `200` otherwise) |
| Error shape | `{ "success": false, "error": "<message>" }` — HTTP `400` (validation / bad request), `404` (not found **or not yours** — ownership failures return 404, not 403) |
| Request bodies | JSON, **camelCase** keys |

---

## Endpoints

### Journals

#### `GET /api/journal/journals`
List the user's journals (ensures the two defaults exist first).

```json
{
  "success": true,
  "data": {
    "journals": [
      { "id": "uuid", "name": "Holdings", "kind": "holdings", "isDefault": true,  "tickerCount": 4, "createdAt": "…", "updatedAt": "…" },
      { "id": "uuid", "name": "Tracking", "kind": "tracking", "isDefault": true,  "tickerCount": 0, "createdAt": "…", "updatedAt": "…" },
      { "id": "uuid", "name": "My Picks", "kind": "custom",   "isDefault": false, "tickerCount": 2, "createdAt": "…", "updatedAt": "…" }
    ]
  }
}
```
Defaults are returned first, then custom journals oldest-first.

#### `POST /api/journal/journals`
Create a custom journal.
```json
// request
{ "name": "My Picks" }
```
Returns the created journal (`kind: "custom"`, `isDefault: false`, `tickerCount: 0`). `name` is 1–80 chars.

#### `PATCH /api/journal/journals/:journalId`
Rename a **custom** journal. Renaming a default returns `400`.
```json
{ "name": "New name" }
```

#### `DELETE /api/journal/journals/:journalId`
Delete a **custom** journal (cascades all its tickers + entries). Deleting a default returns `400`.
```json
{ "success": true, "data": { "deleted": true } }
```

#### `GET /api/journal/journals/:journalId`
Journal detail — tickers with live market data, latest entry, and latest thesis health.
> For the **Holdings** journal, this call runs a holdings sync first, so it's always current.

```json
{
  "success": true,
  "data": {
    "journal": { "id": "uuid", "name": "Holdings", "kind": "holdings", "isDefault": true, "tickerCount": 2, "createdAt": "…", "updatedAt": "…" },
    "tickers": [
      {
        "ticker": "TCS",
        "source": "holdings_sync",          // "manual" | "holdings_sync"
        "addedAt": "…",
        "entryCount": 1,
        "market": {
          "ltp": 2181.5,
          "change": -12.3,
          "changePercent": -0.56,
          "qcScore": 74,
          "conviction": "POSITIVE",          // POSITIVE | NEUTRAL | WATCH | null
          "thesisTags": ["MANAGEMENT", "DEAL"]
        },
        "latestEntry": { /* entry object, see below — or null */ },
        "latestThesisHealth": "intact"        // intact|partial|broken|none|null (null = no thesis entries)
      }
    ]
  }
}
```

### Tickers within a journal

#### `POST /api/journal/journals/:journalId/tickers`
Add one or more tickers (idempotent — existing tickers are left untouched).
```json
// request
{ "tickers": ["INFY", "tcs"] }
// response
{ "success": true, "data": { "added": 1, "tickers": ["INFY", "TCS"] } }
```

#### `DELETE /api/journal/journals/:journalId/tickers/:ticker`
Remove a ticker from a journal (cascade-deletes its entries).
```json
{ "success": true, "data": { "deleted": true } }
```
> Reminder: removing a still-held ticker from the **Holdings** journal is temporary — it
> comes back on the next holdings sync.

### Entries (notes & theses)

The **entry object** returned everywhere:
```json
{
  "id": "uuid",
  "type": "note",              // "note" | "thesis"
  "noteText": "Watching Q2 margins",
  "dimension": null,           // "M" | "O" | "D"  (null for notes)
  "subFactors": null,          // string[]         (null for notes)
  "thesis": null,
  "conviction": null,          // 1..5             (null for notes)
  "thesisHealth": null,        // intact|partial|broken|none (null for notes)
  "aiNudge": null,             // AI explanation when partial/broken
  "createdAt": "…",
  "updatedAt": "…"
}
```

#### `GET /api/journal/journals/:journalId/tickers/:ticker/entries`
All entries for a ticker within a journal, **newest first**.
```json
{ "success": true, "data": { "ticker": "INFY", "entries": [ /* entry, entry, … */ ] } }
```

#### `POST /api/journal/journals/:journalId/tickers/:ticker/entries`
Add a note **or** a thesis. If the ticker isn't in the journal yet, it's auto-added
(`source: "manual"`) — so "add a note to a ticker" is a single call.

```json
// A plain note:
{ "noteText": "Added on the dip below 1500" }

// A full thesis (all four fields required together):
{
  "dimension": "M",                                       // M=Management, O=Opportunity, D=Deal
  "subFactors": ["Guidance Accuracy", "Capital Allocation"],
  "thesis": "Strong management track record, consistent guidance",
  "conviction": 4                                         // 1..5
}
```
Valid `subFactors` by dimension:
- **M**: `Guidance Accuracy`, `Capital Allocation`, `Disclosure Honesty`
- **O**: `Industry Tailwind`, `Distribution Strength`, `Competitive Edge`, `TAM Expansion`
- **D**: `Valuation`, `Earnings Growth/Quality`, `P/E Re-rating Potential`, `Risk-Reward`

Response is the created entry (`201`). For a thesis it also carries `thesisHealth` and (if partial/broken) `aiNudge`.

Validation: you must send **either** `noteText` **or** a complete thesis. A thesis with a
missing field (e.g. no `conviction`) is rejected with `400`. An empty body is `400`.

#### `PATCH /api/journal/entries/:entryId`
Edit an entry (any subset of the fields; at least one required). Editing a thesis
re-snapshots lens scores and re-evaluates health.

#### `DELETE /api/journal/entries/:entryId`
```json
{ "success": true, "data": { "deleted": true } }
```

#### `POST /api/journal/entries/:entryId/evaluate`
Manually re-run thesis-health evaluation for a **thesis** entry.
```json
{ "success": true, "data": { "entryId": "uuid", "thesisHealth": "partial", "aiNudge": "…", "evaluatedAt": "…" } }
```

### Holdings sync

#### `POST /api/journal/sync-holdings`
Manually refresh the Holdings journal from all holdings sources (add-only).
```json
{ "success": true, "data": { "journalId": "uuid", "added": 2, "total": 7 } }
```
> This normally happens automatically after a smallcase sync and whenever the Holdings
> journal is opened. Call this if you want an explicit "refresh holdings" button.

---

## Migration: old → new

Delete all of these old calls. The right-hand column is the replacement.

| ❌ Old | ✅ New |
|--------|--------|
| `GET /api/watchlists?user_id=` | `GET /api/journal/journals` (user comes from the JWT) |
| `GET /api/watchlists/:id` | `GET /api/journal/journals/:journalId` |
| `POST /api/watchlists { name }` | `POST /api/journal/journals { name }` |
| `POST /api/watchlists/add-symbols { symbols, watchlist_id }` | `POST /api/journal/journals/:journalId/tickers { tickers }` (create the journal first if needed) |
| `PATCH /api/watchlists/:id { name }` | `PATCH /api/journal/journals/:journalId { name }` |
| `DELETE /api/watchlists/:id` | `DELETE /api/journal/journals/:journalId` |
| `DELETE /api/watchlists/:id/symbols/:symbol` | `DELETE /api/journal/journals/:journalId/tickers/:ticker` |
| `POST /api/portfolio/holdings/:holdingId/notes { note_text }` | `POST /api/journal/journals/:journalId/tickers/:ticker/entries { noteText }` (use the Holdings journal id) |
| `PATCH /api/portfolio/notes/:noteId { note_text }` | `PATCH /api/journal/entries/:entryId { noteText }` |
| `DELETE /api/portfolio/notes/:noteId` | `DELETE /api/journal/entries/:entryId` |
| `GET /api/journal/entries` | `GET /api/journal/journals/:journalId` (the Holdings journal) |
| `GET /api/journal/pending` | Derive on the client from the Holdings journal detail: tickers whose `latestThesisHealth === null` have no thesis yet |
| `POST /api/journal/entries { symbol, portfolioType, dimension, … }` | `POST /api/journal/journals/:journalId/tickers/:ticker/entries` with a thesis body |
| `GET /api/journal/entries/:symbol` | `GET /api/journal/journals/:journalId/tickers/:ticker/entries` |
| `PUT /api/journal/entries/:entryId` | `PATCH /api/journal/entries/:entryId` |
| `DELETE /api/journal/entries/:entryId` | `DELETE /api/journal/entries/:entryId` *(path unchanged)* |
| `POST /api/journal/entries/:entryId/evaluate` | `POST /api/journal/entries/:entryId/evaluate` *(unchanged)* |

### Behavioural changes to be aware of

- **`portfolioType` is gone.** There is no more `user` vs `shadow` distinction on a
  journal entry. A ticker simply lives in whatever journal(s) the user placed it in — the
  Holdings journal represents real holdings; Tracking / custom journals are everything else.
- **`user_id` in query/body is gone everywhere.** Always send the JWT.
- **Request bodies are camelCase** (`noteText`, not `note_text`; `subFactors`, not `sub_factors`).
- **Old response wrappers changed.** Watchlist used to return `{ watchlist: … }`; everything
  now returns `{ success, data }`.
- **Notes are now timestamped entries** with `createdAt`/`updatedAt`, and a ticker can hold
  many of them (the old `WatchlistAsset.notes` was a single string field — that concept is gone).

---

## Typical FE flows

**Render the "Journals" list page**
```js
const { data } = await api.get('/api/journal/journals');   // always includes Holdings + Tracking
```

**Open a journal**
```js
const { data } = await api.get(`/api/journal/journals/${journalId}`);
// data.tickers[] each has .market (ltp/change/qcScore), .latestEntry, .latestThesisHealth
```

**Add a stock to Tracking and drop a note in one go**
```js
await api.post(`/api/journal/journals/${trackingId}/tickers/${ticker}/entries`, {
  noteText: 'Breakout above 200DMA, watching for volume',
});
```

**Write a thesis on a holding**
```js
await api.post(`/api/journal/journals/${holdingsId}/tickers/${ticker}/entries`, {
  dimension: 'M',
  subFactors: ['Guidance Accuracy', 'Capital Allocation'],
  thesis: 'Consistent guidance, disciplined capex',
  conviction: 4,
});
```
