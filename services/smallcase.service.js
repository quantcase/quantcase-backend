'use strict';

const prisma  = require('../config/prisma');
const gateway = require('../lib/smallcaseGateway');
const env     = require('../config/env');
const { encrypt } = require('../utils/crypto');

// ─── Helpers ────────────────────────────────────────────────────────────────

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Map a smallcase transaction/order status → our SmallcaseOrderStatus enum.
function mapOrderStatus(scStatus) {
  switch (String(scStatus || '').toUpperCase()) {
    case 'COMPLETED':
    case 'COMPLETE':  return 'completed';
    case 'PLACED':    return 'placed';
    case 'ERRORED':
    case 'FAILED':    return 'failed';
    case 'CANCELLED':
    case 'CANCELED':  return 'cancelled';
    default:          return 'pending';
  }
}

// Map a smallcase v2 securities entry → our SmallcaseHolding shape.
function mapSecurity(s) {
  const quantity = s.quantity ?? s.holdings?.quantity ?? 0;
  const avgPrice = s.averagePrice ?? s.holdings?.averagePrice ?? 0;
  const ltp      = s.ltp ?? s.lastPrice ?? s.currentPrice ?? null;
  const investedValue = quantity * avgPrice;
  const currentValue  = ltp != null ? quantity * ltp : null;
  const pnl     = currentValue != null ? currentValue - investedValue : null;
  const pnlPct  = pnl != null && investedValue > 0 ? (pnl / investedValue) * 100 : null;
  return {
    ticker:         s.ticker,
    quantity,
    avg_price:      avgPrice,
    current_price:  ltp,
    current_value:  currentValue,
    invested_value: investedValue,
    pnl,
    pnl_pct:        pnlPct,
    exchange:       s.exchange || null,
    isin:           s.isin || null,
  };
}

// ─── Connect flow ───────────────────────────────────────────────────────────

/**
 * Create a HOLDINGS_IMPORT transaction so the user can connect their broker.
 * Returns { transactionId, gateway, expireAt } for the frontend Gateway SDK to run.
 */
async function createConnect(userId, { intent = 'HOLDINGS_IMPORT' } = {}) {
  const config = intent === 'HOLDINGS_IMPORT' ? { assetConfig: { mfHoldings: true } } : {};
  const txn = await gateway.createTransaction(intent, config);

  // Ensure a SmallcaseUser row exists (still disconnected until confirmed).
  await prisma.smallcaseUser.upsert({
    where:  { user_id: userId },
    create: { user_id: userId, is_connected: false },
    update: {},
  });

  // The frontend Gateway SDK needs a signed JWT to initialize. For the connect
  // flow the user is not yet connected, so we sign a guest token ({ guest: true }).
  const smallcaseAuthToken = gateway.signAuthToken();

  return {
    transactionId:      txn.transactionId,
    smallcaseAuthToken,
    gateway:            env.smallcaseGatewayName,
    expireAt:           txn.expireAt,
    intent,
  };
}

/**
 * Confirm a completed transaction: fetch its result, persist the connected user's
 * smallcaseAuthId + broker, mark connected, and sync holdings.
 */
async function confirmTransaction(userId, transactionId) {
  if (!transactionId) throw badRequest('transactionId is required');

  const details = await gateway.fetchTransactionDetails(transactionId);
  const status  = String(details.status || '').toUpperCase();

  if (status === 'PROCESSING' || status === 'INITIALIZED') {
    return { status: status.toLowerCase(), transactionId };
  }
  if (status === 'ERRORED') {
    throw badRequest(details.error?.message || 'Smallcase transaction errored', 422);
  }
  if (status !== 'COMPLETED') {
    throw badRequest(`Unexpected transaction status: ${details.status}`, 422);
  }

  const smallcaseAuthId = details.smallcaseAuthId || details.smallcaseAuthToken || details.userId;
  if (!smallcaseAuthId) {
    throw badRequest('Transaction completed but no smallcaseAuthId was returned', 502);
  }

  await prisma.smallcaseUser.upsert({
    where:  { user_id: userId },
    create: {
      user_id:           userId,
      smallcase_user_id: smallcaseAuthId,
      auth_token:        details.authToken ? encrypt(details.authToken) : null,
      broker:            details.broker || null,
      is_connected:      true,
    },
    update: {
      smallcase_user_id: smallcaseAuthId,
      auth_token:        details.authToken ? encrypt(details.authToken) : undefined,
      broker:            details.broker || undefined,
      is_connected:      true,
    },
  });

  const sync = await syncHoldings(userId);
  return { is_connected: true, broker: details.broker || null, ...sync };
}

// ─── Holdings sync ──────────────────────────────────────────────────────────

async function syncHoldings(userId) {
  const scUser = await prisma.smallcaseUser.findUnique({ where: { user_id: userId } });
  if (!scUser || !scUser.is_connected || !scUser.smallcase_user_id) {
    throw badRequest('Smallcase account not connected');
  }

  const data = await gateway.fetchHoldings(scUser.smallcase_user_id);
  const securities = data.securities || [];
  const holdings = securities.map(mapSecurity).filter((h) => h.ticker);

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
          current_price:     h.current_price,
          current_value:     h.current_value,
          invested_value:    h.invested_value,
          pnl:               h.pnl,
          pnl_pct:           h.pnl_pct,
          exchange:          h.exchange,
          isin:              h.isin,
        },
        update: {
          quantity:       h.quantity,
          avg_price:      h.avg_price,
          current_price:  h.current_price,
          current_value:  h.current_value,
          invested_value: h.invested_value,
          pnl:            h.pnl,
          pnl_pct:        h.pnl_pct,
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

// ─── Orders ─────────────────────────────────────────────────────────────────

const ORDER_TYPES = new Set(['buy', 'sell', 'rebalance', 'sip']);

/**
 * Create a smallcase order (BUY/SELL/rebalance) transaction. Returns { transactionId }
 * for the frontend SDK to run; records a pending SmallcaseOrder.
 */
async function createOrder(userId, { type, scid, smallcaseName, amount } = {}) {
  const normalizedType = String(type || '').toLowerCase();
  if (!ORDER_TYPES.has(normalizedType)) {
    throw badRequest(`type must be one of: ${[...ORDER_TYPES].join(', ')}`);
  }
  if (!scid) throw badRequest('scid (smallcase id) is required');

  const scUser = await prisma.smallcaseUser.findUnique({ where: { user_id: userId } });
  if (!scUser || !scUser.is_connected || !scUser.smallcase_user_id) {
    throw badRequest('Smallcase account not connected');
  }

  const orderConfig = { type: normalizedType.toUpperCase(), scid };
  if (amount != null) orderConfig.amount = amount;

  const txn = await gateway.createTransaction('TRANSACTION', { orderConfig }, scUser.smallcase_user_id);

  await prisma.smallcaseOrder.create({
    data: {
      smallcase_user_id: scUser.id,
      order_id:          txn.transactionId,
      status:            'pending',
      type:              normalizedType,
      amount:            amount != null ? Number(amount) : null,
      smallcase_name:    smallcaseName || null,
      metadata:          { scid },
      placed_at:         new Date(),
    },
  });

  // The frontend Gateway SDK needs a signed JWT to run this transaction. The user
  // is connected here, so we sign a connected token ({ smallcaseAuthId }).
  const smallcaseAuthToken = gateway.signAuthToken({ smallcaseAuthId: scUser.smallcase_user_id });

  return {
    transactionId:      txn.transactionId,
    smallcaseAuthToken,
    gateway:            env.smallcaseGatewayName,
    expireAt:           txn.expireAt,
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

async function getHoldings(userId) {
  const scUser = await prisma.smallcaseUser.findUnique({
    where:   { user_id: userId },
    include: { holdings: true, portfolio: true },
  });

  if (!scUser || !scUser.is_connected) {
    throw badRequest('Smallcase account not connected', 404);
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
    throw badRequest('Smallcase account not connected', 404);
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

// ─── Webhook ────────────────────────────────────────────────────────────────

/**
 * Handle a verified smallcase webhook payload. Verifies the checksum, then updates
 * the matching order and/or re-syncs holdings for the affected user.
 * Returns false if the checksum is invalid (controller responds 400).
 */
async function handleWebhook(payload) {
  const { timestamp, smallcaseAuthId, transactionId, checksum, status } = payload;
  const isMf = payload.intent === 'MF_HOLDINGS_IMPORT';

  const valid = gateway.verifyWebhookChecksum(
    { timestamp, smallcaseAuthId, transactionId },
    checksum,
    { mf: isMf },
  );
  if (!valid) return false;

  const mappedStatus = mapOrderStatus(status);

  // Update the order this transaction created, if any.
  if (transactionId) {
    const order = await prisma.smallcaseOrder.findUnique({ where: { order_id: transactionId } });
    if (order) {
      await prisma.smallcaseOrder.update({
        where: { id: order.id },
        data: {
          status:       mappedStatus,
          completed_at: mappedStatus === 'completed' ? new Date() : order.completed_at,
          metadata:     { ...(order.metadata || {}), webhook: payload },
        },
      });
    }
  }

  // On a completed/holdings-import event, re-sync holdings for the connected user.
  if (smallcaseAuthId && (mappedStatus === 'completed' || /HOLDINGS_IMPORT/i.test(payload.intent || ''))) {
    const scUser = await prisma.smallcaseUser.findFirst({ where: { smallcase_user_id: smallcaseAuthId } });
    if (scUser && scUser.is_connected) {
      try {
        await syncHoldings(scUser.user_id);
      } catch (e) {
        // Non-fatal: webhook is still acknowledged; sync can be retried via POST /sync.
        console.error('[smallcase] webhook holdings re-sync failed:', e.message);
      }
    }
  }

  return true;
}

module.exports = {
  createConnect,
  confirmTransaction,
  syncHoldings,
  createOrder,
  getHoldings,
  getOrders,
  handleWebhook,
};
