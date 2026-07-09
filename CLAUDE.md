# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

QuantCase Backend is a Node.js API server that analyzes earnings calls using LLMs (Claude/OpenAI) to extract structured intelligence about management integrity, promises, governance signals, and financial guidance. It processes earnings call transcripts and presentations asynchronously using a job queue system.

## Development Commands

### Running the Application
```bash
npm run dev          # Run API server with hot reload (nodemon)
npm run worker:dev   # Run background worker with hot reload
npm start            # Run API server in production
npm run worker       # Run background worker in production
```

**Important**: Both the API server and worker must be running for full functionality. The server handles HTTP requests and enqueues jobs; the worker processes those jobs.

### Database Operations
```bash
npm run db:push      # Push Prisma schema changes to PostgreSQL
npm run db:generate  # Regenerate Prisma client after schema changes
npm run db:studio    # Open Prisma Studio GUI for database inspection
npm run db:seed      # Seed database with initial data
```

**Note**: Always run `npm run db:generate` after modifying `prisma/schema.prisma` to update the Prisma client.

## Architecture

### Dual-Process Architecture
The application uses a **server/worker split pattern**:
- **server.js**: Express API that handles HTTP requests and enqueues jobs
- **worker.js**: BullMQ worker that processes summarization jobs asynchronously

This separation ensures long-running AI processing doesn't block API responses.

### Job Queue System
- **JobQueue singleton** (`lib/jobQueue.js`): Manages BullMQ queues and database job entries
- **Dual tracking**: Jobs are tracked in both BullMQ (for queue management) and PostgreSQL `Job` table (for persistence and API queries)
- **Redis**: Required for BullMQ job queue
- **Flow**: API creates job → JobQueue adds to BullMQ + creates DB record → Worker processes → Updates DB with result

### LLM Integration
- **Current LLM**: Uses Claude (Anthropic) by default (line 23 in worker.js: `const LLMClient = anthropic.messages`)
- **Fallback**: OpenAI client also initialized but commented out
- **Streaming**: Uses `.stream()` with `.finalMessage()` to avoid timeout errors on long-running requests (>10 minutes)
- **Structured Output**: Uses JSON schemas (`utils/outputSchemas.js`) with Claude's `output_config` format
- **Prompts**: Stored in `utils/prompts/` directory (currently only `transcript_call.js`)

### Database Models
Key Prisma models:
- **earnings_calls**: Stores earnings call data (company, fiscal_year, quarter, transcript_text, ppt_text, etc.)
- **Job**: Tracks background jobs with status (pending/processing/completed/failed) and links to BullMQ via `bullmqId`
- **Summary**: Stores extracted intelligence (entities, promises, guidance, governance_signals, etc.)
- **extracted_signals**: L1 output — structured financial/operational signals extracted per call (ticker, signal_type, metric, value, etc.)
- **lens_scores**: L2 output — aggregated z-scores per ticker per lens (lens_slug, z_score, signal_count, etc.)
- **ai_insights**: L3 output — narrative AI insights per ticker by type (management, opportunity, deal, technicals, etc.)

Note: Multiple earnings_calls tables exist (earnings_calls_1, earnings_calls_2, earnings_calls_test) - likely for testing/migration purposes.

### Three-Layer Pipeline Coverage (as of 2026-05-28)
The pipeline processes earnings calls through three progressive layers:

| Layer | Table | Description | Unique Companies |
|-------|-------|-------------|-----------------|
| Raw | `earnings_calls` | All ingested calls | **1,991** |
| L1 | `extracted_signals` | Signal extraction (metrics, KPIs, flags) | **1,948** |
| L2 | `lens_scores` | Lens scoring / z-score aggregation | **680** |
| L3 | `ai_insights` | AI narrative insights (management/opportunity/deal) | **743** |

**L3 types breakdown**: management (743), opportunity (743), deal (741), technicals (111), fundamentals (24), nse_industry (13), overview (6), drhp-analysis (1)

## Smallcase Gateway Integration

QuantCase connects users' broker accounts via [smallcase Gateway](https://developers.gateway.smallcase.com) to import holdings and place orders.

**Two credentials, two roles** (both server-side only, never sent to the frontend):
- `SMALLCASE_SECRET` (shared secret) — signs the HS256 JWT placed in the `x-gateway-authtoken` header.
- `SMALLCASE_API_SECRET` (API secret) — sent verbatim as the `x-gateway-secret` header, and is the HMAC key used to verify webhook checksums.

**Required env vars**: `SMALLCASE_GATEWAY_NAME` (default `quantcase`), `SMALLCASE_SECRET`, `SMALLCASE_API_SECRET`, `SMALLCASE_API_BASE_URL` (default `https://gatewayapi.smallcase.com`), `SMALLCASE_ENCRYPTION_KEY` (32-byte hex; AES key for encrypting the stored auth token at rest).

**Flow**: `POST /api/smallcase/connect` (backend creates a HOLDINGS_IMPORT transaction → returns `transactionId`) → frontend Gateway SDK runs the `transactionId` → `POST /api/smallcase/transactions/:id/confirm` (backend fetches result, stores `smallcaseAuthId`, marks connected, syncs holdings) → `POST /api/smallcase/sync` / `GET /api/smallcase/holdings` for portfolio → `POST /api/smallcase/orders` for BUY/SELL/rebalance (returns a `transactionId` the SDK runs). smallcase calls `POST /api/smallcase/webhook` server-to-server on completion; the checksum is verified with the API secret (raw-body route, registered before the auth middleware).

Key files: `lib/smallcaseGateway.js` (JWT signing + Gateway HTTP client + webhook checksum), `services/smallcase.service.js`, `controllers/smallcase.controller.js`, `routes/smallcase.routes.js`. Models: `SmallcaseUser`, `SmallcasePortfolio`, `SmallcaseHolding`, `SmallcaseOrder`.

## API Endpoints

- `GET /health` - Health check with database connectivity test
- `GET /api/calls?page=1&size=10` - List earnings calls (paginated, max 100 per page)
- `GET /api/calls/:callId` - Get specific earnings call
- `POST /api/calls/:callId/summarize` - Create async summarization job for a call
- `GET /api/jobs/:jobId` - Get job status with BullMQ state and results

## Important Configuration

### Environment Variables
Required in `.env`:
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` - Redis configuration for BullMQ
- `CLAUDE_API_KEY` - Anthropic API key (current default)
- `OPENAI_API_KEY` - OpenAI API key (if switching LLMs)
- `PORT` - API server port (default: 8000)

### Worker Limits
Configured in worker.js:
- `TRANSCRIPT_CHAR_LIMIT`: 50,000 characters (testing limit for transcripts)
- `MAX_TOKENS`: 50,000 (LLM max tokens)
- `concurrency`: 5 jobs processed simultaneously
- `limiter`: 10 jobs per second

### Job Retry Configuration
In `lib/jobQueue.js`:
- Attempts: 4 retries
- Backoff: Fixed 20-second delay between retries
- Completed jobs kept for 24 hours (up to 1000)
- Failed jobs kept for 7 days

## Key Files

- `server.js` - Express API server with endpoints
- `worker.js` - BullMQ worker that processes summarization jobs
- `lib/jobQueue.js` - Singleton managing BullMQ queues and database job entries
- `prisma/schema.prisma` - Database schema definition
- `utils/prompts/transcript_call.js` - Prompt template for earnings call extraction
- `utils/outputSchemas.js` - JSON schema for structured LLM output

## Working with Jobs

### Creating a Job
Jobs are created via POST to `/api/calls/:callId/summarize`. The flow:
1. API validates call exists and has text content (transcript or PPT)
2. `jobQueue.addJob()` creates BullMQ job and database Job record
3. Returns job ID for status polling

### Processing Flow
1. Worker picks up job from BullMQ queue
2. Updates database status to 'processing'
3. Combines transcript_text and ppt_text (up to TRANSCRIPT_CHAR_LIMIT)
4. Generates prompt using `transcriptExtractorPrompt()`
5. Calls Claude API with structured output schema
6. Parses JSON response and saves to Summary table
7. Updates Job record with 'completed' status and result

### Error Handling
- Worker catches errors and updates Job table with 'failed' status
- BullMQ retries failed jobs (4 attempts with 20s backoff)
- Database updates ensure job status always reflects current state

## Streaming for Long Requests

The worker uses **streaming mode** to avoid HTTP timeout errors on long-running requests:
- Uses `LLMClient.stream()` instead of `LLMClient.create()`
- Calls `.finalMessage()` to get the complete response without handling individual events
- Keeps the HTTP connection alive with server-sent events
- Required by Anthropic SDK for requests that may take longer than 10 minutes

## Switching Between LLMs

To switch from Claude to OpenAI:
1. Change line 23 in `worker.js`: `const LLMClient = openaiClient.chat.completions;`
2. Update API call in `processSummarizationJob()` to use OpenAI format (without streaming)
3. Adjust model name and message format accordingly
4. Note: OpenAI has different timeout handling and may not require streaming

## Graceful Shutdown

Both server.js and worker.js handle SIGTERM/SIGINT:
- Close BullMQ queues/workers
- Disconnect Redis
- Disconnect Prisma client
- Ensures no data loss during deployment/restart
