'use strict';

const prisma = require('../lib/prisma');

async function getCalls(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 10));
    const skip = (page - 1) * size;

    const totalCount = await prisma.earnings_calls.count();

    const calls = await prisma.earnings_calls.findMany({
      orderBy: { created_at: 'desc' },
      skip,
      take: size
    });

    const totalPages = Math.ceil(totalCount / size);

    res.json({
      success: true,
      data: calls,
      pagination: {
        page,
        size,
        totalItems: totalCount,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching calls:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch calls', message: error.message });
  }
}

async function getCallById(req, res) {
  try {
    const { callId } = req.params;
    const call = await prisma.earnings_calls.findUnique({ where: { id: callId } });

    if (!call) {
      return res.status(404).json({ success: false, error: 'Call not found' });
    }

    res.json({ success: true, data: call });
  } catch (error) {
    console.error('Error fetching call:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch call', message: error.message });
  }
}

async function getTranscriptStocks(_, res) {
  try {
    const companies = await prisma.earnings_calls.findMany({
      distinct: ['company'],
      select: { company: true, company_name: true, basic_industry: true },
      orderBy: { company: 'asc' }
    });

    const companyList = companies.filter(item => item.company && item.company.trim().length > 0);

    res.json({ success: true, data: companyList });
  } catch (error) {
    console.error('Error fetching unique companies:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch companies', message: error.message });
  }
}

async function getTranscriptCalls(req, res) {
  try {
    const { symbol } = req.query;

    if (!symbol) {
      return res.status(400).json({ success: false, error: 'Symbol query parameter is required' });
    }

    const calls = await prisma.earnings_calls.findMany({
      where: { company: symbol },
      select: {
        id: true,
        company: true,
        company_name: true,
        basic_industry: true,
        fiscal_year: true,
        call_date: true,
        quarter: true,
        ppt_url: true,
        transcript_text: false,
        ppt_text: false
      }
    });

    res.json({ success: true, data: calls.reverse() });
  } catch (error) {
    console.error('Error fetching transcripts by symbol:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch transcripts', message: error.message });
  }
}

module.exports = { getCalls, getCallById, getTranscriptStocks, getTranscriptCalls };
