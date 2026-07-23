[Docs](../README.md) · [Frontend](../README.md#existing-reference-material) · Technicals Management API — Frontend Note

# Technicals Management API — Frontend Note

Everything the admin dashboard needs to (a) view & edit the **technicals analysis skill**
(the prompt + output schema that drives the LLM) and (b) **bulk-run** technicals analysis
for a list of tickers.

> **Base URL**: whatever your API origin is, e.g. `https://api.quantcase.ai` (dev: `http://localhost:8000`).
> Replace `$BASE` and `$ADMIN_JWT` in the curls below.

---

## 0. Auth — all management endpoints are admin-gated

Every endpoint under `/admin/*` requires a **Bearer JWT whose `accountType` is `admin`**.

```
Authorization: Bearer <access_token>
```

| Situation | Response |
|---|---|
| No / malformed token | `401 { "error": "No token provided" }` / `401 { "error": "Invalid or expired token" }` |
| Valid token, non-admin (`investor` / `manager`) | `403 { "error": "Admin access required" }` |
| Validation error (bad body) | `400 { "success": false, "error": "Validation failed", "details": [...] }` |
| Not found | `404 { "success": false, "error": "..." }` |

Success responses are always wrapped as `{ "success": true, ... }`.

The **per-symbol read** endpoints in §3 are the existing **public** screener endpoints (no admin token needed) — that's where the generated insight is ultimately displayed.

---

## 1. View & edit the technicals analysis skill (prompt + schema)

The technicals LLM behaviour is stored as a single **`Skill`** DB row:

- **Identified by** `slug = "technical-intelligence"`.
- **The prompt** lives in **`promptTemplate`** — a string containing a `{{DATA_BLOCK}}` placeholder. The server injects the computed technical-analysis data block into that placeholder at runtime; keep the placeholder intact.
- **The schema** lives in **`outputSchema`** — the full structured-output `response_format` object (see shape below).

### Skill object shape

```jsonc
{
  "id": "0f3c…-uuid",
  "name": "Technical Intelligence",
  "slug": "technical-intelligence",
  "description": "…",
  "promptKey": "decisionIntelligencePrompt",   // maps to a code-side prompt builder — DO NOT change
  "model": "anthropic/claude-haiku-4.5",
  "maxTokens": 20000,
  "outputSchema": {                             // == the LLM response_format
    "type": "json_schema",
    "json_schema": {
      "name": "technical_intelligence",
      "strict": false,
      "schema": { "type": "object", "required": [...], "properties": { ... } }
    }
  },
  "promptTemplate": "…big prompt string with {{DATA_BLOCK}}…",
  "defaultInstructions": null,
  "isActive": true,
  "createdAt": "2026-…",
  "updatedAt": "2026-…",
  "pluginSkills": [ { "plugin": { "id": "...", "name": "...", "category": "technicals" } } ]
}
```

### 1a. List all skills → `GET /admin/skills`

Use this to find the technicals skill's `id` (needed for read/update by id).

```bash
curl -s "$BASE/admin/skills" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

Response `200`:
```jsonc
{ "success": true, "data": [ { /* Skill */ }, { /* Skill */ } ] }
```
Frontend: `const skill = data.find(s => s.slug === 'technical-intelligence'); const id = skill.id;`

### 1b. Read one skill → `GET /admin/skills/:id`

```bash
curl -s "$BASE/admin/skills/$SKILL_ID" \
  -H "Authorization: Bearer $ADMIN_JWT"
```
Response `200`: `{ "success": true, "data": { /* Skill */ } }` (404 if the id doesn't exist).

### 1c. Update prompt / schema → `PUT /admin/skills/:id`

Body is a **partial** — send only the fields you're changing. To edit the prompt and/or schema:

```bash
curl -s -X PUT "$BASE/admin/skills/$SKILL_ID" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "promptTemplate": "You are a technical analyst… \n\n{{DATA_BLOCK}}\n\n Return JSON…",
    "outputSchema": {
      "type": "json_schema",
      "json_schema": {
        "name": "technical_intelligence",
        "strict": false,
        "schema": {
          "type": "object",
          "required": ["decisionIntelligence", "scores", "stockClassification"],
          "properties": { "decisionIntelligence": { "type": "object", "...": "..." } }
        }
      }
    },
    "maxTokens": 20000,
    "model": "anthropic/claude-haiku-4.5"
  }'
```

Response `200`: `{ "success": true, "data": { /* updated Skill */ } }`.

**Editable fields** (all optional in the body): `name`, `description`, `model`, `maxTokens`,
`outputSchema`, `promptTemplate`, `defaultInstructions`, `isActive`, `slug`.

**Rules & gotchas the editor UI should enforce / surface:**

- **Keep `promptKey` = `"decisionIntelligencePrompt"`.** It maps to a code-side prompt builder; an unregistered value is rejected `400 "promptKey … is not registered"`. Easiest is to just never send `promptKey` in the update.
- **Keep the `{{DATA_BLOCK}}` placeholder** in `promptTemplate` — that's where live TA data is injected.
- **Keep the `outputSchema` wrapper** `{ type: "json_schema", json_schema: { name, strict, schema } }`. The LLM `schema` is at `outputSchema.json_schema.schema`.
- **≤ 24 optional properties** across the whole `schema` (provider grammar limit). Exceeding it makes the *next analysis run* fail with a provider `400`, not the update call. Keep the schema flat and move value constraints into the prompt text.
- **Propagation delay:** workers cache the skill config **~60s** in-process, so a saved change takes up to a minute to take effect on new analyses.
- Setting `"isActive": false` will make analysis runs throw `Skill "technical-intelligence" is inactive` — don't disable it unless intentionally pausing technicals.

---

## 2. Bulk-run technicals analysis for many tickers  **(new)**

Enqueues the `technical-intelligence` LLM regeneration for each ticker (the same job the
per-symbol endpoint fires, just batched). Jobs run async on the worker; poll for completion.

### 2a. Trigger → `POST /admin/technicals/bulk-analyze`

```bash
curl -s -X POST "$BASE/admin/technicals/bulk-analyze" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "tickers": ["HDFCBANK", "TCS", "reliance"], "force": false }'
```

**Request body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `tickers` | `string[]` | ✅ | 1–500 items. Uppercased, trimmed & de-duped server-side (`"reliance"` → `RELIANCE`). |
| `force` | `boolean` | ❌ (default `false`) | `false` = **skip** tickers that already have a stored insight. `true` = **regenerate all**. |

**Response `202`**
```jsonc
{
  "success": true,
  "requested": 3,
  "counts": { "queued": 2, "exists": 1 },
  "results": [
    { "ticker": "HDFCBANK", "jobId": "technicals-HDFCBANK", "status": "exists" },
    { "ticker": "TCS",      "jobId": "technicals-TCS",      "status": "queued" },
    { "ticker": "RELIANCE", "jobId": "technicals-RELIANCE", "status": "queued" }
  ]
}
```

Per-ticker `status`:

| status | meaning |
|---|---|
| `queued` | job accepted, waiting for a worker |
| `processing` | a job was already running for this ticker (idempotent — not double-enqueued) |
| `exists` | skipped: a stored insight already exists (only when `force=false`) |
| `failed` | a prior job for this ticker is in a failed terminal state (only when `force=false`; use `force=true` to retry) |
| `error` | could not enqueue (message in `error`) |

Idempotency: re-submitting the same batch while jobs are in flight will **not** create duplicates (deterministic `jobId = technicals-<TICKER>`).

### 2b. Poll batch progress → `POST /admin/technicals/bulk-status`

Read-only, cheap — never enqueues. Poll every ~5–10s until nothing is `queued`/`processing`.

```bash
curl -s -X POST "$BASE/admin/technicals/bulk-status" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "tickers": ["HDFCBANK", "TCS", "RELIANCE"] }'
```

**Response `200`**
```jsonc
{
  "success": true,
  "requested": 3,
  "counts": { "ready": 1, "processing": 1, "queued": 1 },
  "results": [
    { "ticker": "HDFCBANK", "status": "ready",      "updatedAt": "2026-07-23T09:12:44.000Z" },
    { "ticker": "TCS",      "status": "processing", "updatedAt": null },
    { "ticker": "RELIANCE", "status": "queued",     "updatedAt": null }
  ]
}
```

Per-ticker `status`:

| status | meaning | keep polling? |
|---|---|---|
| `queued` | job waiting | yes |
| `processing` | job running now | yes |
| `ready` | a stored insight exists (fetch it via §3); `updatedAt` = last generated | no |
| `failed` | last job failed (reason in `error`) | no |
| `missing` | no insight and no job — never triggered, or job aged out | no |

> Note: an in-flight job takes precedence over an existing `updatedAt` — so during a `force=true`
> regeneration you'll see `processing` even though an older insight is still stored. When it flips
> to `ready`, `updatedAt` will have advanced.

### Recommended bulk flow

1. `POST /admin/technicals/bulk-analyze` with the ticker list (`force:true` to force fresh).
2. Poll `POST /admin/technicals/bulk-status` with the same list every ~5–10s.
3. Stop when `counts` has no `queued`/`processing`.
4. For each `ready` ticker, fetch the full insight via the per-symbol endpoint (§3).

---

## 3. Where the generated insight is read (reference — existing, public)

These are the existing per-symbol screener endpoints (no admin token). The bulk job in §2
just pre-generates what these return.

- `GET /api/screener/:symbol/technicals` — full technicals payload incl. `decisionIntelligence`.
  If no insight exists yet it returns `decisionIntelligence: null` and kicks off a job; add
  `?refresh=1` to force regen.
- `GET /api/screener/:symbol/technicals/status` — cheap single-symbol poll.

The full response contract for these is documented in
[`docs/frontend/FRONTEND_TECHNICALS_API.md`](./FRONTEND_TECHNICALS_API.md).

---

## Endpoint summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/admin/skills` | admin | List skills (find `technical-intelligence`) |
| `GET`  | `/admin/skills/:id` | admin | Read one skill (prompt + schema) |
| `PUT`  | `/admin/skills/:id` | admin | Update prompt (`promptTemplate`) / schema (`outputSchema`) / model / maxTokens |
| `POST` | `/admin/technicals/bulk-analyze` | admin | Enqueue technicals regen for many tickers |
| `POST` | `/admin/technicals/bulk-status` | admin | Batch-poll insight/job state for many tickers |
| `GET`  | `/api/screener/:symbol/technicals` | public | Read the generated insight for one ticker |
| `GET`  | `/api/screener/:symbol/technicals/status` | public | Single-symbol poll |
