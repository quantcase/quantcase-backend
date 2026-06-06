'use strict';

const prisma        = require('../../config/prisma');
const { enrichHoldings } = require('./market-data.service');

async function getShadowPortfolio(userId) {
  const portfolio = await prisma.shadowPortfolio.findUnique({
    where:   { user_id: userId },
    include: {
      holdings: {
        include: { notes: { orderBy: { created_at: 'desc' } } },
        orderBy: { invested_at: 'desc' },
      },
    },
  });

  if (!portfolio) {
    return { user_id: userId, holdings: [] };
  }

  const tickers    = [...new Set(portfolio.holdings.map(h => h.ticker))];
  const marketData = await enrichHoldings(tickers);

  return {
    ...portfolio,
    holdings: portfolio.holdings.map(h => ({
      ...h,
      market_data: marketData[h.ticker] ?? null,
    })),
  };
}

async function addHoldingToShadow(userId, { ticker }) {
  const portfolio = await prisma.shadowPortfolio.upsert({
    where:  { user_id: userId },
    update: { updated_at: new Date() },
    create: { user_id: userId },
  });

  return prisma.holding.create({
    data: {
      ticker:              ticker.toUpperCase().trim(),
      amount_invested:     0,
      invested_at:         new Date(),
      shadow_portfolio_id: portfolio.id,
    },
  });
}

async function updateHolding(holdingId, userId, data) {
  await assertHoldingOwnership(holdingId, userId);

  return prisma.holding.update({
    where: { id: holdingId },
    data:  {
      ...(data.ticker            && { ticker:          data.ticker.toUpperCase().trim() }),
      ...(data.amount_invested !== undefined && { amount_invested: data.amount_invested }),
      ...(data.invested_at       && { invested_at:     new Date(data.invested_at) }),
    },
  });
}

async function deleteHolding(holdingId, userId) {
  await assertHoldingOwnership(holdingId, userId);
  await prisma.holding.delete({ where: { id: holdingId } });
}

async function assertHoldingOwnership(holdingId, userId) {
  const holding = await prisma.holding.findFirst({
    where: {
      id: holdingId,
      OR: [
        { user_portfolio:   { user_id: userId } },
        { shadow_portfolio: { user_id: userId } },
      ],
    },
  });
  if (!holding) {
    const e = new Error('Holding not found or access denied');
    e.status = 404;
    throw e;
  }
  return holding;
}

module.exports = { getShadowPortfolio, addHoldingToShadow, updateHolding, deleteHolding };
