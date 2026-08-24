'use strict';

const prisma = require('../config/prisma');

async function completeOnboarding(req, res, next) {
  try {
    const userId = req.user.id;
    const { mode, pickedTickers, thesis } = req.body;

    let journal = null;

    if (mode === 'pick') {
      // Find or create "Tracking" journal
      journal = await prisma.journal.findFirst({
        where: { user_id: userId, default_kind: 'tracking' }
      });
      if (!journal) {
        journal = await prisma.journal.create({
          data: {
            user_id: userId,
            name: 'Tracking',
            kind: 'tracking',
            is_default: true,
            default_kind: 'tracking'
          }
        });
      }

      // Add picked tickers to Tracking journal
      if (Array.isArray(pickedTickers) && pickedTickers.length > 0) {
        for (const ticker of pickedTickers) {
          await prisma.journalTicker.upsert({
            where: { journal_id_ticker: { journal_id: journal.id, ticker } },
            create: { journal_id: journal.id, ticker, source: 'manual' },
            update: {}
          });
        }
      }
    } else if (mode === 'import') {
      // Find "Holdings" journal
      journal = await prisma.journal.findFirst({
        where: { user_id: userId, default_kind: 'holdings' }
      });
      if (!journal) {
        // Just in case it wasn't created yet
        journal = await prisma.journal.create({
          data: {
            user_id: userId,
            name: 'Holdings',
            kind: 'holdings',
            is_default: true,
            default_kind: 'holdings'
          }
        });
      }
    }

    // Save thesis if provided
    if (thesis && thesis.ticker && thesis.thesis_text) {
      // Ensure the ticker is in the journal so we can add an entry
      const jt = await prisma.journalTicker.upsert({
        where: { journal_id_ticker: { journal_id: journal.id, ticker: thesis.ticker } },
        create: { journal_id: journal.id, ticker: thesis.ticker, source: mode === 'import' ? 'holdings_sync' : 'manual' },
        update: {}
      });

      await prisma.journalEntry.create({
        data: {
          journal_ticker_id: jt.id,
          dimension: thesis.dimension,
          sub_factors: thesis.sub_factors || [],
          thesis: thesis.thesis_text,
          conviction: thesis.conviction,
        }
      });
    }

    // Mark profile as onboarded
    await prisma.userProfile.update({
      where: { user_id: userId },
      data: {
        onboarding_completed: true,
        onboarding_step: 'done'
      }
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  completeOnboarding
};
