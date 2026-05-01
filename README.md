# QuantCase Backend

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
