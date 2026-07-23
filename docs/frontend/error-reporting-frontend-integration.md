[Docs](../README.md) · [Frontend](../README.md#existing-reference-material) · Error Reporting — Frontend Integration

# Error Reporting — Frontend Integration

This is the complete reference for wiring the "Report Error" button into the frontend.
The backend is already live. **Your job on the frontend is:** show a "Report Error"
button somewhere persistent (e.g. app shell / nav), open a small form when clicked,
collect the user's description + category, attach client-side context automatically,
and POST it to the backend.

---

## 1. Prerequisites

- **Base URL** of the backend API, e.g. `process.env.NEXT_PUBLIC_API_BASE_URL` →
  `https://api.quantcase.in` (locally `http://localhost:8000`).
- The logged-in user's **JWT access token**. The submit endpoint requires
  `Authorization: Bearer <token>` — there is currently no logged-out error reporting
  path, so the button should only be shown (or should prompt sign-in first) for
  authenticated users.

---

## 2. Backend endpoints you'll call

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/error-reports` | Bearer | Submit a new error report from the "Report Error" form. |

Admin triage endpoints (`GET/PATCH /admin/error-reports*`) also exist for the internal
admin panel — see [§5](#5-admin-triage-endpoints-internal) if you're building that view too.

All success responses are `{ success: true, data: ... }`. Errors are
`{ success: false, error: "..." }`, with `details` included for validation failures
(`400`), with an appropriate HTTP status.

---

## 3. `POST /api/error-reports`

Creates one error report row. The backend automatically attaches the reporting
user's id and email from the JWT — **do not** send those yourself.

### Request

```
POST /api/error-reports
Authorization: Bearer <access_token>
Content-Type: application/json
```

```ts
type CreateErrorReportRequest = {
  message: string;              // required, 1-5000 chars — the user's own description
  category?: ErrorReportCategory; // optional, defaults to "other"
  pageUrl?: string;              // current URL when the error occurred, max 2048 chars
  errorMessage?: string;         // captured exception message/stack if you have one, max 10000 chars
  userAgent?: string;            // navigator.userAgent, max 1000 chars
  metadata?: Record<string, unknown>; // any extra free-form client context
};

type ErrorReportCategory =
  | 'bug'
  | 'data_issue'
  | 'performance'
  | 'ui_ux'
  | 'login_auth'
  | 'payment_billing'
  | 'other';
```

`metadata` is a free-form JSON bag — put whatever's useful for debugging here:
viewport size, app version/build hash, feature flags, redux/query cache slice, the
specific ticker/page state the user was on, etc. Keep it small (it's stored as-is,
no size cap is enforced server-side beyond normal request size limits, but don't
dump entire Redux stores).

### Response — `201 Created`

```ts
type ErrorReportResponse = {
  success: true;
  data: {
    id: string;
    category: ErrorReportCategory;
    message: string;
    page_url: string | null;
    error_message: string | null;
    user_id: string;         // taken from the JWT `sub` claim
    user_email: string | null;
    user_agent: string | null;
    metadata: Record<string, unknown> | null;
    status: 'open';           // always "open" on creation
    admin_notes: null;
    created_at: string;       // ISO timestamp
    updated_at: string;       // ISO timestamp
  };
};
```

### Errors

| Status | When | Body |
|--------|------|------|
| `401` | Missing/invalid/expired Bearer token | `{ "error": "No token provided" }` or `{ "error": "Invalid or expired token" }` |
| `400` | `message` missing, or any field fails validation | `{ "success": false, "error": "Validation failed", "details": { "fieldErrors": { "message": [...] } } }` |

### curl example

```bash
curl -X POST https://api.quantcase.in/api/error-reports \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "category": "bug",
    "message": "Portfolio chart is blank after switching tabs",
    "pageUrl": "https://app.quantcase.ai/portfolio?tab=holdings",
    "errorMessage": "TypeError: Cannot read properties of undefined (reading '\''map'\'')",
    "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "metadata": {
      "viewport": "1440x900",
      "appVersion": "2026.07.10-1",
      "activeTab": "holdings",
      "ticker": "RELIANCE"
    }
  }'
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "8310df20-7172-43ac-9a8b-0c0374261425",
    "category": "bug",
    "message": "Portfolio chart is blank after switching tabs",
    "page_url": "https://app.quantcase.ai/portfolio?tab=holdings",
    "error_message": "TypeError: Cannot read properties of undefined (reading 'map')",
    "user_id": "4c0bcf22-e0e1-4e33-b965-a2bedfaece1e",
    "user_email": "hello@quantcase.ai",
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "metadata": { "viewport": "1440x900", "appVersion": "2026.07.10-1", "activeTab": "holdings", "ticker": "RELIANCE" },
    "status": "open",
    "admin_notes": null,
    "created_at": "2026-07-14T15:39:38.558Z",
    "updated_at": "2026-07-14T15:39:38.558Z"
  }
}
```

---

## 4. Suggested frontend flow

1. Render a persistent "Report Error" button (e.g. in the app header or a floating
   action button) that opens a modal/form.
2. Form fields to collect from the user:
   - **Category** — dropdown of the 7 `ErrorReportCategory` values (show friendly
     labels, e.g. "Data looks wrong" → `data_issue`, "Something's broken" → `bug`).
   - **Message** — free-text description, required.
3. On submit, auto-attach (no user input needed):
   - `pageUrl`: `window.location.href`
   - `userAgent`: `navigator.userAgent`
   - `errorMessage`: if the button was launched from a caught exception/error
     boundary, pass `error.message` (+ `error.stack` inside `metadata` if useful);
     otherwise omit it — it's optional for user-initiated reports ("something looks
     off") vs. crash-triggered reports.
   - `metadata`: viewport, app build/version, current route/tab, relevant IDs
     (ticker, call id, etc.) — whatever helps reproduce.
4. POST to `/api/error-reports` with the user's existing access token.
5. On `201`, show a confirmation ("Thanks, we've logged this"). On `401`, prompt
   re-authentication. On `400`, surface the validation message (should be rare if
   the form enforces `message` being non-empty client-side too).

### Error boundary hook-in

If you want crashes to pre-fill the form (recommended), wire your top-level React
error boundary / `window.onerror` handler to open the same "Report Error" modal with
`category` pre-set to `"bug"` and `errorMessage`/`metadata.stack` pre-filled from the
caught error, letting the user just add context and hit submit.

---

## 5. Admin triage endpoints (internal)

These back an internal admin view for triaging reports. **Not currently
auth-gated beyond the rest of `/admin/*`** — do not expose them in the
consumer-facing app.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/error-reports?page=1&size=20&status=open&category=bug` | Paginated list, newest first. `status`/`category` filters optional. |
| `GET` | `/admin/error-reports/:id` | Full detail for one report (includes reporter's `id`/`email`/`display_name`). |
| `PATCH` | `/admin/error-reports/:id` | Update triage state: `{ "status"?: ErrorReportStatus, "adminNotes"?: string }`. |

```ts
type ErrorReportStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix';
```

`GET` list response:

```ts
type ListErrorReportsResponse = {
  success: true;
  data: Array<ErrorReportResponse['data'] & {
    user: { id: string; email: string | null; display_name: string | null } | null;
  }>;
  pagination: { page: number; size: number; total: number; totalPages: number };
};
```

---

## 6. Data model reference

Backed by `ErrorReport` in `prisma/schema.prisma` (table `qc_error_reports`).
`user_id` is nullable at the DB level (for future logged-out support) but the
current API always populates it from the authenticated request.

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid | |
| `category` | enum | `bug`, `data_issue`, `performance`, `ui_ux`, `login_auth`, `payment_billing`, `other` |
| `message` | string | required, user-authored |
| `page_url` | string? | |
| `error_message` | string? | client-captured exception message/stack |
| `user_id` | uuid? | FK → `qc_users.id`, `SET NULL` on user deletion |
| `user_email` | string? | captured verbatim at submit time (survives even if the account is later deleted) |
| `user_agent` | string? | |
| `metadata` | json? | free-form |
| `status` | enum | `open` (default), `in_progress`, `resolved`, `wont_fix` |
| `admin_notes` | string? | internal only |
| `created_at` / `updated_at` | datetime | |
