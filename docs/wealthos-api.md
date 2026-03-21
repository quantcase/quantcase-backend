# WealthOS API Reference

Base path: `/api/wealthos`

## Response Format

All endpoints return a consistent envelope:

```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "message" }
{ "success": false, "error": "Validation failed", "details": { ... } }
```

Async AI endpoints return:

```json
{ "success": true, "message": "Job queued", "job": { "id": "uuid", "status": "pending" } }
```

Poll job status via `GET /api/jobs/:jobId`.

---

## Dashboard

### GET /api/wealthos/dashboard/today

Returns today's RM priority list — clients ranked by urgency score. **Synchronous, no LLM.**

**Query params**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| rm_id | string (uuid) | yes | RM to fetch dashboard for |

**Response**

```json
{
  "success": true,
  "data": {
    "date": "2026-03-21",
    "rm_id": "uuid",
    "priority_list": [
      {
        "client": { "id": "uuid", "name": "Rajan Mehta", "segment": "UHNI", "churn_probability": 0.72 },
        "score": 0.74,
        "priority": "HIGH",
        "score_components": {
          "drawdown": 0.3,
          "daysSinceContact": 0.18,
          "churnProbability": 0.72,
          "riskMismatch": 0.4
        },
        "suggested_action": "Discuss portfolio rebalancing given recent drawdown"
      }
    ]
  }
}
```

Clients included: not contacted in 7+ days OR `churn_probability > 0.5`. Top 20 returned, sorted by score descending.

**Priority score formula**

```
score = 0.3 * drawdown
      + 0.2 * min(daysSinceContact, 90) / 90
      + 0.2 * churn_probability
      + 0.3 * abs(portfolio.risk_score - expected) / 10

HIGH   >= 0.60
MEDIUM >= 0.35
LOW     < 0.35
```

---

## Clients

### GET /api/wealthos/clients

List clients with pagination and filtering.

**Query params**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | integer | 1 | Page number |
| size | integer | 20 | Page size (max 100) |
| segment | enum | — | `HNI`, `UHNI`, `Retail`, `Institutional`, `Private` |
| rm_id | string (uuid) | — | Filter by RM |
| search | string | — | Full-text search on name/email |

**Response**

```json
{
  "success": true,
  "data": {
    "items": [ { "id": "uuid", "name": "...", "segment": "HNI", "churn_probability": 0.3, ... } ],
    "total": 142,
    "page": 1,
    "size": 20
  }
}
```

---

### POST /api/wealthos/clients

Create a new client.

**Request body**

```json
{
  "name": "Rajan Mehta",
  "email": "rajan@example.com",
  "phone": "+91-9876543210",
  "rm_id": "uuid",
  "segment": "UHNI",
  "risk_profile": "moderate",
  "engagement_score": 60,
  "churn_probability": 0.3,
  "metadata": {}
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| name | string | yes | — |
| email | string | no | — |
| phone | string | no | — |
| rm_id | uuid | no | Must exist in `wealth_rm_users` |
| segment | enum | yes | `HNI`, `UHNI`, `Retail`, `Institutional`, `Private` |
| risk_profile | enum | yes | `conservative`, `moderate`, `aggressive` |
| engagement_score | number | no | 0–100 |
| churn_probability | number | no | 0–1 |
| metadata | object | no | Arbitrary JSON |

**Response** `201`

```json
{ "success": true, "data": { "id": "uuid", "name": "Rajan Mehta", ... } }
```

---

### GET /api/wealthos/clients/:clientId

Get a single client including portfolio and assigned RM.

**Response**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Rajan Mehta",
    "segment": "UHNI",
    "risk_profile": "moderate",
    "engagement_score": 72,
    "churn_probability": 0.28,
    "last_contact_at": "2026-03-14T09:30:00Z",
    "portfolio": { "total_value": 15000000, "risk_score": 6.2, "holdings": [...] },
    "rm": { "id": "uuid", "name": "Priya Shah" }
  }
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 404 | Client not found |

---

### PUT /api/wealthos/clients/:clientId

Update client fields. Same body shape as POST; all fields optional.

---

### GET /api/wealthos/clients/:clientId/portfolio

Get client's portfolio.

**Response**

```json
{
  "success": true,
  "data": {
    "client_id": "uuid",
    "total_value": 15000000,
    "risk_score": 6.2,
    "last_rebalance_date": "2026-01-15",
    "holdings": [
      { "symbol": "RELIANCE", "weight": 0.12, "qty": 200 }
    ]
  }
}
```

**Errors** — `404` if no portfolio exists.

---

### POST /api/wealthos/clients/:clientId/portfolio

Create or update (upsert) the client's portfolio.

**Request body**

```json
{
  "total_value": 15000000,
  "risk_score": 6.2,
  "last_rebalance_date": "2026-01-15",
  "holdings": [
    { "symbol": "RELIANCE", "weight": 0.12, "qty": 200 },
    { "symbol": "HDFCBANK", "weight": 0.08, "qty": 500 }
  ]
}
```

| Field | Type | Required |
|-------|------|----------|
| total_value | number | yes |
| risk_score | number | yes |
| last_rebalance_date | date string | no |
| holdings | array of `{symbol, weight, qty}` | no |

---

### GET /api/wealthos/clients/:clientId/interactions

List interactions for a client, ordered by timestamp descending.

**Query params**: `page`, `size` (same as clients list)

**Response**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "type": "call",
        "summary": "Discussed equity allocation",
        "sentiment": "positive",
        "timestamp": "2026-03-14T09:30:00Z"
      }
    ],
    "total": 18,
    "page": 1,
    "size": 20
  }
}
```

---

### POST /api/wealthos/clients/:clientId/interactions

Log a new interaction. Also updates `last_contact_at` and increments `engagement_score` (+1, capped at 100).

**Request body**

```json
{
  "rm_id": "uuid",
  "type": "call",
  "summary": "Discussed equity allocation concerns",
  "sentiment": "positive",
  "timestamp": "2026-03-21T10:00:00Z",
  "metadata": {}
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| rm_id | uuid | no | — |
| type | enum | yes | `call`, `email`, `whatsapp`, `meeting`, `sms` |
| summary | string | no | — |
| sentiment | string | no | Free text |
| timestamp | ISO 8601 | yes | — |
| metadata | object | no | — |

---

### GET /api/wealthos/clients/:clientId/suggestions

List AI-generated suggestions for a client.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| status | enum | `pending`, `used`, `ignored` |
| priority | enum | `HIGH`, `MEDIUM`, `LOW` |

**Response**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "priority": "HIGH",
      "reason": "Portfolio drawdown of 18% with no recent contact",
      "suggested_action": "Schedule a portfolio review call",
      "talking_points": ["Discuss drawdown context", "Review risk appetite"],
      "message": "Hi Rajan, wanted to connect about your portfolio performance...",
      "status": "pending",
      "score": 0.74,
      "created_at": "2026-03-21T08:00:00Z"
    }
  ]
}
```

---

### GET /api/wealthos/clients/:clientId/actions

List actions taken for a client, paginated and ordered by `created_at` descending.

**Query params**: `page`, `size`

---

### POST /api/wealthos/clients/:clientId/models/:modelId

Assign an approved investment model to a client.

**Response** `201`

```json
{ "success": true, "data": { "client_id": "uuid", "model_id": "uuid", "assigned_at": "..." } }
```

**Errors**

| Status | Condition |
|--------|-----------|
| 404 | Client or model not found |
| 409 | Model already assigned to this client |

---

### DELETE /api/wealthos/clients/:clientId/models/:modelId

Remove an assigned model from a client.

**Errors** — `404` if mapping does not exist.

---

### POST /api/wealthos/clients/:clientId/message/generate

Enqueue an AI-generated personalized message for the client. **Async.**

**Request body**

```json
{
  "channel": "whatsapp",
  "context": "Client asked about SIP options last week",
  "rm_id": "uuid"
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| channel | enum | yes | `call`, `email`, `whatsapp` |
| context | string | no | Extra context for the LLM |
| rm_id | uuid | no | — |

**Response** `202`

```json
{ "success": true, "message": "Job queued", "job": { "id": "uuid", "status": "pending" } }
```

Generated message is stored as a `WealthAction` with `action_type: "generated_message"`. Poll `GET /api/jobs/:jobId` for completion.

---

## Suggestions

### POST /api/wealthos/suggestions/generate

Enqueue AI suggestion generation for a set of clients or an entire RM's book. **Async.**

**Request body** (one of `client_ids` or `rm_id` required)

```json
{
  "client_ids": ["uuid1", "uuid2"],
  "rm_id": "uuid"
}
```

Clients are scored with the priority formula first. LLM converts the top-scored clients into actionable talking points and message drafts. Batched at 20 clients per job.

**Response** `202`

```json
{
  "success": true,
  "message": "Job queued",
  "jobs": [
    { "id": "uuid", "status": "pending", "client_count": 20 }
  ]
}
```

---

### PUT /api/wealthos/suggestions/:suggestionId/status

Mark a suggestion as used or ignored.

**Request body**

```json
{
  "status": "used",
  "rm_id": "uuid"
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| status | enum | yes | `used`, `ignored` |
| rm_id | uuid | no | Recorded in audit log |

Setting `status: "used"` automatically creates a `WealthAction` record.

---

## Actions

### POST /api/wealthos/actions

Log a manual action taken by an RM.

**Request body**

```json
{
  "client_id": "uuid",
  "rm_id": "uuid",
  "suggestion_id": "uuid",
  "action_type": "called",
  "content": "Discussed SIP ladder strategy",
  "outcome": "Client agreed to increase SIP by 20%"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| client_id | uuid | yes | — |
| rm_id | uuid | no | — |
| suggestion_id | uuid | no | Link to a suggestion if acted upon |
| action_type | string | yes | e.g. `called`, `emailed`, `generated_message` |
| content | string | no | — |
| outcome | string | no | — |

---

## Relationship Managers

### GET /api/wealthos/rm

List all RMs with client counts.

**Response**

```json
{
  "success": true,
  "data": [
    { "id": "uuid", "name": "Priya Shah", "email": "priya@firm.com", "team": "North", "_count": { "clients": 34 } }
  ]
}
```

---

### GET /api/wealthos/rm/:rmId

Get an RM with their client list.

**Response**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Priya Shah",
    "performance_score": 82.5,
    "clients": [
      { "id": "uuid", "name": "Rajan Mehta", "segment": "UHNI", "churn_probability": 0.28 }
    ]
  }
}
```

**Errors** — `404` if RM not found.

---

### POST /api/wealthos/rm

Create a new RM user.

**Request body**

```json
{
  "name": "Priya Shah",
  "email": "priya@firm.com",
  "team": "North",
  "performance_score": 80
}
```

| Field | Type | Required |
|-------|------|----------|
| name | string | yes |
| email | string | no |
| team | string | no |
| performance_score | number | no |

---

## Approved Models

### GET /api/wealthos/models

List all approved investment models.

**Response**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "Conservative Debt Ladder",
      "description": "Low-risk debt portfolio with staggered maturities",
      "model_type": "debt",
      "data": { "target_duration": 3, "max_credit_risk": "AA" }
    }
  ]
}
```

---

### POST /api/wealthos/models

Create a new approved investment model.

**Request body**

```json
{
  "name": "Conservative Debt Ladder",
  "description": "Low-risk debt portfolio",
  "model_type": "debt",
  "data": {}
}
```

| Field | Type | Required | Values |
|-------|------|----------|--------|
| name | string | yes | — |
| description | string | no | — |
| model_type | enum | yes | `equity`, `debt`, `hybrid`, `structured`, `pms`, `aif` |
| data | object | no | Model-specific config |

---

## Analytics

### GET /api/wealthos/analytics/rm/:rmId

Get performance metrics for an RM.

**Response**

```json
{
  "success": true,
  "data": {
    "rm_id": "uuid",
    "total_clients": 34,
    "avg_engagement_score": 67.4,
    "avg_churn_probability": 0.24,
    "interactions_last_30d": 89,
    "suggestion_adoption_rate": 0.61,
    "avg_portfolio_risk_score": 5.8
  }
}
```

**Errors** — `404` if RM not found.

---

### GET /api/wealthos/analytics/clients

Client segmentation analytics across all RMs.

**Response**

```json
{
  "success": true,
  "data": {
    "by_segment": [
      { "segment": "UHNI", "count": 18, "avg_engagement": 74.2, "avg_churn": 0.19 },
      { "segment": "HNI",  "count": 62, "avg_engagement": 58.7, "avg_churn": 0.31 }
    ],
    "by_interaction_type": [
      { "type": "call", "count": 213 },
      { "type": "whatsapp", "count": 178 }
    ]
  }
}
```

---

## Enums Reference

| Enum | Values |
|------|--------|
| Segment | `HNI`, `UHNI`, `Retail`, `Institutional`, `Private` |
| Risk profile | `conservative`, `moderate`, `aggressive` |
| Interaction type | `call`, `email`, `whatsapp`, `meeting`, `sms` |
| Suggestion priority | `HIGH`, `MEDIUM`, `LOW` |
| Suggestion status | `pending`, `used`, `ignored` |
| Model type | `equity`, `debt`, `hybrid`, `structured`, `pms`, `aif` |
| Message channel | `call`, `email`, `whatsapp` |

---

## AI / Async Endpoints

Two endpoints trigger LLM jobs and return immediately:

| Endpoint | Queue | Worker |
|----------|-------|--------|
| `POST /suggestions/generate` | `wealthos_suggestion` | `workers/wealthos.suggestion.js` |
| `POST /clients/:id/message/generate` | `wealthos_message` | `workers/wealthos.message.js` |

Both workers run compliance validation (forbidden phrases: `guaranteed returns`, `sure profit`, `insider`, `confidential tip`, `risk-free`) before writing to the database. LLM output that violates guardrails causes the job to fail.

Poll status: `GET /api/jobs/:jobId` → `{ status: "pending" | "processing" | "completed" | "failed", result: ... }`
