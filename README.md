# QuantCase Backend

## Setup

  # 1. Install dependencies
  npm install
  npx prisma db pull
  npx prisma generate

  # 2. Push schema to database
  npx prisma db push

  # 3. Start server
  npm start

  Available Commands:

  npm run dev          # Development with auto-reload
  npm run db:push      # Push schema changes to database
  npm run db:generate  # Generate Prisma Client
  npm run db:studio    # Open Prisma Studio (database GUI)
  npm run db:seed      # Seed sample data

## Database Management

```bash
# View your data in Prisma Studio
npx prisma studio

# Reset database (careful: deletes all data)
npx prisma db push --force-reset
```

## API Endpoints

### Health Check
```bash
curl -X GET http://localhost:8000/health
```

### Get All Calls
```bash
curl -X GET http://localhost:8000/api/calls
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