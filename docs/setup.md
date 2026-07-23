[Docs](./README.md) · Local Setup

# Local Setup

How to get the QuantCase backend running on a development machine: install dependencies, provision Postgres + Redis, generate the Prisma client, seed reference data, and start the four processes.

The backend runs as **four independent Node processes** — API server, background worker, scheduler, and the Bull Board admin dashboard. All four read the same `.env`.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js | No version is pinned (no `engines`/`.nvmrc`) — use a current LTS (Node 18+). |
| PostgreSQL | Reachable via `DATABASE_URL` (pooled) and `DIRECT_DATABASE_URL` (direct). |
| Redis | On `localhost:6379` by default; backs the BullMQ queues. |
| npm | Ships with Node. |

## 1. Install dependencies

There is **no `postinstall` hook**, so the Prisma client is not generated automatically — run `db:generate` explicitly (step 4).

```bash
npm install
```

## 2. Create the `.env`

There is **no `.env.example`** to copy. Create `.env` from the full catalogue in [configuration.md](./configuration.md). The minimum to boot the API and worker:

```bash
# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/quantcase"
DIRECT_DATABASE_URL="postgresql://user:pass@localhost:5432/quantcase"

# Redis (BullMQ)
REDIS_HOST=localhost
REDIS_PORT=6379

# LLM (default path is OpenRouter via the openai SDK)
OPENROUTER_API_KEY="sk-or-..."
```

Add the feature-specific groups (JWT, SMTP, Razorpay, smallcase, Prowess, Google Sign-In, Vertex) as you enable those subsystems — see [configuration.md](./configuration.md). Override the insecure default `JWT_SECRET` / `JWT_REFRESH_SECRET` even locally if you test auth.

## 3. Provision Redis

Any Redis on `6379` works. The project README documents a snap-based install on Ubuntu:

```bash
sudo apt install redis-tools        # for redis-cli
sudo snap install redis
sudo snap set redis service.start=true
```

On macOS, `brew install redis && brew services start redis` is equivalent.

## 4. Generate the Prisma client & sync the schema

```bash
npm run db:generate   # prisma generate — regenerates the client (run after any schema change)
npm run db:push       # prisma db push — syncs prisma/schema.prisma to the database
```

Useful adjuncts:

```bash
npx prisma db pull    # introspect an existing DB into schema.prisma
npm run db:studio     # prisma studio — GUI to inspect/edit data
```

> Some tables (e.g. `scheduler_jobs`, `scheduler_runs`) are created via raw SQL against `DIRECT_DATABASE_URL`, not through `db:push`. See the [scheduler monitoring runbook](./runbooks/scheduler-monitoring.md).

## 5. Seed reference data

Seed only what the features you're working on need. Package scripts:

| Command | Script | Seeds |
|---------|--------|-------|
| `npm run db:seed:billing` | `prisma/seedBilling.js` | Razorpay/billing plans |
| `npm run db:seed:scheduler` | `scripts/seedSchedulerJobs.js` | `scheduler_jobs` rows (bse-discovery, pipeline-dispatch, etc.) |
| `npm run db:seed:post-html-analysis` | `scripts/seedPostHtmlAnalysisConfigs.js` | Post-HTML analysis configs |
| `npm run db:create:bse` | `scripts/createBseDiscoveredUrls.js` | `bse_discovered_urls` rows |

Additional seeders in [`scripts/`](../scripts/) run directly with `node` (no npm alias), e.g.:

```bash
node scripts/seedLensConfigs.js       # L2 lens configs
node scripts/seedHtmlSkills.js        # HTML extraction skills (also prisma/seedHtmlSkills.js)
node scripts/seedScreenConfigs.js     # screener configs
node scripts/seedUsers.js             # dev users
node scripts/seedKpiGroups.js         # KPI registry groups
```

Browse [`scripts/`](../scripts/) for the full set of `seed*.js` helpers.

## 6. Run the four processes

Each in its own terminal (or via PM2 — see [deployment.md](./deployment.md)):

| Process | Dev command | Prod command | Listens on |
|---------|-------------|--------------|------------|
| API server | `npm run dev` | `npm start` | `:8000` — health at `GET /health` |
| Worker | `npm run worker:dev` | `npm run worker` | Redis (no HTTP port) |
| Scheduler | `npm run scheduler:dev` | `npm run scheduler` | `127.0.0.1:8001` (internal, unauthenticated) |
| Bull Board | `npm run admin` | `npm run admin` | `:9000` |

```bash
npm run dev            # API (nodemon)
npm run worker:dev     # worker (nodemon, --max-old-space-size=8192)
npm run scheduler:dev  # scheduler (nodemon)
npm run admin          # Bull Board dashboard
```

Verify the API is up:

```bash
curl http://localhost:8000/health
```

Uploaded files are served at `/uploads` (e.g. `http://localhost:8000/uploads/...`).

## 7. Optional — enable Vertex AI for L1 Gemini calls

To route the L1 extraction pipeline's Gemini calls through Vertex AI (GCP credits) instead of OpenRouter:

```bash
gcloud auth application-default login          # local ADC (or set GOOGLE_APPLICATION_CREDENTIALS)
# in .env:
#   GCP_PROJECT_ID=your-project
#   VERTEX_GEMINI_ENABLED=true
node scripts/testVertexGemini.js               # probe each configured model before flipping the flag
```

See [llm-integration.md](./llm-integration.md) and [configuration.md](./configuration.md) for the full Vertex variable set.

## npm scripts reference

| Script | Runs |
|--------|------|
| `npm start` | `node server.js` |
| `npm run dev` | `nodemon server.js` |
| `npm run worker` | `node --max-old-space-size=8192 worker.js` |
| `npm run worker:dev` | `nodemon` with the same 8 GB heap flag |
| `npm run admin` | `node lib/admin.js` (Bull Board on `:9000`) |
| `npm run scheduler` | `node scheduler.js` |
| `npm run scheduler:dev` | `nodemon scheduler.js` |
| `npm run db:push` | `prisma db push` |
| `npm run db:generate` | `prisma generate` |
| `npm run db:studio` | `prisma studio` |
| `npm run db:seed:billing` | `node prisma/seedBilling.js` |
| `npm run db:seed:scheduler` | `node scripts/seedSchedulerJobs.js` |
| `npm run db:seed:post-html-analysis` | `node scripts/seedPostHtmlAnalysisConfigs.js` |
| `npm run db:create:bse` | `node scripts/createBseDiscoveredUrls.js` |

## See also

- [configuration.md](./configuration.md) — full environment-variable catalogue
- [architecture.md](./architecture.md) — how the four processes fit together
- [deployment.md](./deployment.md) — running the same processes under PM2 in production
- [`package.json`](../package.json) — script and dependency source
