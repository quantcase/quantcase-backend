# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Detailed documentation lives in [`docs/`](./docs/).** Start with [docs/README.md](./docs/README.md).
> This file is a high-level orientation; the docs are the source of truth for architecture
> ([docs/architecture.md](./docs/architecture.md)), the pipeline ([docs/pipeline.md](./docs/pipeline.md)),
> the data model ([docs/data-model.md](./docs/data-model.md)), the API
> ([docs/api-reference.md](./docs/api-reference.md)), setup/config
> ([docs/setup.md](./docs/setup.md), [docs/configuration.md](./docs/configuration.md)),
> and LLM routing ([docs/llm-integration.md](./docs/llm-integration.md)).

## Project Overview

QuantCase Backend is a Node.js API server that turns Indian-market earnings calls, investor
presentations, and annual reports into structured intelligence. It runs a multi-layer LLM
pipeline (signal extraction → lens scoring → narrative insights) asynchronously via a BullMQ
job queue. LLM calls route through OpenRouter by default, with Google Vertex AI / Gemini as an
opt-in path for the L1 extraction workers.

## Development Commands

### Running the Application
The system runs as **four long-running processes** (all defined in `ecosystem.config.js`):
```bash
npm run dev          # API server with hot reload (nodemon)          → :8000
npm run worker       # BullMQ worker (node --max-old-space-size=8192)
npm run scheduler    # DB-driven cron scheduler                       → 127.0.0.1:8001
npm run admin        # Bull Board queue dashboard                     → :9000
# production: npm start (API), npm run worker (worker), npm run scheduler
```
**Important**: the API server enqueues jobs; the worker processes them. Both (plus Redis) are
required for the pipeline to do anything. The scheduler drives periodic bulk dispatch; Bull Board
is for queue monitoring.

### Database Operations
```bash
npm run db:push                    # Push Prisma schema changes to PostgreSQL
npm run db:generate                # Regenerate Prisma client after schema changes
npm run db:studio                  # Open Prisma Studio GUI
npm run db:seed:billing            # Seed billing products/prices
npm run db:seed:scheduler          # Seed SchedulerJob cron definitions
npm run db:seed:post-html-analysis # Seed L3/L4 PostHtmlAnalysisConfig rows
npm run db:create:bse              # Create BseDiscoveredUrl rows
# plus many one-off seeders under scripts/ (seedLensConfigs.js, seedHtmlSkills.js, seedScreens.js, …)
```
**Note**: Always run `npm run db:generate` after modifying `prisma/schema.prisma`. There is no
single `db:seed` script.

## Architecture

### Multi-Process Architecture
- **server.js** — Express API; handles HTTP requests and enqueues jobs.
- **worker.js** — BullMQ worker host; `require()`s every processor in `workers/` (the L1/L2/L3
  pipeline + HTML skills + WealthOS).
- **scheduler.js** — DB-driven cron process; dispatches periodic bulk pipeline runs and ingestion.
- **lib/admin.js** — Bull Board dashboard for queue inspection.

Splitting API from workers keeps long-running LLM processing off the request path. See
[docs/architecture.md](./docs/architecture.md).

### Job Queue System
- **JobQueue singleton** (`lib/jobQueue.js`): wraps BullMQ `Queue`s over a single ioredis
  connection. **Redis-only — there is no dual Postgres "Job" table tracking.**
- **Enqueue flow**: HTTP controller → `services/jobs.service.js` (or `services/pipelineDispatch/*`)
  → `jobQueue.addJob(queueName, jobData)` (job name = `jobData.type`). For document jobs,
  `jobs.service.js` downloads the source PDF, splits it into page-range **chunks**, assigns a
  shared `lineageId`, and enqueues **one job per chunk**.
- **Status**: read straight from BullMQ (`jobQueue.getJobStatus` / `services/jobs.service.js`).
  The Postgres `jobs` table is only a secondary mirror written by the four *synthesis* workers
  (`aiInsightSynthesis`, `overviewSynthesis`, `technicals`, `postHtmlAnalysis`) via
  `prisma.job.upsert` keyed by `bullmqId`; L1/L2/HTML workers do not touch it.
- **Failures**: terminal failures (after retries) are recorded in `pipeline_job_failures`
  (`PipelineJobFailure`); `services/pipelineJobRetry.service.js` + `/admin/pipeline-jobs` handle
  retry / split-retry.

### LLM Integration
- **Single choke point**: `utils/workerUtils.js` `llmStream(params, opts)` — always streams
  `chat.completions`, accumulates deltas, captures usage, and throws on `finish_reason === 'length'`.
- **Default provider**: OpenRouter (`config/llm.js`, the `openai` SDK pointed at openrouter.ai,
  routed Anthropic-native so PDF blocks work). Vertex/Gemini is opt-in — see the L1-on-Vertex
  section below.
- **Prompts** live in `prompts/` (builder functions per stage). **Structured-output JSON schemas**
  live in `outputSchemas/`.
- **Per-skill config** (model, max tokens, prompt, schema) is loaded at runtime from the DB via
  `utils/skillConfig.js` `loadSkillConfig(slug)` (backed by the `skills`/`plugins` tables and
  `lib/skillsRegistry.js`).

See [docs/llm-integration.md](./docs/llm-integration.md).

### Database Models
The Prisma schema (`prisma/schema.prisma`) has ~90 models. Full domain-by-domain reference:
[docs/data-model.md](./docs/data-model.md). Pipeline-critical tables:
- **earnings_calls** — raw ingested calls (transcript_text, ppt_text, URLs, etc.).
- **transcript_signals_v2** (`TranscriptSignalV2`) — **L1 output**: structured signals per document
  (signal_type, source_doc_type, metric, impact, severity, statement, `data` JSON, lineage_id).
  (An older `extracted_signals`/`ExtractedSignal` table still exists and is served by `/api/signals`,
  but the current v2 workers write `transcript_signals_v2`.)
- **lens_scores** (`LensScore`) — **L2 output**: per-lens z-scores per ticker.
- **ai_insights** (`AiInsight`) — **L3 output**: narrative insights per (ticker, type).

Cross-layer joins are by string keys (`call_id`, `ticker`, `lineage_id`), not foreign keys.
`Summary`/`summaries` is a **deprecated** v1 table (superseded by `SummaryNew` + `TranscriptSignalV2`).
Legacy `earnings_calls_1/2/test` clones exist from past migrations.

### Three-Layer Pipeline Coverage
The pipeline processes each document through three progressive layers (each cached on a content
hash so unchanged inputs skip repeat LLM calls):

| Layer | Table | Description |
|-------|-------|-------------|
| Raw | `earnings_calls` | All ingested calls / PPTs / annual reports |
| L1 | `transcript_signals_v2` | Signal extraction (metrics, KPIs, flags) |
| L2 | `lens_scores` | Lens scoring / z-score aggregation |
| L3 | `ai_insights` | AI narrative insights (management/opportunity/deal/…) |

For **live** coverage counts, query `GET /api/monitoring/pipeline/coverage`. Full pipeline
detail (including the HTML-skills / post-HTML branch and admin bulk dispatch) is in
[docs/pipeline.md](./docs/pipeline.md).

## Smallcase Gateway Integration

QuantCase connects users' broker accounts via [smallcase Gateway](https://developers.gateway.smallcase.com) to import holdings and place orders.

**Two credentials, two roles** (both server-side only, never sent to the frontend):
- `SMALLCASE_SECRET` (shared secret) — signs the HS256 JWT placed in the `x-gateway-authtoken` header.
- `SMALLCASE_API_SECRET` (API secret) — sent verbatim as the `x-gateway-secret` header, and is the HMAC key used to verify webhook checksums.

**Required env vars**: `SMALLCASE_GATEWAY_NAME` (default `quantcase`), `SMALLCASE_SECRET`, `SMALLCASE_API_SECRET`, `SMALLCASE_API_BASE_URL` (default `https://gatewayapi.smallcase.com`), `SMALLCASE_ENCRYPTION_KEY` (32-byte hex; AES key for encrypting the stored auth token at rest).

**Flow**: `POST /api/smallcase/connect` (backend creates a HOLDINGS_IMPORT transaction → returns `transactionId`) → frontend Gateway SDK runs the `transactionId` → `POST /api/smallcase/transactions/:id/confirm` (backend fetches result, stores `smallcaseAuthId`, marks connected, syncs holdings) → `POST /api/smallcase/sync` / `GET /api/smallcase/holdings` for portfolio → `POST /api/smallcase/orders` for BUY/SELL/rebalance (returns a `transactionId` the SDK runs). smallcase calls `POST /api/smallcase/webhook` server-to-server on completion; the checksum is verified with the API secret (raw-body route, registered before the auth middleware).

Key files: `lib/smallcaseGateway.js` (JWT signing + Gateway HTTP client + webhook checksum), `services/smallcase.service.js`, `controllers/smallcase.controller.js`, `routes/smallcase.routes.js`. Models: `SmallcaseUser`, `SmallcasePortfolio`, `SmallcaseHolding`, `SmallcaseOrder`. Deep dive: [docs/subsystems/smallcase-gateway.md](./docs/subsystems/smallcase-gateway.md).

## Invite-Only Registration

Registration is gated behind an admin-issued invite. Flow: `POST /admin/invites` (body: `{ emails: string[] }`) creates one `Invite` row per email (skips emails with an existing active invite) and emails each recipient an HTML invite via SMTP, linking to `FRONTEND_INVITE_URL` (default `https://beta.quantcase.ai`) with `?invite_token=...` appended. The frontend calls `GET /api/invites/validate?token=...` to check the token is still `pending` and unexpired before showing the signup form (returns the invited email + expiry, or 404/410 on invalid/used/expired). `POST /api/auth/register` now requires `invite_token` in the body — it re-validates the token, requires the submitted email to match the invited email, and marks the invite `accepted` in the same transaction as user creation so the token can't be reused. Invites expire after 7 days (`InviteStatus`: pending/accepted/expired).

**Email sending**: `lib/mailer.js` wraps `nodemailer` over plain SMTP (works with AWS SES SMTP, SendGrid SMTP, Postmark, etc. — swap providers via env vars only). Required env vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. Templates live in `utils/emailTemplates/` (currently `invite.js`).

**Google Sign-In** (`POST /api/auth/google`, body `{ id_token }`): verifies the Google ID token server-side via `google-auth-library` (`services/auth.service.js#googleAuth`), then gates entry on the same invite system — the verified, email-verified Google email must have an active invite (`pending` or `accepted`; looked up by `inviteService.findActiveInviteForEmail`, no token needed since there's nothing in the URL for this flow). An existing `User` row with that email links `google_id` on first use and signs in; a brand-new email creates the `User` (no `password_hash` — Google-only account), accepts the invite in the same transaction as `register()` does, and returns the same `{ access_token, refresh_token, user }` shape. No active invite → 403 `"This is an invite-only platform..."`. Required env var: `GOOGLE_CLIENT_ID` (must match the OAuth client ID the frontend uses to obtain the ID token).

Key files: `services/invite.service.js` (create/validate/findActiveInviteForEmail), `services/auth.service.js` (`googleAuth`), `lib/mailer.js`, `utils/emailTemplates/invite.js`, `controllers/admin.invites.controller.js` + `routes/admin.invites.routes.js` (admin create, mounted at `/admin/invites`), `controllers/invite.controller.js` + `routes/invites.routes.js` (public validate, mounted at `/api/invites`). Model: `Invite` (`qc_invites` table). Deep dive: [docs/subsystems/auth-invites-google.md](./docs/subsystems/auth-invites-google.md).

## API Endpoints

Full endpoint map (grouped by feature area, with auth requirements) is in
[docs/api-reference.md](./docs/api-reference.md). Common ones:

- `POST /api/auth/google` — Google Sign-In (body `{ id_token }`); invite-gated, auto-creates account on first login
- `GET /health` — Health check with database connectivity test
- `GET /api/calls?page=1&size=10` — List earnings calls (paginated, max 100 per page)
- `GET /api/calls/:callId` — Get specific earnings call
- `POST /api/calls/:callId/summarize-v2` — Enqueue L1 transcript extraction
- `POST /api/calls/:callId/summarize-v2-ppt` — Enqueue L1 PPT extraction
- `GET /api/jobs/:jobId` — Get job status from BullMQ

> Note: many `/api/*` data/pipeline routers are currently mounted **without** `authenticate`
> (effectively public today). `docs/api-reference.md` marks auth per route — treat "Public"
> there as "what the code does now," not necessarily intended policy.

## Important Configuration

### Environment Variables
Full reference with defaults and security notes: [docs/configuration.md](./docs/configuration.md).
Essentials in `.env` (there is no `.env.example`):
- `DATABASE_URL` / `DIRECT_DATABASE_URL` — PostgreSQL (pooled / direct)
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` — Redis for BullMQ
- `OPENROUTER_API_KEY` — default LLM router (`config/llm.js`)
- `CLAUDE_API_KEY`, `OPENAI_API_KEY` — provider keys (used where applicable)
- `PORT` — API server port (default 8000)

Optional (Vertex AI for the L1 pipeline — see below):
- `GCP_PROJECT_ID` — Google Cloud project ID (enables Vertex routing when set)
- `GCP_VERTEX_LOCATION` — Vertex region, default `global`
- `VERTEX_GEMINI_ENABLED` — `true` to route L1 Gemini calls through Vertex; unset = OpenRouter
- `VERTEX_GEMINI_MODELS` — ordered model preference, default `google/gemini-3.5-flash,google/gemini-2.5-flash-lite`

### L1 Pipeline on Vertex AI (Gemini)

The L1 extraction workers (`workers/summarization_v2.js`, `summarization_v2_ppt.js`,
`summarization_v2_annual_report.js`) can send their Gemini calls to Vertex AI's
OpenAI-compatible endpoint instead of OpenRouter, so they draw on GCP credits.

- **Opt-in per call**: only these three L1 workers pass `{ vertex: true }` to `llmStream()`.
  Everything else (Claude, L2/L3, screener, journal) stays on OpenRouter untouched.
- **Gated**: routing happens only when `VERTEX_GEMINI_ENABLED=true`, `GCP_PROJECT_ID` is set,
  and the model is a Gemini model. Otherwise it transparently falls back to OpenRouter — so
  the switch is fully reversible via env (no code change).
- **Model preference**: the Vertex path ignores the per-skill DB model and uses
  `VERTEX_GEMINI_MODELS` in order — `gemini-3.5-flash` first, falling back to
  `gemini-2.5-flash-lite` if 3.5 isn't offered on Vertex. Unavailable models are cached
  in-process so later calls skip the dead probe.
- **Auth**: GCP Application Default Credentials (short-lived OAuth token, auto-refreshed via
  `google-auth-library`) — no static key. Local: `gcloud auth application-default login`.
  Prod: a service account with the "Vertex AI User" role.
- **Verify first**: `node scripts/testVertexGemini.js` probes each configured model's
  availability before you flip the flag.

- **PDF blocks**: Vertex's OpenAI layer rejects the `{type:"file"}` PDF block OpenRouter uses
  (400 "Unrecognized 'type' field ... found: 'file'"). `llmStream` rewrites it to
  `{type:"image_url", image_url:{url:"data:application/pdf;base64,..."}}` on the Vertex path only
  (Gemini reads PDFs fine that way). Workers are unchanged.

Key files: `config/vertexLlm.js` (client + ADC auth + model fallback + PDF block conversion),
`utils/workerUtils.js` (`llmStream` routing), `config/env.js` (env wiring).

### Worker Concurrency & Queue Options
Each `workers/*` processor constructs its own `new Worker(queueName, processor, opts)`, so
concurrency/limiter/lock are **per worker**, not global. Example — `workers/summarization_v2.js`:
`concurrency: 25`, `limiter: { max: 50, duration: 1000 }` (50 jobs/s), `lockDuration: 300000`
(5 min, because LLM calls can run 60–120s).

Queue-level defaults (`lib/jobQueue.js` `defaultJobOptions`): `attempts: 1` (individual workers
may override), `removeOnComplete` keeps 7 days / 25000 jobs, `removeOnFail` keeps 7 days. (The
inline "24 hours" comment in that file is inaccurate — the value is `7 * 24 * 3600`.)

## Key Files

- `server.js` — Express API server
- `worker.js` — BullMQ worker host (requires all `workers/*`)
- `scheduler.js` + `scheduler/` — DB-driven cron scheduler
- `lib/jobQueue.js` — Redis-only BullMQ queue singleton
- `lib/admin.js` — Bull Board dashboard
- `config/llm.js`, `config/vertexLlm.js` — LLM clients (OpenRouter / Vertex)
- `utils/workerUtils.js` — `llmStream` (the LLM choke point)
- `services/jobs.service.js` — enqueue + PDF chunking
- `services/lensComposer.js`, `lib/insightLenses.js` — L2 composition + L3 lens mapping
- `prisma/schema.prisma` — database schema (~90 models)
- `prompts/` — LLM prompt builders per stage
- `outputSchemas/` — structured-output JSON schemas
- `ecosystem.config.js` — PM2 process config (4 apps)

## Working with Jobs

### Creating a Job
Document extraction is enqueued via `POST /api/calls/:callId/summarize-v2` (transcript) or
`/summarize-v2-ppt` (PPT); annual reports via `POST /api/annual-reports/:reportId/summarize-v2`.
The controller delegates to `services/jobs.service.js`, which:
1. Validates the call/report has a source document.
2. Downloads the PDF, counts pages, and splits it into page-range **chunks** (transcript 8pp,
   PPT 6pp, annual report 10pp), assigning a shared `lineageId`.
3. Enqueues **one BullMQ job per chunk** on the relevant `summarization_v2*` queue.
4. Returns job identifiers for status polling via `GET /api/jobs/:jobId`.

### Processing Flow (L1)
1. A `summarization_v2*` worker picks up a chunk job.
2. `loadSkillConfig('summarization-v2')` → compute `source_hash`/`prompt_v` → dedup check
   (skip if already extracted).
3. Fetch call metadata + industry KPIs; extract the chunk's page range (`pdf-lib`) into a
   base64 PDF block.
4. Build the prompt (`prompts/transcript_call_v2.js` et al.) and call
   `llmStream(params, { vertex: true })` (Gemini via Vertex when enabled, else OpenRouter).
5. `parseJson` the response, `upsertNewKpis` (KPI registry discovery), and `writeSignals` into
   `transcript_signals_v2`.

L2 (`lens_computation`) and L3 (`ai_insight_synthesis`, etc.) run as their own queues over the
signals L1 produced — see [docs/pipeline.md](./docs/pipeline.md).

### Error Handling
- Workers catch errors; BullMQ retries per the worker's `attempts` setting.
- Terminal failures are logged to `pipeline_job_failures`; retry/split-retry via
  `services/pipelineJobRetry.service.js` and `/admin/pipeline-jobs`.

## Streaming for Long Requests

`llmStream` (`utils/workerUtils.js`) always uses streaming `chat.completions`:
- Accumulates streamed deltas into the full message and captures token `usage`.
- Keeps the connection alive for requests that can run minutes (large PDFs).
- Throws on `finish_reason === 'length'` so truncated output is caught rather than silently
  saved; `admin.pipelineJobs` can split-retry those.

## Choosing / Switching the LLM

There is no global "current LLM" toggle. Model selection is **per skill**, loaded from the DB
(`skills.model`, via `utils/skillConfig.js` `loadSkillConfig(slug)`), and the provider is chosen
by `llmStream` routing (OpenRouter by default; Vertex/Gemini for the opt-in L1 path). To change a
skill's model, update its `skills` row (see `scripts/update*Skill.js`). See
[docs/llm-integration.md](./docs/llm-integration.md).

## Graceful Shutdown

All four entry points (`server.js`, `worker.js`, `scheduler.js`, `lib/admin.js`) handle
SIGTERM/SIGINT and log `uncaughtException`/`unhandledRejection` before exiting:
- Close BullMQ queues/workers, quit the Redis connection, disconnect Prisma.
- Ensures no data loss during deployment/restart (PM2 restarts them via `ecosystem.config.js`).
