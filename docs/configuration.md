# Configuration

Every runtime setting is supplied through environment variables loaded from a `.env` file at process start (`require('dotenv').config()`). This page is the authoritative catalogue of those variables, grouped by concern, with defaults and whether each is required.

There is **no `.env.example` file** in the repo — copy the tables below into a new `.env`. There is also **no `engines` field or `.nvmrc`**; see [setup.md](./setup.md) for the Node version guidance.

## Where variables are read

Despite its docstring, [`config/env.js`](../config/env.js) is **not** the single source of truth — it centralises the core app, Redis, LLM, Vertex, Razorpay, smallcase, Prowess and Google-Sign-In values, but several subsystems read `process.env` directly:

| Concern | Read in |
|---------|---------|
| Core / app / LLM / Vertex / Razorpay / smallcase / Prowess / Google client | [`config/env.js`](../config/env.js) |
| `DATABASE_URL`, `DIRECT_DATABASE_URL` | [`prisma/schema.prisma`](../prisma/schema.prisma) `datasource` block |
| JWT secrets & TTLs | [`config/auth.js`](../config/auth.js) |
| SMTP | [`lib/mailer.js`](../lib/mailer.js) |
| Vertex ADC (`GOOGLE_APPLICATION_CREDENTIALS`) | [`config/vertexLlm.js`](../config/vertexLlm.js) |
| `FRONTEND_INVITE_URL` | `services/invite.service.js` |
| `API_URL` | `scheduler/handlers/pipelineDispatch.js` |
| `ENABLE_SIGNAL_STORE` | `services/admin.skills.service.js` |
| `SCHEDULER_PORT`, `SCHEDULER_BIND_HOST` | [`scheduler.js`](../scheduler.js) |
| `SCHEDULER_HOST` | `controllers/admin.scheduler.controller.js`, `controllers/admin.bseDiscovery.controller.js` |
| `ADMIN_PORT` | [`lib/admin.js`](../lib/admin.js) |

## Core / application

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `8000` | No | API server listen port. |
| `NODE_ENV` | `development` | No | Standard Node environment flag. |
| `FISCAL_YEAR_END` | `03-31` | No | `MM-DD` of the fiscal year end (India defaults to 31 March). |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | No | Absolute base used to build links to locally-uploaded files so the worker can `fetch()` them. Set to the public API origin in production. |
| `API_URL` | `http://localhost:8000` | No | Base URL the **scheduler** uses to call the API's `summarize-v2` dispatch endpoints. Set to Server1's URL when scheduler runs on a separate host. |
| `ENABLE_SIGNAL_STORE` | unset (off) | No | `=== 'true'` enables signal-store side effects when editing admin skill prompts. |

## Database (PostgreSQL / Prisma)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DATABASE_URL` | — | **Yes** | Pooled connection string used at runtime by the Prisma client. |
| `DIRECT_DATABASE_URL` | — | **Yes** | Direct (non-pooled) connection used for `prisma db push`/migrations and for raw-SQL DDL (some tables are created via `psql`, not `db:push`). |

## Redis (BullMQ)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `REDIS_HOST` | `localhost` | No | Redis host backing the BullMQ job queue. |
| `REDIS_PORT` | `6379` | No | Redis port. |
| `REDIS_PASSWORD` | `undefined` | No | Redis auth password; omit for a local unauthenticated instance. |

## LLM providers

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `OPENROUTER_API_KEY` | — | **Yes** (default LLM path) | Routes Claude and most pipeline calls through OpenRouter via the `openai` SDK. |
| `CLAUDE_API_KEY` | — | No | Direct Anthropic key (Anthropic SDK path). |
| `OPENAI_API_KEY` | — | No | Direct OpenAI key. |

## Vertex AI / GCP (optional L1 Gemini routing)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `VERTEX_GEMINI_ENABLED` | unset (off) | No | `=== 'true'` routes L1 Gemini calls through Vertex AI instead of OpenRouter. |
| `GCP_PROJECT_ID` | — | Only if Vertex enabled | GCP project for the Vertex OpenAI-compatible endpoint. |
| `GCP_VERTEX_LOCATION` | `global` | No | Vertex region. |
| `VERTEX_GEMINI_MODELS` | `google/gemini-3.5-flash,google/gemini-2.5-flash-lite` | No | Ordered, comma-separated model preference; first available wins. |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Only if Vertex enabled and not using `gcloud` ADC | Path to a service-account JSON with the "Vertex AI User" role. The repo ships `qc-gcp-ai.json` (gitignored). Locally you can instead run `gcloud auth application-default login`. |

## Google Sign-In

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `GOOGLE_CLIENT_ID` | — | Yes (for Google login) | OAuth client ID; must match the client the frontend uses to mint the ID token. |

## JWT (auth tokens)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `JWT_SECRET` | `qc2026-secret` | **Yes in prod** | Signs access tokens. The default is insecure — override it. |
| `JWT_REFRESH_SECRET` | `qc2026-refresh-secret` | **Yes in prod** | Signs refresh tokens. The default is insecure — override it. |
| `JWT_EXPIRES_IN` | `24h` | No | Access-token TTL. |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | No | Refresh-token TTL. |

## Razorpay (billing)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `RAZORPAY_KEY_ID` | — | Yes (for billing) | Razorpay API key ID. |
| `RAZORPAY_KEY_SECRET` | — | Yes (for billing) | Razorpay API key secret. |
| `RAZORPAY_WEBHOOK_SECRET` | — | Yes (for webhooks) | Verifies Razorpay webhook signatures. |
| `RAZORPAY_DEBUG` | on | No | Debug logging is **on by default**; set `RAZORPAY_DEBUG=false` to silence it. |

## smallcase Gateway

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `SMALLCASE_ENCRYPTION_KEY` | — | Yes | 32-byte hex AES key encrypting the stored auth token at rest. |
| `SMALLCASE_SECRET` | — | Yes | Shared secret; signs the HS256 `x-gateway-authtoken` JWT. |
| `SMALLCASE_API_SECRET` | — | Yes | API secret; sent as `x-gateway-secret` and used as the webhook HMAC key. |
| `SMALLCASE_GATEWAY_NAME` | `quantcase` | No | Gateway name registered with smallcase. |
| `SMALLCASE_API_BASE_URL` | `https://gatewayapi.smallcase.com` | No | smallcase Gateway API base URL. |

## Prowess (CMIE ingestion)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PROWESS_API_KEY` | — | Yes (for Prowess) | CMIE Prowess batch API key. |
| `PROWESS_API_BASE_URL` | `https://prowess.cmie.com/api` | No | Prowess batch API base URL. |

## SMTP (transactional email)

All four of `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` are required — [`lib/mailer.js`](../lib/mailer.js) **throws** on the first send if any is missing. Works with any SMTP provider (AWS SES SMTP, SendGrid, Postmark, Gmail…).

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `SMTP_HOST` | — | **Yes** | SMTP server host. |
| `SMTP_PORT` | — | **Yes** | SMTP server port. |
| `SMTP_USER` | — | **Yes** | SMTP username. |
| `SMTP_PASSWORD` | — | **Yes** | SMTP password. |
| `SMTP_SECURE` | `false` | No | `=== 'true'` uses TLS on connect (port 465). |
| `SMTP_FROM` | falls back to `SMTP_USER` | No | Envelope/from address. |

## Frontend links

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `FRONTEND_INVITE_URL` | `https://beta.quantcase.ai` | No | Base URL used to build the invite acceptance link (`?invite_token=...`). |

## Scheduler process

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `SCHEDULER_PORT` | `8001` | No | Port for the scheduler's internal HTTP control server. |
| `SCHEDULER_BIND_HOST` | `127.0.0.1` | No | Interface the scheduler binds. **The endpoint is unauthenticated** — keep it on loopback unless network-level access controls are in place. |
| `SCHEDULER_HOST` | `127.0.0.1` | No | Host the **API** uses to reach the scheduler (reload/trigger). Set to the scheduler host's private IP in a split deployment. |

> Note: the [scheduler monitoring runbook](./runbooks/schedular-monitoring.md) refers to a `SCHEDULER_BIND` var — the live code uses `SCHEDULER_BIND_HOST`.

## Bull Board (admin)

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `ADMIN_PORT` | `9000` | No | Port for the Bull Board queue dashboard ([`lib/admin.js`](../lib/admin.js)). |

## Security notes

- **`qc-gcp-ai.json`** (GCP service-account credentials) is gitignored and must **never** be committed. Provision it out-of-band on the server.
- **`JWT_SECRET` / `JWT_REFRESH_SECRET`** ship with insecure hard-coded defaults (`qc2026-secret` / `qc2026-refresh-secret`) and **must be overridden** in any non-local environment.
- The **scheduler's internal HTTP endpoint is unauthenticated**. Keep `SCHEDULER_BIND_HOST=127.0.0.1` (the default) unless a firewall/security group restricts it to the API server only.
- SMTP, Razorpay, smallcase and Prowess secrets are all live credentials — keep them out of source control and rotate on exposure.

## Recommendations

- Add a checked-in **`.env.example`** enumerating the required keys above (currently absent).
- Add an **`.nvmrc`** or a package.json `engines` field to pin the Node version (currently absent — see [setup.md](./setup.md)).

## See also

- [setup.md](./setup.md) — first-time local setup
- [deployment.md](./deployment.md) — production PM2 + nginx deployment
- [architecture.md](./architecture.md) — process topology
- [`config/env.js`](../config/env.js), [`config/auth.js`](../config/auth.js), [`lib/mailer.js`](../lib/mailer.js) — sources
