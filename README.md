# QuantCase Backend

## Three-Layer Pipeline

Earnings calls are processed through three progressive enrichment layers:

| Layer | Table | Description | Unique Companies |
|-------|-------|-------------|-----------------|
| Raw | `earnings_calls` | All ingested calls | **1,991** |
| L1 | `extracted_signals` | Structured signal extraction (metrics, KPIs, flags per call) | **1,948** |
| L2 | `lens_scores` | Aggregated lens z-scores per ticker | **550** |
| L3 | `ai_insights` | AI narrative insights by type (management, opportunity, deal) | **743** |

- **L1** runs on every new call to extract granular signals (signal_type, metric, value, confidence, etc.)
- **L2** aggregates L1 signals into lens-level z-scores for cross-company comparison
- **L3** generates narrative insights from L2 scores; types include `management`, `opportunity`, `deal`, `technicals`, `fundamentals`

> Coverage as of 2026-05-28

## PRISMA
npx prisma db pull
npx prisma generate
npx prisma db push

## REDIS SETUP
sudo apt update
sudo apt install redis-tools # for redis-cli
sudo snap install redis
sudo snap set redis service.start=true

## PM2 SETUP

All 4 processes are defined in `ecosystem.config.js` (autorestart, capped restarts,
memory limit on the API server). Use it instead of starting each process by hand.

```bash
# First-time setup (or after pulling changes to ecosystem.config.js)
pm2 start ecosystem.config.js

# Make PM2 itself survive a server reboot:
pm2 startup        # run the sudo command it prints, once per machine
pm2 save           # snapshot the current process list so it's restored on boot

# Day to day
pm2 restart ecosystem.config.js   # restart all 4 apps, picking up code changes
pm2 status                        # check state / restart counts
pm2 logs quantcase-worker         # tail logs for one app (also written to logs/*.log)
```

**Why processes were "staying dead":**
- The app code had no `uncaughtException`/`unhandledRejection` handlers, so a stray
  rejected promise anywhere could crash the process in a way that was hard to trace.
  All 4 entry points (`server.js`, `worker.js`, `scheduler.js`, `lib/admin.js`) now log
  these and exit(1) cleanly so PM2's restart logic actually kicks in.
- Without `pm2 save` + `pm2 startup`, PM2's process list does not survive a server
  reboot — a crash that coincides with (or triggers) a reboot means nothing restarts
  the app at all. Run `pm2 startup` and `pm2 save` once so this can't happen.
- `ecosystem.config.js` sets `max_restarts: 10` + `min_uptime: 30s` so a genuine
  crash-loop (e.g. bad `.env` after a deploy) stops retrying instead of hammering
  forever — check `pm2 status` if an app shows `errored`.

# API Endpoints

### Health Check
```bash
curl -X GET http://localhost:8000/health
```

### Get All Calls
```bash
curl -X GET http://localhost:8000/api/calls
```

### Get Stocks List
```bash
curl -X GET http://localhost:8000/api/transcript-stocks
```

### Get Transcripts for a stock
```bash
curl -X GET http://localhost:8000/api/transcript-calls?symbol=ADANIPOWER
```


### Get Specific Call
```bash
curl -X GET http://localhost:8000/api/calls/CANFINHOME_FY2026_Q3
```

### Create Summarization Job
```bash
curl -X POST http://localhost:8000/api/calls/CANFINHOME_FY2026_Q3/summarize
```

### Get Job Status
```bash
curl -X GET http://localhost:8000/api/jobs/<JOB_ID>
```

### Sample Call IDs
```
CALLS = ["CANFINHOME_FY2026_Q3", "TCS_FY2026_Q3"]
```



### Fetch all concalls
node scripts/fetch-concalls.js 2>&1 | tee scripts/fetch-concalls.log | awk '
  /Fetching/      { pending--; processed++ }
  /Skipping.*already/ { pending-- }
  /Saved/         { printf "\r[%d/%d done] %s", processed, total, $0; fflush() }
  /ERROR/         { errors++; print }
  /Done\./        { print "\nFinished. Errors: " errors }
  BEGIN           { total=2960; processed=0; pending=2960; errors=0 }
'
#### How many symbols done so far
tail -f scripts/fetch-concalls.log | grep "Saved"
