[Docs](./README.md) · Coverage Matrix

# Documentation Coverage Matrix

A living map of **subsystem → implementing code → the doc that covers it**, so "is everything
documented?" has one answerable page. Rows are grouped by domain. Every subsystem with meaningful
code now has a home; areas that are a section inside a broader doc are marked **(folded in)**.

> [!NOTE]
> This matrix is maintained by hand. When you add a route/worker/service that introduces a new
> flow, add a row here and link its doc. The audit behind this table covered 56 route files,
> 53 controllers, 87 services, 13 workers, 13 lib modules, and ~92 Prisma models.

## Pipeline & LLM core

| Subsystem | Key code | Doc |
|---|---|---|
| L1/L2/L3 enrichment pipeline | [`workers/summarization_v2*`](../workers), [`workers/lensComputation.js`](../workers/lensComputation.js), [`services/lensComposer.js`](../services/lensComposer.js), [`workers/aiInsightSynthesis.js`](../workers/aiInsightSynthesis.js), [`lib/insightLenses.js`](../lib/insightLenses.js) | [pipeline.md](./pipeline.md) |
| L4 overview synthesis | [`workers/overviewSynthesis.js`](../workers/overviewSynthesis.js) | [pipeline.md](./pipeline.md) |
| HTML skills / post-HTML branch | [`workers/htmlSkill.js`](../workers/htmlSkill.js), [`workers/htmlIncrementalSkill.js`](../workers/htmlIncrementalSkill.js), [`workers/postHtmlAnalysis.js`](../workers/postHtmlAnalysis.js) | [pipeline.md](./pipeline.md), [admin-guides/html-incremental-skills-guide.md](./admin-guides/html-incremental-skills-guide.md) |
| Admin bulk dispatch (L1/L2/L3 multi) | [`services/pipelineDispatch/`](../services/pipelineDispatch), [`scheduler/handlers/pipelineDispatch*`](../scheduler/handlers) | [pipeline.md](./pipeline.md), [admin-guides/pipeline-dispatch-l1-multi-admin-guide.md](./admin-guides/pipeline-dispatch-l1-multi-admin-guide.md) |
| Calls / transcripts / summaries read API | [`controllers/calls.controller.js`](../controllers/calls.controller.js), [`controllers/summary.controller.js`](../controllers/summary.controller.js) | [pipeline.md](./pipeline.md) *(folded in — "Read & query API")* |
| LLM choke point + routing | [`utils/workerUtils.js`](../utils/workerUtils.js), [`config/llm.js`](../config/llm.js), [`config/vertexLlm.js`](../config/vertexLlm.js) | [llm-integration.md](./llm-integration.md) |
| Job queue / failed-chunk ops | [`lib/jobQueue.js`](../lib/jobQueue.js), [`services/pipelineJobRetry.service.js`](../services/pipelineJobRetry.service.js) | [runbooks/JOB_QUEUE_GUIDE.md](./runbooks/JOB_QUEUE_GUIDE.md) |
| Technicals / Wyckoff / decision-intelligence | [`workers/technicals.js`](../workers/technicals.js), [`lib/technicalAnalysis.js`](../lib/technicalAnalysis.js), [`lib/wyckoff.js`](../lib/wyckoff.js), [`utils/ta*.js`](../utils) | **[subsystems/technicals-wyckoff.md](./subsystems/technicals-wyckoff.md)** *(new)* |
| Industry Intelligence (IIT) | [`utils/industryIntelligence/`](../utils/industryIntelligence), [`controllers/industryIntelligence.controller.js`](../controllers/industryIntelligence.controller.js), [`config/iitClassification.json`](../config/iitClassification.json) | **[subsystems/industry-intelligence.md](./subsystems/industry-intelligence.md)** *(new)* |

## Data, screener & ingestion

| Subsystem | Key code | Doc |
|---|---|---|
| Screener & KPI / formula registry | [`controllers/screener.controller.js`](../controllers/screener.controller.js), [`utils/formulaRegistry/`](../utils/formulaRegistry), [`lib/financials.js`](../lib/financials.js) | [subsystems/screener-kpi-registry.md](./subsystems/screener-kpi-registry.md) |
| Baskets / industry baskets | [`controllers/baskets.controller.js`](../controllers/baskets.controller.js), [`controllers/industryBaskets.controller.js`](../controllers/industryBaskets.controller.js) | [subsystems/screener-kpi-registry.md](./subsystems/screener-kpi-registry.md) *(folded in)* + [subsystems/industry-intelligence.md](./subsystems/industry-intelligence.md) |
| Tickers / batch metrics / models | [`controllers/tickers.controller.js`](../controllers/tickers.controller.js), [`services/tickerMetrics.service.js`](../services/tickerMetrics.service.js) | [subsystems/screener-kpi-registry.md](./subsystems/screener-kpi-registry.md) *(folded in)* |
| Prowess (CMIE) ingestion | [`services/prowess/`](../services/prowess), [`lib/prowess.js`](../lib/prowess.js) | [subsystems/prowess-ingestion.md](./subsystems/prowess-ingestion.md) |
| BSE document discovery | [`services/bseScraper.service.js`](../services/bseScraper.service.js), [`services/bseResolver.service.js`](../services/bseResolver.service.js) | [subsystems/bse-discovery.md](./subsystems/bse-discovery.md) |
| Company groups | [`services/companyGroups/`](../services/companyGroups) | [admin-guides/company-groups-admin-guide.md](./admin-guides/company-groups-admin-guide.md) |
| Mutual funds | [`controllers/mutualFunds.controller.js`](../controllers/mutualFunds.controller.js), [`services/mutualFunds.service.js`](../services/mutualFunds.service.js) | **[subsystems/mutual-funds.md](./subsystems/mutual-funds.md)** *(new)* |
| Private equity / DRHP analyser | [`controllers/privateEquity.controller.js`](../controllers/privateEquity.controller.js), [`services/privateEquity.service.js`](../services/privateEquity.service.js) | **[subsystems/private-equity-drhp.md](./subsystems/private-equity-drhp.md)** *(new)* |

## User-facing product surfaces

| Subsystem | Key code | Doc |
|---|---|---|
| Investor dashboard (discover / research-library / market) | [`controllers/dashboard.controller.js`](../controllers/dashboard.controller.js), [`services/dashboard/`](../services/dashboard) | **[subsystems/investor-dashboard.md](./subsystems/investor-dashboard.md)** *(new)* |
| Portfolio (user + shadow) | [`controllers/portfolio.controller.js`](../controllers/portfolio.controller.js), [`services/portfolio/`](../services/portfolio) | **[subsystems/investor-dashboard.md](./subsystems/investor-dashboard.md)** *(new)* |
| Unified journal | [`services/journal/`](../services/journal) | [subsystems/unified-journal.md](./subsystems/unified-journal.md), [frontend/JOURNAL_FRONTEND_INTEGRATION.md](./frontend/JOURNAL_FRONTEND_INTEGRATION.md) |
| WealthOS (RM / advisory) | [`services/wealthos/`](../services/wealthos), [`workers/wealthos.*.js`](../workers) | [subsystems/wealthos.md](./subsystems/wealthos.md), [frontend/wealthos-api.md](./frontend/wealthos-api.md) |
| Smallcase broker integration | [`lib/smallcaseGateway.js`](../lib/smallcaseGateway.js), [`services/smallcase.service.js`](../services/smallcase.service.js) | [subsystems/smallcase-gateway.md](./subsystems/smallcase-gateway.md) |

## Platform & operations

| Subsystem | Key code | Doc |
|---|---|---|
| Auth / invites / Google sign-in | [`services/auth.service.js`](../services/auth.service.js), [`services/invite.service.js`](../services/invite.service.js), [`middleware/globalAuth.js`](../middleware/globalAuth.js) | [subsystems/auth-invites-google.md](./subsystems/auth-invites-google.md) |
| Billing / subscriptions (Razorpay) | [`services/billing.service.js`](../services/billing.service.js), [`services/subscription.service.js`](../services/subscription.service.js) | [subsystems/billing-razorpay.md](./subsystems/billing-razorpay.md), [frontend/razorpay-frontend-integration.md](./frontend/razorpay-frontend-integration.md) |
| Scheduler / cron dispatch | [`scheduler.js`](../scheduler.js), [`scheduler/`](../scheduler) | [subsystems/scheduler.md](./subsystems/scheduler.md), [runbooks/scheduler-monitoring.md](./runbooks/scheduler-monitoring.md) |
| Monitoring API (`/api/monitoring`) | [`controllers/monitoring.controller.js`](../controllers/monitoring.controller.js), [`services/monitoring.service.js`](../services/monitoring.service.js) | **[subsystems/monitoring.md](./subsystems/monitoring.md)** *(new)* |
| Error reporting | [`services/errorReport.service.js`](../services/errorReport.service.js), [`controllers/admin.errorReports.controller.js`](../controllers/admin.errorReports.controller.js) | **[subsystems/error-reporting.md](./subsystems/error-reporting.md)** *(new)* |
| Email / mailer | [`lib/mailer.js`](../lib/mailer.js), [`utils/emailTemplates/`](../utils/emailTemplates) | [subsystems/auth-invites-google.md](./subsystems/auth-invites-google.md) *(folded in)* |
| Uploads & file handling (multer) | [`routes/privateEquity.routes.js`](../routes/privateEquity.routes.js), [`routes/admin.documentUpload.routes.js`](../routes/admin.documentUpload.routes.js) | [configuration.md](./configuration.md) *(folded in — "Uploads & file handling")* |

## Known code gaps (not documentation gaps)

These were surfaced by the audit as things worth the team's attention — they are *code* states, not
missing docs.

> [!WARNING]
> - **No rate limiting** anywhere (no `express-rate-limit` / equivalent) — every JWT-gated route is
>   otherwise unthrottled.
> - **[`workers/fundamentalsIntelligence.js`](../workers/fundamentalsIntelligence.js)** (queue
>   `fundamentals_analysis`) is **not** required by [`worker.js`](../worker.js), so that queue has no
>   running consumer. It also appears in `monitoring.service.js`'s `ALL_QUEUES`. See
>   [subsystems/industry-intelligence.md](./subsystems/industry-intelligence.md).
> - **`GET /api/monitoring/kpis/registry`** destructures a `REGISTRY` symbol the formula-registry
>   module never exports, so it returns an empty set — the live data is behind `getRegistrySnapshot()`.
>   See [subsystems/monitoring.md](./subsystems/monitoring.md).
> - **DRHP analyses reuse `ai_insights`** (`type='drhp-analysis'`, unique on `(ticker, type)`), so
>   unidentified uploads collide on `(UNKNOWN, drhp-analysis)`. See
>   [subsystems/private-equity-drhp.md](./subsystems/private-equity-drhp.md).

## See also

- [README.md](./README.md) — the documentation index
- [architecture.md](./architecture.md) — the four processes and how they connect
- [pipeline.md](./pipeline.md) — the enrichment pipeline behind most of the above
