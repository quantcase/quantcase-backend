[Docs](./README.md) · API Reference

# API Reference

Every HTTP endpoint the Express server exposes, grouped by feature area. The mount map lives in [`../routes/index.js`](../routes/index.js); each feature router is a file under [`../routes/`](../routes). Paths below are absolute (as seen by the client).

<details>
<summary><b>Contents</b></summary>

- [Auth model & conventions](#auth-model--conventions)
- [Health & monitoring](#health--monitoring)
- [Auth & registration](#auth--registration)
- [Calls, transcripts, summaries, jobs](#calls-transcripts-summaries-jobs)
- [Pipeline — query & trigger](#pipeline--query--trigger)
- [HTML skills](#html-skills)
- [HTML incremental skills](#html-incremental-skills)
- [Screener, tickers, baskets, models](#screener-tickers-baskets-models)
- [Portfolio, journal, investor dashboard](#portfolio-journal-investor-dashboard)
- [Mutual funds, private equity, industry intelligence, error reports](#mutual-funds-private-equity-industry-intelligence-error-reports)
- [Billing](#billing)
- [Smallcase](#smallcase)
- [WealthOS](#wealthos)
- [Admin](#admin)

</details>

## Auth model & conventions

Authentication is enforced by a **global gate** ([`../middleware/globalAuth.js`](../middleware/globalAuth.js)), mounted in `server.js` in front of the router: **every request requires a valid Bearer JWT unless its path is on the public allowlist** ([`../middleware/publicRoutes.js`](../middleware/publicRoutes.js)). Three middlewares matter:

- **`authenticate`** ([`../middleware/authenticate.js`](../middleware/authenticate.js)) — verifies a Bearer JWT and attaches `req.user` (`sub`, `email`, `accountType`). The global gate runs this for every non-allowlisted request.
- **`requireAdmin`** ([`../middleware/requireAdmin.js`](../middleware/requireAdmin.js)) — restricts to the admin account. Applied together with `authenticate` to the **entire** `/admin` tree in `routes/index.js` (layered on top of the global gate).
- **Webhooks** (`/api/billing/webhook`, `/api/smallcase/webhook`) are **not** JWT-authenticated — they verify a Razorpay/smallcase **checksum** over the raw request body. `server.js` skips the global `express.json()` parser for these two paths so the raw body survives, and they sit on the public allowlist so the JWT gate lets them through.

**Public allowlist** (reachable without a token — everything else is **JWT**):

- `GET /health`
- `POST /api/auth/register`, `POST /api/auth/google`, `POST /api/auth/signin`
- `GET /api/invites/validate`
- `GET /api/billing/config`, `GET /api/billing/products`
- `POST /api/billing/webhook`, `POST /api/smallcase/webhook` (checksum)
- `/uploads/*` (static; server-to-server PDF fetch) and CORS `OPTIONS` preflight

Legend for the **Auth** column:

| Value | Meaning |
|---|---|
| Public | On the global public allowlist — reachable without a token |
| JWT | Requires a valid Bearer token (enforced globally by the gate) |
| Admin | Requires `authenticate` + `requireAdmin` (whole `/admin` tree) |
| Checksum | Server-to-server webhook, verified by HMAC checksum on the raw body (allowlisted) |

> [!NOTE]
> **Caveats (verified against source):**
> - Only **`GET /health`** is mounted (standalone in `routes/index.js`). `routes/health.routes.js` exists but is **not mounted anywhere** — there is currently **no** `/api/health` route.
> - All `/api/*` data/pipeline routers — `/api/calls`, `/api/transcript`, `/api/summary`, `/api/jobs`, `/api/annual-reports`, `/api/signals`, `/api/lenses`, `/api/analysis`, `/api/post-html-analysis`, `/api/pipeline`, `/api/html-skills`, `/api/html-incremental-skills`, `/api/screener`, `/api/tickers`, `/api/baskets`, `/api/industry-baskets`, `/api/models`, `/api/mutual-funds`, `/api/private-equity`, `/api/industry-intelligence`, `/api/monitoring`, and `/api/wealthos` — are now **JWT-protected via the global gate**. (They were public before the gate was added.)
> - Routers that also call `router.use(authenticate)` internally (`/api/portfolio`, `/api/journal`, `/api/smallcase`, `/api/discover`, `/api/research-library`, `/api/market`) simply run `authenticate` twice, which is idempotent — no behaviour change.
> - `requireActiveSubscription` ([`../middleware/requireActiveSubscription.js`](../middleware/requireActiveSubscription.js)) exists but is **not currently wired into any route**.

---

## Health & monitoring

Base: `/health` (**Public**), `/api/monitoring` (**JWT** via the global gate).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/health` | Health check with a DB connectivity probe | Public |
| GET | `/api/monitoring/overview` | Dashboard overview (counts across the pipeline) | JWT |
| GET | `/api/monitoring/queues` | BullMQ queue stats (all queues) | JWT |
| GET | `/api/monitoring/queues/:name` | Stats for one BullMQ queue | JWT |
| GET | `/api/monitoring/scheduler` | Scheduler run history | JWT |
| GET | `/api/monitoring/pipeline/coverage` | L1/L2/L3 coverage snapshot | JWT |
| GET | `/api/monitoring/pipeline/failures` | Recent `pipeline_job_failures` | JWT |
| GET | `/api/monitoring/signals/stats` | Signal-store statistics | JWT |
| GET | `/api/monitoring/bse/discovered` | Discovered BSE URLs (written by the Server-2 scraper) | JWT |
| GET | `/api/monitoring/bse/discovered/:scripCd` | Discovered URLs for one company | JWT |
| GET | `/api/monitoring/kpis/registry` | Full computed-metric catalogue (formulaRegistry) | JWT |
| GET | `/api/monitoring/kpis/:ticker` | Resolved KPI values for a ticker | JWT |
| GET | `/api/monitoring/kpis/:ticker/:kpiAbbr/timeseries` | One KPI's time series for a ticker | JWT |
| GET | `/api/monitoring/market/:ticker` | Market snapshot (latest OHLCV + valuation) | JWT |
| GET | `/api/monitoring/market/:ticker/ohlcv` | OHLCV series | JWT |
| GET | `/api/monitoring/market/:ticker/pe` | PE series | JWT |

## Auth & registration

Base: `/api/auth`, `/api/invites`, `/admin/invites`. Invite-only registration — see [`./subsystems/auth-invites-google.md`](./subsystems/auth-invites-google.md).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/auth/register` | Register (body must include a valid `invite_token`) | Public |
| POST | `/api/auth/google` | Google Sign-In (`{ id_token }`); invite-gated, auto-creates on first login | Public |
| POST | `/api/auth/signin` | Email/password sign-in | Public |
| GET | `/api/auth/me` | Current user | JWT |
| PATCH | `/api/auth/me/onboarding` | Advance onboarding step | JWT |
| GET | `/api/invites/validate?token=` | Validate an invite token before showing the signup form | Public |
| POST | `/admin/invites` | Bulk-create invites and email each recipient (`{ emails: string[] }`) | Admin |

## Calls, transcripts, summaries, jobs

Base: `/api/calls`, `/api/transcript`, `/api/summary`, `/api/annual-reports`, `/api/jobs`.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/calls?page=&size=` | List earnings calls (paginated) | JWT |
| GET | `/api/calls/:callId` | One earnings call | JWT |
| GET | `/api/calls/:callId/summary` | The call's `SummaryNew` | JWT |
| POST | `/api/calls/:callId/summarize-v2` | Enqueue L1 signal extraction (transcript) | JWT |
| POST | `/api/calls/:callId/summarize-v2-ppt` | Enqueue L1 signal extraction (PPT) | JWT |
| GET | `/api/transcript/stocks` | Stocks that have transcript calls | JWT |
| GET | `/api/transcript/calls?symbol=` | Calls for a symbol | JWT |
| GET | `/api/summary/:callId` | Summary for a call | JWT |
| POST | `/api/annual-reports/:reportId/summarize-v2` | Enqueue L1 extraction for an annual-report PDF | JWT |
| GET | `/api/jobs/:jobId` | Job status (DB record + BullMQ state) | JWT |

## Pipeline — query & trigger

Base: `/api/signals`, `/api/lenses`, `/api/analysis`, `/api/post-html-analysis`, `/api/pipeline`. See [`./pipeline.md`](./pipeline.md).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/signals?ticker=&signalType=&metricFamily=&sourceType=` | L1 signals for a ticker's latest call (reads `extracted_signals`) | JWT |
| GET | `/api/signals/lineage/:lineageId` | All signals sharing a lineage id | JWT |
| GET | `/api/lenses?ticker=&category=` | L2 lens scores by category for a ticker's latest quarter | JWT |
| GET | `/api/lenses/configs?includeInactive=` | List `LensConfig`s | JWT |
| POST | `/api/lenses/configs` | Upsert a `LensConfig` (marks affected scores stale) | JWT |
| GET | `/api/lenses/scores?callId=` | Computed L2 scores for a call | JWT |
| POST | `/api/lenses/compute` | Enqueue lens computation jobs (`{ callId, lenses? }`) | JWT |
| GET | `/api/analysis?callId=&type=` | L3 insights for a call (comma-separated types) | JWT |
| POST | `/api/analysis` | Enqueue L3 analysis (`{ callId, types, forceRefresh? }`) | JWT |
| GET | `/api/analysis/overview?callId=` | L3 overview insight | JWT |
| POST | `/api/analysis/overview` | Enqueue overview generation | JWT |
| GET | `/api/post-html-analysis/configs?includeInactive=` | List post-HTML-analysis configs | JWT |
| GET | `/api/post-html-analysis/configs/:layer_id/:type/preview?ticker=` | Preview the assembled prompt | JWT |
| GET | `/api/post-html-analysis/configs/:layer_id/:type` | Get one config | JWT |
| PUT | `/api/post-html-analysis/configs/:layer_id/:type` | Update a config | JWT |
| DELETE | `/api/post-html-analysis/configs/:layer_id/:type` | Soft-delete a config | JWT |
| GET | `/api/post-html-analysis?ticker=&layer_id=&type=` | Read results | JWT |
| POST | `/api/post-html-analysis` | Enqueue a run (`{ ticker, layer_id, types?, forceRefresh? }`) | JWT |
| GET | `/api/pipeline/coverage` | L1 signal coverage per source type | JWT |
| GET | `/api/pipeline/missing?source=transcript\|ppt\|annual_report` | Unprocessed eligible rows | JWT |

## HTML skills

Base: `/api/html-skills` — all **JWT**. Skill definitions plus preview/run/output reads.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/html-skills` | List skills | JWT |
| POST | `/api/html-skills` | Create a skill | JWT |
| GET | `/api/html-skills/:slug` | Get a skill | JWT |
| PUT | `/api/html-skills/:slug` | Update a skill | JWT |
| DELETE | `/api/html-skills/:slug` | Delete a skill | JWT |
| POST | `/api/html-skills/run-preview` | Run a skill without persisting | JWT |
| GET | `/api/html-skills/signals/count/:ticker` | Available-signal counts for a ticker | JWT |
| GET | `/api/html-skills/:slug/signals/:ticker` | Signals a skill would consume | JWT |
| GET | `/api/html-skills/:slug/prompt/:ticker` | Assembled prompt for a ticker | JWT |
| POST | `/api/html-skills/:slug/run` | Run and persist an `HtmlSkillOutput` | JWT |
| GET | `/api/html-skills/:slug/outputs/:ticker` | Outputs for a ticker | JWT |
| GET | `/api/html-skills/:slug/outputs/:ticker/:fiscal_year/:quarter` | Output for a specific period | JWT |

## HTML incremental skills

Base: `/api/html-incremental-skills` — all **JWT**. Adds per-config bundles and output history. See [`./admin-guides/html-incremental-skills-guide.md`](./admin-guides/html-incremental-skills-guide.md).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/html-incremental-skills` | List skills | JWT |
| POST | `/api/html-incremental-skills` | Create a skill | JWT |
| GET | `/api/html-incremental-skills/:slug` | Get a skill | JWT |
| PUT | `/api/html-incremental-skills/:slug` | Update a skill | JWT |
| DELETE | `/api/html-incremental-skills/:slug` | Delete a skill | JWT |
| GET | `/api/html-incremental-skills/:slug/configs` | List a skill's config bundles | JWT |
| GET | `/api/html-incremental-skills/:slug/configs/:key` | Get one config bundle | JWT |
| POST | `/api/html-incremental-skills/:slug/configs` | Create a config bundle | JWT |
| PUT | `/api/html-incremental-skills/:slug/configs/:key` | Update a config bundle | JWT |
| DELETE | `/api/html-incremental-skills/:slug/configs/:key` | Delete a config bundle | JWT |
| GET | `/api/html-incremental-skills/signals/count/:ticker` | Available-signal counts | JWT |
| GET | `/api/html-incremental-skills/:slug/signals/:ticker` | Signals the skill would consume | JWT |
| GET | `/api/html-incremental-skills/:slug/prompt/:ticker` | Assembled prompt | JWT |
| POST | `/api/html-incremental-skills/:slug/run` | Run and persist an output | JWT |
| GET | `/api/html-incremental-skills/:slug/outputs/:ticker` | Latest outputs for a ticker | JWT |
| GET | `/api/html-incremental-skills/:slug/outputs/:ticker/history` | Full output history | JWT |
| GET | `/api/html-incremental-skills/:slug/outputs/:ticker/:fiscal_year/:quarter` | Output for a specific period | JWT |

## Screener, tickers, baskets, models

Base: `/api/screener`, `/api/tickers`, `/api/baskets`, `/api/industry-baskets`, `/api/models` — all **JWT**. See [`./frontend/FRONTEND_WYCKOFF_API.md`](./frontend/FRONTEND_WYCKOFF_API.md), [`./frontend/FRONTEND_TECHNICALS_API.md`](./frontend/FRONTEND_TECHNICALS_API.md).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/screener/:symbol` | Ticker overview | JWT |
| GET | `/api/screener/:symbol/technicals` | Technical data (Google-Sheet watchlist) | JWT |
| GET | `/api/screener/:symbol/technicals/status` | Poll target for a pending AI technical insight | JWT |
| GET | `/api/screener/:symbol/financials` | P&L / balance sheet / cash flow / TTM / valuation | JWT |
| GET | `/api/screener/:symbol/prices?from=&to=` | Day-wise OHLCV | JWT |
| GET | `/api/screener/:symbol/wyckoff` | Server-side Wyckoff phase analysis | JWT |
| GET | `/api/screener/:symbol/charts` | Chart-ready data (Price, PE, Sales & Margin) | JWT |
| GET | `/api/screener/:symbol/shareholding` | Historical quarterly shareholding breakdown | JWT |
| GET | `/api/screener/:symbol/peers` | Peer comparison table | JWT |
| GET | `/api/tickers?tickers=TCS,INFY` | Batch metrics for a caller-supplied ticker list | JWT |
| POST | `/api/tickers` | Same, for lists too long for a query string | JWT |
| GET | `/api/baskets` | List stock-screen basket definitions | JWT |
| GET | `/api/baskets/:basketId/stocks?page=&size=&sort=&order=` | Run a screen, return matching stocks | JWT |
| GET | `/api/industry-baskets` | List baskets with latest IIT signal | JWT |
| GET | `/api/industry-baskets/:basketId/stocks` | Constituent stocks for an industry basket | JWT |
| GET | `/api/models` | List portfolio models | JWT |
| POST | `/api/models` | Create a portfolio model | JWT |

## Portfolio, journal, investor dashboard

Base: `/api/portfolio`, `/api/journal` (both apply `authenticate` router-wide), plus `/api/discover`, `/api/research-library`, `/api/market` (each `authenticate`d). Journal detail: [`./subsystems/unified-journal.md`](./subsystems/unified-journal.md), [`./frontend/JOURNAL_FRONTEND_INTEGRATION.md`](./frontend/JOURNAL_FRONTEND_INTEGRATION.md).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/portfolio/user` | The user's real portfolio | JWT |
| POST | `/api/portfolio/user/upload` | Upload holdings (CSV/XLSX, `multipart` field `file`) | JWT |
| GET | `/api/portfolio/mod-synopsis` | Management/Opportunity/Deal synopsis across holdings | JWT |
| GET | `/api/portfolio/summary` | Holdings summary | JWT |
| GET | `/api/portfolio/whats-moving` | What's moving in the portfolio | JWT |
| GET | `/api/portfolio/shadow` | Shadow (paper) portfolio | JWT |
| POST | `/api/portfolio/shadow/add` | Add a ticker to the shadow portfolio (`{ ticker }`) | JWT |
| PATCH | `/api/portfolio/holdings/:holdingId` | Update a holding | JWT |
| DELETE | `/api/portfolio/holdings/:holdingId` | Delete a holding | JWT |
| GET | `/api/journal/journals` | List journals | JWT |
| POST | `/api/journal/journals` | Create a journal | JWT |
| GET | `/api/journal/journals/:journalId` | Journal detail (tickers + entries) | JWT |
| PATCH | `/api/journal/journals/:journalId` | Rename a journal | JWT |
| DELETE | `/api/journal/journals/:journalId` | Delete a journal | JWT |
| POST | `/api/journal/journals/:journalId/tickers` | Add tickers (`{ tickers: [] }`) | JWT |
| DELETE | `/api/journal/journals/:journalId/tickers/:ticker` | Remove a ticker | JWT |
| GET | `/api/journal/journals/:journalId/tickers/:ticker/entries` | List entries for a ticker | JWT |
| POST | `/api/journal/journals/:journalId/tickers/:ticker/entries` | Create a note or thesis entry | JWT |
| PATCH | `/api/journal/entries/:entryId` | Update an entry | JWT |
| DELETE | `/api/journal/entries/:entryId` | Delete an entry | JWT |
| POST | `/api/journal/entries/:entryId/evaluate` | AI thesis-health evaluation for an entry | JWT |
| POST | `/api/journal/sync-holdings` | Sync the Holdings journal from all holdings sources | JWT |
| GET | `/api/discover/screens` | Curated screener cards for the dashboard | JWT |
| GET | `/api/research-library/summary` | Research-library summary | JWT |
| GET | `/api/market/indices` | Market indices for the dashboard | JWT |

## Mutual funds, private equity, industry intelligence, error reports

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/mutual-funds?page=&size=&q=&category=&risk=&rating=&amc_slug=&plan_type=&sort=&order=` | List/search schemes | JWT |
| GET | `/api/mutual-funds/filter-options` | Distinct values for filter dropdowns | JWT |
| GET | `/api/mutual-funds/baskets` | List MF basket definitions | JWT |
| GET | `/api/mutual-funds/baskets/:basketId/schemes` | Run the screener for an MF basket | JWT |
| GET | `/api/mutual-funds/:amfi_code` | Scheme detail | JWT |
| POST | `/api/private-equity/drhp-analyser` | Analyse a DRHP (`multipart` field `document`, PDF/txt ≤ 50 MB) | JWT |
| GET | `/api/private-equity/drhp-analyses` | List prior DRHP analyses | JWT |
| GET | `/api/industry-intelligence?industry=&cluster=` | IIT deep-dive + stock-ranking payload | JWT |
| POST | `/api/error-reports` | Submit a "Report Error" form | JWT |

## Billing

Base: `/api/billing`. Razorpay-backed — see [`./subsystems/billing-razorpay.md`](./subsystems/billing-razorpay.md), [`./frontend/razorpay-frontend-integration.md`](./frontend/razorpay-frontend-integration.md).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/billing/config` | Public billing config (Razorpay key id, etc.) | Public |
| GET | `/api/billing/products` | Products + prices | Public |
| GET | `/api/billing/subscription` | The user's subscription | JWT |
| POST | `/api/billing/subscribe` | Create a subscription / Razorpay order | JWT |
| POST | `/api/billing/coupons/validate` | Validate a coupon code | JWT |
| POST | `/api/billing/verify` | Verify a Razorpay payment | JWT |
| POST | `/api/billing/webhook` | Razorpay webhook (raw body, HMAC-verified) | Checksum |

## Smallcase

Base: `/api/smallcase`. Broker connect + orders — see [`./subsystems/smallcase-gateway.md`](./subsystems/smallcase-gateway.md), [`./frontend/smallcase-frontend-integration.md`](./frontend/smallcase-frontend-integration.md).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/smallcase/webhook` | smallcase Gateway webhook (raw body, checksum-verified) | Checksum |
| POST | `/api/smallcase/connect` | Create a HOLDINGS_IMPORT transaction → `transactionId` | JWT |
| POST | `/api/smallcase/transactions/:id/confirm` | Confirm a transaction, store auth id, sync holdings | JWT |
| POST | `/api/smallcase/sync` | Re-sync holdings from the broker | JWT |
| GET | `/api/smallcase/holdings` | Imported holdings | JWT |
| GET | `/api/smallcase/orders` | Order history | JWT |
| POST | `/api/smallcase/orders` | Place a BUY/SELL/rebalance order → `transactionId` | JWT |

## WealthOS

Base: `/api/wealthos` — RM CRM. **JWT** via the global gate (previously mounted without `authenticate`). See [`./subsystems/wealthos.md`](./subsystems/wealthos.md), [`./frontend/wealthos-api.md`](./frontend/wealthos-api.md).

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/wealthos/dashboard/today?rm_id=` | RM's "today" dashboard | JWT |
| GET | `/api/wealthos/clients?page=&size=&segment=&rm_id=&search=` | List clients | JWT |
| POST | `/api/wealthos/clients` | Create a client | JWT |
| GET | `/api/wealthos/clients/:clientId` | Client detail | JWT |
| PUT | `/api/wealthos/clients/:clientId` | Update a client | JWT |
| GET | `/api/wealthos/clients/:clientId/portfolio` | Client portfolio | JWT |
| POST | `/api/wealthos/clients/:clientId/portfolio` | Upsert client portfolio | JWT |
| GET | `/api/wealthos/clients/:clientId/interactions` | List interactions | JWT |
| POST | `/api/wealthos/clients/:clientId/interactions` | Log an interaction | JWT |
| GET | `/api/wealthos/clients/:clientId/suggestions` | Client suggestions | JWT |
| GET | `/api/wealthos/clients/:clientId/actions` | Client actions | JWT |
| POST | `/api/wealthos/clients/:clientId/models/:modelId` | Assign an approved model | JWT |
| DELETE | `/api/wealthos/clients/:clientId/models/:modelId` | Remove a model mapping | JWT |
| POST | `/api/wealthos/clients/:clientId/message/generate` | Generate an outreach message (call/email/whatsapp) | JWT |
| POST | `/api/wealthos/suggestions/generate` | Generate suggestions for client_ids / an rm_id | JWT |
| PUT | `/api/wealthos/suggestions/:suggestionId/status` | Mark a suggestion used/ignored | JWT |
| POST | `/api/wealthos/actions` | Log an action | JWT |
| GET | `/api/wealthos/rm` | List RMs | JWT |
| POST | `/api/wealthos/rm` | Create an RM | JWT |
| GET | `/api/wealthos/rm/:rmId` | RM detail | JWT |
| GET | `/api/wealthos/models` | List approved models | JWT |
| POST | `/api/wealthos/models` | Create an approved model | JWT |
| GET | `/api/wealthos/analytics/rm/:rmId` | RM performance metrics | JWT |
| GET | `/api/wealthos/analytics/clients` | Client segmentation analytics | JWT |

---

## Admin

Base: `/admin` — the **entire** tree is behind `authenticate` + `requireAdmin`. Mount map: [`../routes/admin.routes.js`](../routes/admin.routes.js).

### Indicators & opportunity stats

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/opportunity/stats?callId=` | Opportunity stats for a call |
| GET | `/admin/indicators` | Catalogue of all computed metrics |
| GET | `/admin/indicators/:ticker/:metricId` | Full provenance (formula + inputs + values used) |

### Skills & plugins

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/admin/skills` | List / create a `Skill` |
| GET / PUT / DELETE | `/admin/skills/:id` | Get / update / delete a `Skill` |
| GET / POST | `/admin/plugins` | List / create a `Plugin` |
| GET / PUT / DELETE | `/admin/plugins/:id` | Get / update / delete a `Plugin` |
| GET / POST | `/admin/plugins/:id/skills` | List / add plugin-skill associations |
| DELETE | `/admin/plugins/:id/skills/:skillId` | Remove a plugin-skill association |
| PUT | `/admin/plugins/:id/skills/order` | Reorder a plugin's skills |

### Scheduler jobs

See [`./subsystems/scheduler.md`](./subsystems/scheduler.md), [`./runbooks/scheduler-monitoring.md`](./runbooks/scheduler-monitoring.md).

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/admin/scheduler-jobs` | List / create a `SchedulerJob` |
| GET / PUT / DELETE | `/admin/scheduler-jobs/:slug` | Get / update / delete a job |
| GET | `/admin/scheduler-jobs/:slug/runs` | Run history for a job |
| POST | `/admin/scheduler-jobs/:slug/run` | Trigger a job now |

### Pipeline dispatch (L1 / L2 / L3)

Base: `/admin/pipeline-dispatch`. Each layer has the same five endpoints (`{layer}` ∈ `l1-multi`, `l2-multi`, `l3-multi`). See [`./admin-guides/pipeline-dispatch-l1-multi-admin-guide.md`](./admin-guides/pipeline-dispatch-l1-multi-admin-guide.md).

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/pipeline-dispatch/{layer}/options` | Available options for the dispatch form |
| POST | `/admin/pipeline-dispatch/{layer}/preview` | Preview which calls/tickers would run |
| POST | `/admin/pipeline-dispatch/{layer}/preview/csv` | Same preview as a CSV download |
| POST | `/admin/pipeline-dispatch/{layer}/run` | Enqueue the dispatch |
| GET | `/admin/pipeline-dispatch/{layer}/runs` | Prior dispatch runs |

### Pipeline jobs (failed-chunk ops)

Base: `/admin/pipeline-jobs` — reads/writes BullMQ's own `failed` set (Redis-only, no Postgres table).

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/pipeline-jobs/truncated` | Preview truncated-output failures |
| POST | `/admin/pipeline-jobs/truncated/split-retry` | Split and retry truncated chunks |
| GET | `/admin/pipeline-jobs/signals` | List signals for scoped failures |

### KPIs, KPI groups, KPI filters, dedup

See [`./subsystems/screener-kpi-registry.md`](./subsystems/screener-kpi-registry.md).

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/admin/kpis` | List / create a `Kpi` |
| POST | `/admin/kpis/validate-formula` | Validate a formula expression |
| GET / PUT | `/admin/kpis/:abbr` | Get / update a KPI |
| GET | `/admin/kpis/:abbr/preview` | Preview a KPI's resolved value |
| GET / POST | `/admin/kpis/:abbr/relationships` | List / create KPI relationships |
| DELETE | `/admin/kpis/:abbr/relationships/:id` | Delete a relationship |
| GET | `/admin/kpi-groups` | List `KpiGroup`s |
| GET | `/admin/kpi-groups/tree` | Full display-hierarchy tree |
| GET / PUT / DELETE | `/admin/kpi-groups/:slug` | Get / update / delete a group |
| POST | `/admin/kpi-groups` | Create a group |
| GET / POST | `/admin/kpi-filters` | List / create a `KpiFilter` |
| GET / PUT / DELETE | `/admin/kpi-filters/:slug` | Get / update / delete a filter |
| POST | `/admin/kpi-dedup/phase6/preview` | Preview per-industry KPI-cap dedup |
| POST | `/admin/kpi-dedup/phase6/run` | Run the dedup |

### Company groups

Base: `/admin/company-groups`. See [`./admin-guides/company-groups-admin-guide.md`](./admin-guides/company-groups-admin-guide.md).

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/admin/company-groups` | List / create a `CompanyGroup` |
| GET / PUT / DELETE | `/admin/company-groups/:slug` | Get / update / delete a group |
| GET | `/admin/company-groups/:slug/resolve` | Resolve the group to its ticker set |
| GET / POST | `/admin/company-groups/:slug/filters` | List / attach KPI filters |
| DELETE | `/admin/company-groups/:slug/filters/:id` | Detach a filter |
| POST | `/admin/company-groups/:slug/recompute` | Recompute materialized membership |

### Screen configs

Base: `/admin/screen-configs`.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/admin/screen-configs` | List / create a `ScreenConfig` |
| GET / PUT / DELETE | `/admin/screen-configs/:key` | Get / update / delete a config |
| POST | `/admin/screen-configs/:key/items` | Add a `ScreenConfigItem` |
| PUT / DELETE | `/admin/screen-configs/:key/items/:itemId` | Update / remove an item |

### Prowess

Base: `/admin/prowess/*`. See [`./subsystems/prowess-ingestion.md`](./subsystems/prowess-ingestion.md).

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/prowess/historic/preview` | Preview a historic CSV upload |
| POST | `/admin/prowess/historic/run` | Apply a historic CSV upload |
| POST | `/admin/prowess/batch/send` | SendBatch (submit a live Prowess batch) |
| POST | `/admin/prowess/batch/:token/check` | GetBatch (poll by token) |
| GET | `/admin/prowess/batch/:token` | Batch status |
| GET | `/admin/prowess/batch` | List batches |
| POST | `/admin/prowess/batch/abort-all` | AbortAll pending batches |
| GET | `/admin/prowess/coverage/options` | Coverage-preview options |
| POST | `/admin/prowess/coverage/preview` | Data-presence preview for a ticker set |

### BSE discovery

Base: `/admin/bse-discovery`. See [`./subsystems/bse-discovery.md`](./subsystems/bse-discovery.md).

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/bse-discovery/run` | Trigger a discovery run |
| GET | `/admin/bse-discovery/runs` | Discovery run history |
| GET | `/admin/bse-discovery/urls` | List discovered candidate URLs |
| GET | `/admin/bse-discovery/preview` | Preview a candidate document |
| POST | `/admin/bse-discovery/approve` | Approve a URL into ingestion |
| POST | `/admin/bse-discovery/dismiss` | Soft-delete (hide) a URL |
| POST | `/admin/bse-discovery/undismiss` | Restore a dismissed URL |

### Documents, error reports, technicals

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/documents/upload/:docType` | Upload a PDF (`docType` ∈ transcript/ppt/annual_report; `multipart` field `file`) |
| GET | `/admin/error-reports` | List error reports (triage) |
| GET | `/admin/error-reports/:id` | Get one error report |
| PATCH | `/admin/error-reports/:id` | Update status/notes |
| POST | `/admin/technicals/bulk-analyze` | Bulk (re)generate L3 technical insights for many tickers |
| POST | `/admin/technicals/bulk-status` | Poll bulk-analyze progress |

## See also

- [`./data-model.md`](./data-model.md) — tables each endpoint reads/writes
- [`./architecture.md`](./architecture.md) — server / worker / scheduler split
- [`./pipeline.md`](./pipeline.md) — L1/L2/L3 flow behind the pipeline endpoints
- [`./configuration.md`](./configuration.md) — env vars, auth secrets, webhook secrets
- [`../routes/index.js`](../routes/index.js) — the authoritative mount map
