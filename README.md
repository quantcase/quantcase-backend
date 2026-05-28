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
pm2 start "npm run dev" --name "quantcase-backend" -- --port 8000
pm2 start "npm run worker:dev" --name "quantcase-worker"

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

