require('dotenv').config();
const express = require('express');
const cors = require('cors');
const prisma = require('./lib/prisma');
const jobQueue = require('./lib/jobQueue');
const { getManagementAnalysis } = require('./controllers/managementController');
const { FinHelper } = require('./utils/finHelper');
const { createDealAnalysis } = require('./controllers/dealController');
const { OFactorResponseSchema } = require('./utils/constants');
const { getOFactorResult, getLatestOFactorResultByTicker } = require('./db-utils/upsertOFactor');
const { getDealResult, getLatestDealResult } = require('./db-utils/upsertDealResult');
const { mapToDealResponseSchema } = require('./utils/dealMapper');
const app = express();
const port = process.env.PORT || 8000;


// Middleware
app.use(cors());
app.use(express.json());

// Test database connection
prisma.$connect()
  .then(() => console.log('Successfully connected to PostgreSQL database via Prisma'))
  .catch((err) => console.error('Error connecting to the database:', err));

// Health check endpoint
app.get('/health', async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// Get all earnings calls
app.get('/api/calls', async (req, res) => {
  try {
    // Parse pagination parameters
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 10));

    // Calculate skip for pagination
    const skip = (page - 1) * size;

    // Get total count for pagination metadata
    const totalCount = await prisma.earnings_calls.count();

    // Fetch paginated calls
    const calls = await prisma.earnings_calls.findMany({
      orderBy: {
        created_at: 'desc'
      },
      skip: skip,
      take: size
    });

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / size);

    res.json({
      success: true,
      data: calls,
      pagination: {
        page: page,
        size: size,
        totalItems: totalCount,
        totalPages: totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching calls:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch calls',
      message: error.message
    });
  }
});

// Get specific earnings call by ID
app.get('/api/calls/:callId', async (req, res) => {
  try {
    const { callId } = req.params;
    const call = await prisma.earnings_calls.findUnique({
      where: { id: callId }
    });

    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    res.json({
      success: true,
      data: call
    });
  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch call',
      message: error.message
    });
  }
});

// Get summary for a specific earnings call
app.get('/api/summary/:callId', async (req, res) => {
  try {
    const { callId } = req.params;

    // Find the most recent summary for this call
    const summary = await prisma.summaryNew.findFirst({
      where: { callId: callId },
      orderBy: { createdAt: 'desc' }
    });

    if (!summary) {
      return res.status(404).json({
        success: false,
        error: 'Summary not found for this call'
      });
    }

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch summary',
      message: error.message
    });
  }
});

// Get all unique companies
app.get('/api/transcript-stocks', async (req, res) => {
  try {
    const companies = await prisma.earnings_calls.findMany({
      distinct: ['company'],
      select: {
        company: true,
        company_name: true,
        basic_industry: true
      },
      orderBy: {
        company: 'asc'
      }
    });

    // Filter out entries where company is null or empty
    const companyList = companies
      .filter(item => item.company && item.company.trim().length > 0);

    res.json({
      success: true,
      data: companyList
    });
  } catch (error) {
    console.error('Error fetching unique companies:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch companies',
      message: error.message
    });
  }
});

// Get transcripts by company symbol
app.get('/api/transcript-calls', async (req, res) => {
  try {
    const { symbol } = req.query;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'Symbol query parameter is required'
      });
    }

    // exclude values of transcript_text and ppt_text in final object to reduce payload size
    const calls = await prisma.earnings_calls.findMany({
      where: {
        company: symbol
      },
      select: {
        id: true,
        company: true,
        company_name: true,
        basic_industry: true,
        fiscal_year: true,
        call_date: true,
        quarter: true,
        ppt_url: true,
        transcript_text: false, // Exclude transcript_text
        ppt_text: false // Exclude ppt_text
      }
    });

    res.json({
      success: true,
      data: calls.reverse() // reverse the order
    });
  } catch (error) {
    console.error('Error fetching transcripts by symbol:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transcripts',
      message: error.message
    });
  }
});

// Get management analysis (transformed summary data)
app.get('/api/management/analysis', getManagementAnalysis);

// Extract KPI values from a quarterly earnings PDF
app.post('/api/calls/:callId/extract-qe', async (req, res) => {
  try {
    const { callId } = req.params;

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }

    if (!call.quarterly_result_url?.trim()) {
      return res.status(400).json({ success: false, error: 'No quarterly_result_url for this call' });
    }

    const job = await jobQueue.addJob('qe_extraction', { callId, type: 'qe_extraction' });

    res.json({
      success: true,
      message: 'QE extraction job created and queued',
      job: { id: job.id, callId: job.callId, type: job.type, status: job.status, bullmqId: job.bullmqId, createdAt: job.createdAt }
    });
  } catch (error) {
    console.error('Error creating QE extraction job:', error);
    res.status(500).json({ success: false, error: 'Failed to create QE extraction job', message: error.message });
  }
});

// Summarize an earnings call
app.post('/api/calls/:callId/summarize', async (req, res) => {
  try {
    const { callId } = req.params;

    // Check if call exists
    const call = await prisma.earnings_calls.findUnique({
      where: { id: callId }
    });

    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    const hasTranscript = call.transcript_text && call.transcript_text.trim().length > 0;
    const hasPPT = call.ppt_text && call.ppt_text.trim().length > 0;
    if (!hasTranscript && !hasPPT) {
      return res.status(400).json({ success: false, error: 'No transcript or PPT text available for this call' });
    }
    const summarizationData = {
      callId, type: 'summarization',
      companyName: call.company_name || call.company,
      transcriptText: call.transcript_text,
      pptText: call.ppt_text
    };
    const summarizationJob = await jobQueue.addJob('summarization', summarizationData);

    const qeJob = await jobQueue.addJob('qe_extraction', { callId, type: 'qe_extraction' });

    res.json({
      success: true,
      message: 'Summarization job queued',
      job: { id: summarizationJob.id, callId, type: 'summarization', status: 'pending', createdAt: summarizationJob.createdAt }
    });
  } catch (error) {
    console.error('Error creating summarization job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create summarization job',
      message: error.message
    });
  }
});

// Enqueue an OFactor analysis job for a specific section
// Body: { section: "industry" | "competition" | "financial_strength" | "customer_traction" }
const VALID_OFACTOR_SECTIONS = new Set(['industry', 'competition', 'financial_strength', 'customer_traction']);

app.post('/api/calls/:callId/opportunity/analysis', async (req, res) => {
  try {
    const { callId } = req.params;
    const { section } = req.body ?? {};

    if (!section) {
      return res.status(400).json({ success: false, error: 'section is required in request body' });
    }
    if (!VALID_OFACTOR_SECTIONS.has(section)) {
      return res.status(400).json({
        success: false,
        error: `Invalid section "${section}". Must be one of: ${[...VALID_OFACTOR_SECTIONS].join(', ')}`
      });
    }

    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }

    const subjectTicker = call.company;

    const job = await jobQueue.addJob('ofactor_analysis', {
      callId,
      type:          'ofactor_analysis',
      subjectTicker,
      section,
    }, { jobId: `ofactor_${callId}_${section}` });

    res.json({
      success: true,
      message: `OFactor "${section}" analysis job created and queued`,
      job: {
        id:        job.id,
        callId,
        type:      'ofactor_analysis',
        section,
        status:    'pending',
        createdAt: new Date(job.timestamp).toISOString(),
      },
    });
  } catch (error) {
    console.error('Error creating OFactor analysis job:', error);
    res.status(500).json({ success: false, error: 'Failed to create OFactor analysis job', message: error.message });
  }
});

// Return the stored OFactor result for a call (poll after job completes)
app.get('/api/calls/:callId/analysis', async (req, res) => {
  try {
    const { callId } = req.params;

    const record = await getOFactorResult(callId);

    if (!record) {
      return res.status(404).json({ success: false, error: 'OFactor analysis not yet available — trigger via POST first' });
    }

    res.json({ success: true, data: record.result });
  } catch (error) {
    console.error('Error fetching OFactor analysis:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch OFactor analysis', message: error.message });
  }
});

// Return stored OFactor result by callId query param
// Falls back to the latest result for the same company if exact callId is not found
app.get('/api/opportunity/analysis', async (req, res) => {
  const { callId } = req.query;
  if (!callId) {
    return res.status(400).json({ success: false, error: 'callId query parameter is required' });
  }
  try {
    let record = await getOFactorResult(callId);

    if (!record) {
      // Resolve the ticker: first try the DB, then fall back to parsing the callId pattern
      const call = await prisma.earnings_calls.findUnique({ where: { id: callId }, select: { company: true } });
      const ticker = call?.company ?? callId.replace(/_FY\d+_Q\d+$/i, '');

      record = await getLatestOFactorResultByTicker(ticker);
    }

    if (!record) {
      return res.status(404).json({ success: false, error: 'OFactor analysis not yet available — trigger via POST first' });
    }

    res.json({ success: true, data: record.result });
  } catch (error) {
    console.error('Error fetching OFactor analysis:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch OFactor analysis', message: error.message });
  }
});

app.get('/api/deal/analysis', async (req, res) => {
  const { callId } = req.query;
  if (!callId) {
    return res.status(400).json({ success: false, error: 'callId query parameter is required' });
  }
  try {
    const record = await getDealResult(callId);
    if (!record) {
      return res.status(404).json({ success: false, error: 'No deal analysis available yet — trigger via POST first' });
    }
    res.json({ success: true, data: mapToDealResponseSchema(record.result), inputs: record.inputs });
  } catch (error) {
    console.error('Error fetching deal analysis:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch deal analysis', message: error.message });
  }
});

// Enqueue a deal analysis job — computes EPS/PE inputs, then queues Claude call
app.post('/api/calls/:callId/deal/analysis', createDealAnalysis);

// Return the stored deal result for a call (poll after job completes)
app.get('/api/calls/:callId/deal', async (req, res) => {
  try {
    const { callId } = req.params;
    const record = await getDealResult(callId);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Deal analysis not yet available — trigger via POST first' });
    }
    res.json({ success: true, data: mapToDealResponseSchema(record.result), inputs: record.inputs });
  } catch (error) {
    console.error('Error fetching deal result:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch deal result', message: error.message });
  }
});

app.get('/api/jobs/:jobId', async (req, res) => {
  const STATE_TO_STATUS = {
    waiting:   'pending',
    delayed:   'pending',
    paused:    'pending',
    active:    'processing',
    completed: 'completed',
    failed:    'failed',
  };

  try {
    const { jobId } = req.params;

    // Try all queues — different analysis types live in different queues
    const queues = ['summarization', 'ofactor_analysis', 'deal_analysis', 'qe_extraction'];
    let job = null;
    for (const q of queues) {
      job = await jobQueue.getJobStatus(q, jobId);
      if (job) break;
    }

    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({
      success: true,
      data: {
        id:          job.id,
        callId:      job.data?.callId   ?? null,
        type:        job.data?.type     ?? null,
        status:      STATE_TO_STATUS[job.state] ?? job.state,
        bullmqId:    job.id,
        createdAt:   null,
        updatedAt:   null,
        completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        error:       job.failedReason ?? null,
        bullmqObject: {
          id:           job.id,
          name:         job.name,
          state:        job.state,
          progress:     job.progress,
          attemptsMade: job.attemptsMade,
          returnvalue:  job.returnvalue,
        }
      }
    });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch job', message: error.message });
  }
});



// ── Helper: fetch Q4-based stats for one ticker ───────────────────────────────
// Revenue = full-year Q4 REV_OP; Revenue Growth = YoY vs previous Q4.
// OPM, ROCE, D/E are derived from raw stored KPIs rather than pre-computed abbrs.
async function getQ4Stats(ticker) {
  const q4Calls = await prisma.earnings_calls.findMany({
    where:   { company: ticker, quarter: 'Q4' },
    select:  { id: true, fiscal_year: true },
    orderBy: { fiscal_year: 'desc' },
  });
  if (!q4Calls.length) return null;

  const latestQ4 = q4Calls[0];
  const prevQ4   = q4Calls[1] ?? null;

  const summary = await prisma.summaryNew.findUnique({
    where:  { callId: latestQ4.id },
    select: { kpis: true },
  });
  if (!summary?.kpis || !Array.isArray(summary.kpis)) return null;

  const kpis = summary.kpis;
  const get = (abbr) => {
    const match = kpis.find(k => k.kpi_abbr === abbr);
    if (!match) return null;
    const val = parseFloat(match.kpi_value ?? match.value);
    return isNaN(val) ? null : val;
  };

  const revOp      = get('REV_OP');
  const pbt        = get('PBT');
  const finCost    = get('FIN_COST')    ?? 0;
  const depAmort   = get('DEP_AMORT')   ?? 0;
  const othInc     = get('OTH_INC')     ?? 0;
  const totalAssets= get('TOTAL_ASSETS');
  const currLiab   = get('CURR_LIAB');
  const eqShareCap = get('EQ_SHARE_CAP');
  const resSurplus = get('RES_SURPLUS');
  const debtLt     = get('DEBT_LT')     ?? 0;
  const debtSt     = get('DEBT_ST')     ?? 0;

  // OPM (EBITDA margin) = (PBT + FIN_COST + DEP_AMORT - OTH_INC) / REV_OP × 100
  let opm = null;
  if (pbt != null && revOp) {
    opm = parseFloat(((pbt + finCost + depAmort - othInc) / revOp * 100).toFixed(2));
  }

  // ROCE = (PBT + FIN_COST) / (TOTAL_ASSETS - CURR_LIAB) × 100
  let roce = null;
  if (pbt != null && totalAssets != null && currLiab != null) {
    const ce = totalAssets - currLiab;
    if (ce > 0) roce = parseFloat(((pbt + finCost) / ce * 100).toFixed(2));
  }

  // D/E = (DEBT_LT + DEBT_ST) / (EQ_SHARE_CAP + RES_SURPLUS)
  let debtEquity = null;
  if (eqShareCap != null && resSurplus != null) {
    const equity = eqShareCap + resSurplus;
    if (equity > 0) debtEquity = parseFloat(((debtLt + debtSt) / equity).toFixed(2));
  }

  // Revenue Growth = YoY vs previous Q4
  let revenueGrowth = null;
  if (prevQ4 && revOp != null) {
    const prevSummary = await prisma.summaryNew.findUnique({
      where:  { callId: prevQ4.id },
      select: { kpis: true },
    });
    if (prevSummary?.kpis && Array.isArray(prevSummary.kpis)) {
      const prevMatch = prevSummary.kpis.find(k => k.kpi_abbr === 'REV_OP');
      if (prevMatch) {
        const prevRev = parseFloat(prevMatch.kpi_value ?? prevMatch.value);
        if (!isNaN(prevRev) && prevRev > 0) {
          revenueGrowth = parseFloat(((revOp - prevRev) / prevRev * 100).toFixed(2));
        }
      }
    }
  }

  return { revenue: revOp, revenueGrowth, opm, roce, debtEquity };
}

// Peer comparison table: Revenue, Revenue Growth, OPM%, ROCE%, Market Share, Debt/Equity
// for the subject company (from callId) + top 5 peers from the same industry
app.get('/api/opportunity/peer-data', async (req, res) => {
  const { callId } = req.query;
  if (!callId) {
    return res.status(400).json({ success: false, error: 'callId query parameter is required' });
  }

  try {
    const call = await prisma.earnings_calls.findUnique({
      where:  { id: callId },
      select: { company: true, company_name: true, basic_industry: true },
    });
    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }

    const subjectTicker = call.company;
    const industry = call.basic_industry;

    // Top 5 peers in same industry ranked by number of Q4 calls (most annual data = best peers)
    let peerTickers = [];
    if (industry) {
      const peerGroups = await prisma.earnings_calls.groupBy({
        by:      ['company'],
        where:   { basic_industry: industry, company: { not: subjectTicker }, quarter: 'Q4' },
        _count:  { id: true },
        orderBy: { _count: { id: 'desc' } },
        take:    5,
      });
      peerTickers = peerGroups.map(r => r.company);
    }

    const allTickers = [subjectTicker, ...peerTickers];

    // Fetch company names and stats in parallel
    const [nameRows, statsResults] = await Promise.all([
      prisma.earnings_calls.findMany({
        where:    { company: { in: allTickers } },
        select:   { company: true, company_name: true },
        distinct: ['company'],
      }),
      Promise.allSettled(allTickers.map(getQ4Stats)),
    ]);

    const nameMap = Object.fromEntries(nameRows.map(r => [r.company, r.company_name]));

    const rows = statsResults.map((r, i) => ({
      ticker: allTickers[i],
      ...(r.status === 'fulfilled' && r.value
        ? r.value
        : { revenue: null, revenueGrowth: null, opm: null, roce: null, debtEquity: null }),
    }));

    // Market share = company Q4 revenue / sum of all Q4 revenues in peer set
    const totalRevenue = rows.reduce((s, r) => s + (r.revenue ?? 0), 0);

    const peers = rows.map(r => ({
      company:        nameMap[r.ticker] ?? r.ticker,
      revenue:        r.revenue,
      revenue_growth: r.revenueGrowth,
      opm:            r.opm,
      roce:           r.roce,
      market_share:   totalRevenue > 0 && r.revenue != null
        ? parseFloat(((r.revenue / totalRevenue) * 100).toFixed(2))
        : null,
      debt_equity:    r.debtEquity,
      is_current:     r.ticker === subjectTicker,
      is_average:     false,
    }));

    // Industry average row (mean of non-null values across all peers)
    const avg = (field) => {
      const vals = peers.map(p => p[field]).filter(v => v != null);
      if (!vals.length) return null;
      return parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2));
    };
    peers.push({
      company:        'Industry Average',
      revenue:        avg('revenue'),
      revenue_growth: avg('revenue_growth'),
      opm:            avg('opm'),
      roce:           avg('roce'),
      market_share:   avg('market_share'),
      debt_equity:    avg('debt_equity'),
      is_current:     false,
      is_average:     true,
    });

    res.json({
      success: true,
      competition: {
        meta: { section_id: 'competition', title: 'Competitive Benchmarking' },
        peers,
      },
    });
  } catch (error) {
    console.error('Error fetching peer data:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch peer data', message: error.message });
  }
});

// 404 handler
app.use((_, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Error handler
app.use((err, _, res, __) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await jobQueue.close();
  await prisma.$disconnect();
  console.log('Database and queue connections closed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  await jobQueue.close();
  await prisma.$disconnect();
  console.log('Database and queue connections closed');
  process.exit(0);
});
