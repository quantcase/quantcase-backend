[Docs](../README.md) · [Frontend](../README.md#existing-reference-material) · Smallcase Gateway — Frontend Integration Guide

# Smallcase Gateway — Frontend Integration Guide

This document describes how the QuantCase frontend connects a user's broker account
via **smallcase Gateway** to import holdings and place orders. The backend is fully
implemented; this guide covers the frontend's half of the flow.

> **Secrets are backend-only.** The gateway secret and API secret never leave the
> server. The frontend only ever handles a `transactionId` and the smallcase Gateway
> SDK — never a secret.

---

## Prerequisites

| Item | Value |
|------|-------|
| Gateway name | `quantcase` |
| Whitelisted origin | `https://www.quantcase.ai/` (the SDK only runs on this origin) |
| Auth | Every backend call (except the webhook) needs the QuantCase user JWT as `Authorization: Bearer <token>` |
| Base path | `/api/smallcase` |

Load the smallcase Gateway SDK on the page (per smallcase's frontend docs):

```html
<script src="https://gateway.smallcase.com/scdk/2.0.0/scdk.js"></script>
```

```js
const scGateway = new scDK({
  gateway: 'quantcase',
  smallcaseAuthToken: null, // guest for the first connect; SDK manages it after
  config: { amo: true },
});
```

---

## The connect flow (import holdings)

```
Frontend                        QuantCase Backend                 smallcase
   │                                   │                              │
   │ 1. POST /connect ───────────────▶ │  create HOLDINGS_IMPORT txn ▶│
   │ ◀──────────── { transactionId } ──│ ◀──────────── transactionId ─│
   │                                   │                              │
   │ 2. scGateway.triggerTransaction({ transactionId }) ─────────────▶│  (broker login UI)
   │ ◀──────────────────────────── success ──────────────────────────│
   │                                   │                              │
   │ 3. POST /transactions/:id/confirm▶│  fetch result, store auth,   │
   │                                   │  sync holdings ─────────────▶│
   │ ◀───────── { is_connected:true } ─│                              │
   │                                   │                              │
   │ 4. GET /holdings ───────────────▶ │  return portfolio + holdings │
```

### Step 1 — Create the connect transaction

```js
const res = await fetch('/api/smallcase/connect', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${qcToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}), // defaults to intent: HOLDINGS_IMPORT
});
const { data } = await res.json();
// data = { transactionId, gateway: 'quantcase', expireAt, intent: 'HOLDINGS_IMPORT' }
```

### Step 2 — Run the transaction in the SDK

```js
scGateway.triggerTransaction({ transactionId: data.transactionId })
  .then((sdkResponse) => {
    // sdkResponse.success === true when the user finishes the broker flow
    if (sdkResponse.success) confirm(data.transactionId);
  })
  .catch((err) => {
    // user cancelled or an SDK error occurred
    console.error('smallcase SDK error', err);
  });
```

### Step 3 — Confirm on the backend

The backend fetches the transaction result from smallcase, stores the connected
user's identity, marks the account connected, and syncs holdings in one call.

```js
async function confirm(transactionId) {
  const res = await fetch(`/api/smallcase/transactions/${transactionId}/confirm`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${qcToken}` },
  });
  const { data } = await res.json();
  // data = { is_connected: true, broker, holdings_synced, synced_at }
}
```

If smallcase is still processing, the backend returns `{ status: 'processing' }` (HTTP 200) —
poll `confirm` again after a short delay.

### Step 4 — Show the portfolio

```js
const res = await fetch('/api/smallcase/holdings', {
  headers: { 'Authorization': `Bearer ${qcToken}` },
});
const { data } = await res.json();
// data = { portfolio: {...} | null, holdings: [...] }
```

---

## Placing an order (BUY / SELL / rebalance)

Requires a connected account. Same two-step shape as connect: backend creates the
transaction, SDK runs it.

```js
// 1. Create the order transaction
const res = await fetch('/api/smallcase/orders', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${qcToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'buy', scid: 'SCET_0010', smallcase_name: 'All Weather' }),
});
const { data } = await res.json(); // { transactionId, gateway, expireAt }

// 2. Run it in the SDK
scGateway.triggerTransaction({ transactionId: data.transactionId });
```

Order status is updated asynchronously by smallcase's webhook to the backend; poll
`GET /api/smallcase/orders` to reflect the latest state.

---

## Endpoint reference

All routes are under `/api/smallcase` and require `Authorization: Bearer <qcToken>`
except the webhook (server-to-server).

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `POST` | `/connect` | `{ intent? }` (default `HOLDINGS_IMPORT`) | `{ transactionId, gateway, expireAt, intent }` |
| `POST` | `/transactions/:id/confirm` | — | `{ is_connected, broker, holdings_synced, synced_at }` or `{ status: 'processing' }` |
| `POST` | `/sync` | — | `{ holdings_synced, synced_at }` |
| `GET`  | `/holdings` | — | `{ portfolio, holdings[] }` |
| `GET`  | `/orders?status=&page=&limit=` | — | `{ orders[], total, page, limit }` |
| `POST` | `/orders` | `{ type, scid, smallcase_name?, amount? }` | `{ transactionId, gateway, expireAt }` |
| `POST` | `/webhook` | *(smallcase → backend, checksum-verified)* | `{ success }` |

`type` for orders is one of: `buy`, `sell`, `rebalance`, `sip`.

### Response shapes

**Holding** (`GET /holdings` → `holdings[]`):

```json
{
  "ticker": "TCS",
  "quantity": 10,
  "avg_price": 3200.5,
  "current_price": 3550.0,
  "current_value": 35500.0,
  "invested_value": 32005.0,
  "pnl": 3495.0,
  "pnl_pct": 10.92,
  "exchange": "NSE",
  "isin": "INE467B01029"
}
```

**Portfolio** (`GET /holdings` → `portfolio`):

```json
{
  "total_value": 35500.0,
  "total_invested": 32005.0,
  "total_pnl": 3495.0,
  "total_pnl_pct": 10.92,
  "synced_at": "2026-07-08T09:00:00.000Z"
}
```

**Order** (`GET /orders` → `orders[]`):

```json
{
  "order_id": "TRX_15ac7395e2e34721ae14977bd39f6bd3",
  "status": "pending",
  "type": "buy",
  "amount": null,
  "smallcase_name": "All Weather",
  "placed_at": "2026-07-08T09:00:00.000Z",
  "completed_at": null
}
```

Order `status` is one of: `pending`, `placed`, `completed`, `failed`, `cancelled`.

---

## Errors & status handling

Every response is `{ success: boolean, data?, error? }`.

| HTTP | Meaning | Frontend action |
|------|---------|-----------------|
| `401` | Missing/expired QuantCase JWT | Re-authenticate the user |
| `400` | `Smallcase account not connected`, or invalid order params | Run the connect flow / fix input |
| `404` | Not connected (holdings/orders read) | Show "Connect your broker" CTA |
| `422` | Transaction errored on smallcase | Show smallcase's message; let the user retry |
| `200` + `{ status: 'processing' }` | Transaction still settling | Poll `confirm` again shortly |

smallcase-side errors are surfaced verbatim in the `error` field so you can display
the broker's own message.

---

## Notes

- The SDK **must** run on the whitelisted origin `https://www.quantcase.ai/`. Other
  origins are rejected by smallcase.
- The backend re-syncs holdings automatically when smallcase sends a completion
  webhook, so `GET /holdings` stays fresh without an explicit `/sync`. Call `/sync`
  manually only for a user-triggered refresh.
- Never embed the gateway secret or API secret in frontend code or network calls.
