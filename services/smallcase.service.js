'use strict';

const prisma          = require('../config/prisma');
const { encrypt, decrypt } = require('../utils/crypto');

async function storeAuth(userId, { auth_token, broker, broker_client_id, smallcase_user_id }) {
  if (!auth_token) {
    const err = new Error('auth_token is required');
    err.status = 400;
    throw err;
  }

  const encryptedToken = encrypt(auth_token);

  const scUser = await prisma.smallcaseUser.upsert({
    where:  { user_id: userId },
    create: {
      user_id:          userId,
      auth_token:       encryptedToken,
      broker:           broker || null,
      broker_client_id: broker_client_id || null,
      smallcase_user_id: smallcase_user_id || null,
      is_connected:     true,
    },
    update: {
      auth_token:       encryptedToken,
      broker:           broker || undefined,
      broker_client_id: broker_client_id || undefined,
      smallcase_user_id: smallcase_user_id || undefined,
      is_connected:     true,
    },
  });

  return {
    is_connected:  scUser.is_connected,
    broker:        scUser.broker,
    last_synced_at: scUser.last_synced_at,
  };
}

async function syncHoldings(userId) {
  const scUser = await prisma.smallcaseUser.findUnique({ where: { user_id: userId } });
  if (!scUser || !scUser.is_connected) {
    const err = new Error('Smallcase account not connected');
    err.status = 400;
    throw err;
  }

  // Decrypt stored token for Smallcase API usage
  // const authToken = decrypt(scUser.auth_token);

  // TODO: Call Smallcase SDK/API here with authToken
  // const smallcaseClient = new SmallcaseGateway({ authToken });
  // const holdings = await smallcaseClient.getHoldings();
  // For now, this is a stub that accepts externally-provided holdings data
  const holdings = [];

  const now = new Date();

  if (holdings.length > 0) {
    for (const h of holdings) {
      await prisma.smallcaseHolding.upsert({
        where:  { smallcase_user_id_ticker: { smallcase_user_id: scUser.id, ticker: h.ticker } },
        create: {
          smallcase_user_id: scUser.id,
          ticker:            h.ticker,
          quantity:          h.quantity,
          avg_price:         h.avg_price,
          current_price:     h.current_price || null,
          current_value:     h.current_value || null,
          invested_value:    h.invested_value,
          pnl:               h.pnl || null,
          pnl_pct:           h.pnl_pct || null,
          exchange:          h.exchange || null,
          isin:              h.isin || null,
        },
        update: {
          quantity:      h.quantity,
          avg_price:     h.avg_price,
          current_price: h.current_price || null,
          current_value: h.current_value || null,
          invested_value: h.invested_value,
          pnl:           h.pnl || null,
          pnl_pct:       h.pnl_pct || null,
        },
      });
    }

    const totalValue    = holdings.reduce((s, h) => s + (h.current_value || 0), 0);
    const totalInvested = holdings.reduce((s, h) => s + h.invested_value, 0);
    const totalPnl      = totalValue - totalInvested;
    const totalPnlPct   = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    await prisma.smallcasePortfolio.upsert({
      where:  { smallcase_user_id: scUser.id },
      create: { smallcase_user_id: scUser.id, total_value: totalValue, total_invested: totalInvested, total_pnl: totalPnl, total_pnl_pct: totalPnlPct, synced_at: now },
      update: { total_value: totalValue, total_invested: totalInvested, total_pnl: totalPnl, total_pnl_pct: totalPnlPct, synced_at: now },
    });
  }

  await prisma.smallcaseUser.update({
    where: { id: scUser.id },
    data:  { last_synced_at: now },
  });

  return { holdings_synced: holdings.length, synced_at: now };
}

async function getHoldings(userId) {
  const scUser = await prisma.smallcaseUser.findUnique({
    where:   { user_id: userId },
    include: { holdings: true, portfolio: true },
  });

  if (!scUser || !scUser.is_connected) {
    const err = new Error('Smallcase account not connected');
    err.status = 404;
    throw err;
  }

  return {
    portfolio: scUser.portfolio
      ? {
          total_value:    scUser.portfolio.total_value,
          total_invested: scUser.portfolio.total_invested,
          total_pnl:      scUser.portfolio.total_pnl,
          total_pnl_pct:  scUser.portfolio.total_pnl_pct,
          synced_at:      scUser.portfolio.synced_at,
        }
      : null,
    holdings: scUser.holdings,
  };
}

async function getOrders(userId, { status, page = 1, limit = 20 } = {}) {
  const scUser = await prisma.smallcaseUser.findUnique({ where: { user_id: userId } });
  if (!scUser) {
    const err = new Error('Smallcase account not connected');
    err.status = 404;
    throw err;
  }

  const where = { smallcase_user_id: scUser.id };
  if (status) where.status = status;

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    prisma.smallcaseOrder.findMany({ where, orderBy: { placed_at: 'desc' }, skip, take: limit }),
    prisma.smallcaseOrder.count({ where }),
  ]);

  return { orders, total, page, limit };
}

module.exports = { storeAuth, syncHoldings, getHoldings, getOrders };
