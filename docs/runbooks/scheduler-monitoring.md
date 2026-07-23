[Docs](../README.md) · [Runbooks](../README.md#existing-reference-material) · Scheduler & Monitoring — Change Log

# Scheduler & Monitoring — Change Log

## Architecture
- 3 processes: `server.js` (API), `worker.js` + `scheduler.js` (same server/machine)
- Two-server split: Server1=API only, Server2=worker+scheduler+Redis
- Server1 pushes jobs to Redis on Server2 via BullMQ

## Scheduler Pattern
- `startup-register` with `setTimeout` + `cron-parser` (no polling between fires)
- Config fetched fresh from DB right before each fire (picks up `config` JSON changes)
- `cron_expression` / `is_active` changes: admin API POSTs to internal HTTP server on `127.0.0.1:8001` (`/reload/:slug`) — scheduler re-registers that job immediately

## Key Files
- `scheduler.js` — entry point, internal HTTP server (loopback:8001)
- `scheduler/index.js` — core: `loadAndRegisterAll`, `reregisterJob`, `fireJob`, `getStatus`
- `scheduler/registry.js` — `logRun`, `completeRun`, `failRun` → `scheduler_runs` table
- `scheduler/executor.js` — routes `job_type` to handler
- `scheduler/handlers/` — prowessOhlcv, prowessFilings, bseDiscovery, pipelineDispatch
- `controllers/admin.scheduler.controller.js` — CRUD + `notifyScheduler(slug)`
- `routes/admin.routes.js` — `/admin/scheduler-jobs` CRUD + runs + manual trigger

## DB Tables (created via raw SQL, not db:push)
- `scheduler_jobs` — slug, cron_expression, is_active, config (Json), job_type
- `scheduler_runs` — job_id, status, started_at, ended_at, records_processed, error

## Seeded Jobs
- `prowess-ohlcv-daily` → off (API stub pending)
- `prowess-quarterly-filings` → off
- `prowess-annual-filings` → off
- `bse-discovery` → on, 9am+6pm IST weekdays
- `pipeline-dispatch` → on, 9:30am+6:30pm IST weekdays

## Two-Server Env Vars
- `API_URL` — set to Server1's URL on Server2 (pipelineDispatch uses this; defaults localhost:8000)
- `SCHEDULER_HOST` + `SCHEDULER_BIND` — add when splitting servers (notifyScheduler); currently hardcoded 127.0.0.1, silent-fail if unreachable

## Services
- `services/prowess/prowessApiClient.js` — stub, throws until credentials provided
- `services/bseScraper.service.js` — Node.js port of bse_nifty50_scraper.py; pending redesign for new bse_discovered_urls table

## Monitoring
- `routes/monitoring.routes.js` + `controllers/monitoring.controller.js`
- Queue stats, scheduler run history, pipeline coverage (L1/L2/L3), KPI queries
- All KPI queries via `utils/formulaRegistry/index.js` (single entry point)
- Registered under `/api/monitoring/`
