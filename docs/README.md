# QuantCase Backend — Documentation

This folder is the documentation hub for the QuantCase backend — a Node.js/Express +
BullMQ/Redis + PostgreSQL (Prisma) service that ingests Indian-market earnings calls,
PPTs, and annual reports, runs a multi-layer LLM extraction → scoring → synthesis pipeline,
and serves screener, portfolio, journal, billing, and broker-integration APIs.

New here? Read [architecture.md](./architecture.md), then [setup.md](./setup.md).

## Core docs

| Doc | What it covers |
|-----|----------------|
| [architecture.md](./architecture.md) | System overview: the 4-process topology (API, worker, scheduler, Bull Board), request lifecycle, job queue, graceful shutdown. |
| [pipeline.md](./pipeline.md) | The L1 → L2 → L3 enrichment pipeline (signal extraction → lens scoring → AI insights) plus the HTML-skills / post-HTML branch and admin bulk dispatch. |
| [llm-integration.md](./llm-integration.md) | The `llmStream` choke point, OpenRouter-vs-Vertex/Gemini routing, PDF handling, prompts, and DB-backed per-skill config. |
| [data-model.md](./data-model.md) | The Prisma schema by domain (~90 models), pipeline table lineage, enums, and deprecated tables. |
| [api-reference.md](./api-reference.md) | Full HTTP endpoint map grouped by feature area, with auth requirements. |
| [setup.md](./setup.md) | Local development setup: prerequisites, `.env`, Redis, Prisma, seeds, and running all 4 processes. |
| [configuration.md](./configuration.md) | Environment-variable reference grouped by concern, with defaults and security notes. |
| [deployment.md](./deployment.md) | Bare-metal GCP deployment via PM2 + nginx + Certbot; links the ops runbooks. |

## Subsystems

Feature deep-dives in [subsystems/](./subsystems/):

| Doc | Subsystem |
|-----|-----------|
| [auth-invites-google.md](./subsystems/auth-invites-google.md) | JWT auth, invite-only registration, Google Sign-In. |
| [smallcase-gateway.md](./subsystems/smallcase-gateway.md) | smallcase broker integration (connect, holdings, orders, webhooks). |
| [unified-journal.md](./subsystems/unified-journal.md) | The unified `/api/journal` (watchlist + notes + thesis + AI health). |
| [billing-razorpay.md](./subsystems/billing-razorpay.md) | Products, plans, subscriptions, coupons, and Razorpay webhooks. |
| [prowess-ingestion.md](./subsystems/prowess-ingestion.md) | Prowess (CMIE) batch API + bulk OHLCV CSV ingestion. |
| [bse-discovery.md](./subsystems/bse-discovery.md) | Crawling BSE for transcript/PPT/annual-report document URLs. |
| [scheduler.md](./subsystems/scheduler.md) | The DB-driven cron scheduler process and its handlers. |
| [wealthos.md](./subsystems/wealthos.md) | The WealthOS relationship-manager / advisory module. |
| [screener-kpi-registry.md](./subsystems/screener-kpi-registry.md) | Screener endpoints and the KPI / formula registry that powers them. |

## Existing reference material

- **Frontend integration guides** — [frontend/](./frontend/): Technicals, Wyckoff,
  Technicals Management, Journal, Error Reporting, Razorpay, smallcase, and the WealthOS API.
- **Admin guides** — [admin-guides/](./admin-guides/): company groups, HTML incremental
  skills, L1-multi pipeline dispatch.
- **Specs & design** — [specs/](./specs/): journal backend spec, WealthOS PRD, technicals
  guide, deal-lenses UI fixes.
- **Runbooks** — [runbooks/](./runbooks/): [JOB_QUEUE_GUIDE.md](./runbooks/JOB_QUEUE_GUIDE.md),
  [deploy-qc-gcp.md](./runbooks/deploy-qc-gcp.md), [schedular-monitoring.md](./runbooks/schedular-monitoring.md).
- **Assets** — [assets/](./assets/): the three-layer architecture diagram.

> Non-documentation artifacts (data dumps, exports, one-off scripts, raw logs, archived
> prompt text, and the bulk OHLCV CSVs) live in [`../extras/`](../extras/), not here.
