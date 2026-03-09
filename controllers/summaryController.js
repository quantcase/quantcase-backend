'use strict';

const prisma = require('../lib/prisma');

async function getSummary(req, res) {
  try {
    const { callId } = req.params;

    const summary = await prisma.summaryNew.findFirst({
      where: { callId },
      orderBy: { createdAt: 'desc' }
    });

    if (!summary) {
      return res.status(404).json({ success: false, error: 'Summary not found for this call' });
    }

    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch summary', message: error.message });
  }
}

module.exports = { getSummary };
