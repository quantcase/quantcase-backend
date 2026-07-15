'use strict';

const prisma  = require('../config/prisma');
const gateway = require('../lib/smallcaseGateway');
const env     = require('../config/env');
const { encrypt } = require('../utils/crypto');
const { enrichHoldings } = require('./portfolio/market-data.service');

// ─── Helpers ────────────────────────────────────────────────────────────────

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Populate the user's default "Holdings" journal (add-only) from the freshly
// synced smallcase holdings + baskets. Non-fatal: a journal failure must never
// break the smallcase connect / webhook flow. Lazy require avoids a require cycle
// (holdings-sync → journal.service, neither of which needs smallcase.service).
async function syncHoldingsJournalSafe(userId) {
  try {
    const { syncHoldingsJournal } = require('./journal/holdings-sync.service');
    await syncHoldingsJournal(userId);
  } catch (e) {
    console.error('[smallcase] holdings-journal sync failed:', e.message);
  }
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
//
// The real v2 payload nests quantity/avg price under `holdings` and identifies the
// security by `nseTicker`/`bseTicker` (there is no flat `ticker` field). It also
// carries no live price, so current_price / current_value / pnl are null from this
// endpoint and get filled in later by the market-data enrichment path.
function mapSecurity(s) {
  const ticker   = s.ticker ?? s.nseTicker ?? s.bseTicker ?? null;
  const exchange = s.exchange ?? (s.nseTicker ? 'NSE' : s.bseTicker ? 'BSE' : null);
  const quantity = s.quantity ?? s.holdings?.quantity ?? 0;
  const avgPrice = s.averagePrice ?? s.holdings?.averagePrice ?? 0;
  const ltp      = s.ltp ?? s.lastPrice ?? s.currentPrice ?? null;
  const investedValue = quantity * avgPrice;
  const currentValue  = ltp != null ? quantity * ltp : null;
  const pnl     = currentValue != null ? currentValue - investedValue : null;
  const pnlPct  = pnl != null && investedValue > 0 ? (pnl / investedValue) * 100 : null;
  return {
    ticker,
    quantity,
    avg_price:      avgPrice,
    current_price:  ltp,
    current_value:  currentValue,
    invested_value: investedValue,
    pnl,
    pnl_pct:        pnlPct,
    exchange,
    isin:           s.isin || null,
    // ─── Full payload fidelity ──────────────────────────────────────────────
    name:                  s.name || null,
    nse_ticker:            s.nseTicker || null,
    bse_ticker:            s.bseTicker || null,
    collateral_quantity:   s.collateralQuantity ?? null,
    transactable_quantity: s.transactableQuantity ?? null,
    smallcase_quantity:    s.smallcaseQuantity ?? null,
    nse_quantity:          s.positions?.nse?.quantity ?? null,
    nse_avg_price:         s.positions?.nse?.averagePrice ?? null,
    bse_quantity:          s.positions?.bse?.quantity ?? null,
    bse_avg_price:         s.positions?.bse?.averagePrice ?? null,
    suspended_nse:         s.isSuspendedOrDelistedOnNSE ?? null,
    suspended_bse:         s.isSuspendedOrDelistedOnBSE ?? null,
  };
}

// Map a smallcase v2 `smallcases.public[]` basket entry → our SmallcaseBasket shape.
function mapBasket(b, { isPrivate = false } = {}) {
  return {
    scid:              b.scid,
    name:              b.name || null,
    short_description: b.shortDescription || null,
    investment_url:    b.investmentDetailsURL || null,
    image_url:         b.imageUrl || null,
    current_value:     b.stats?.currentValue ?? null,
    total_returns:     b.stats?.totalReturns ?? null,
    constituents:      Array.isArray(b.constituents) ? b.constituents : null,
    is_private:        isPrivate,
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

  // Baskets live under `smallcases.public[]` (and an optional `private[]`), each with
  // its own currentValue / totalReturns / constituents.
  const scGroups = data.smallcases || {};
  const baskets = [
    ...(Array.isArray(scGroups.public)  ? scGroups.public  : []).map((b) => mapBasket(b, { isPrivate: false })),
    ...(Array.isArray(scGroups.private) ? scGroups.private : []).map((b) => mapBasket(b, { isPrivate: true })),
  ].filter((b) => b.scid);

  const now = new Date();

  if (holdings.length > 0) {
    for (const h of holdings) {
      // Fields written on both create and update — everything the payload carries.
      const holdingData = {
        quantity:              h.quantity,
        avg_price:             h.avg_price,
        current_price:         h.current_price,
        current_value:         h.current_value,
        invested_value:        h.invested_value,
        pnl:                   h.pnl,
        pnl_pct:               h.pnl_pct,
        exchange:              h.exchange,
        isin:                  h.isin,
        name:                  h.name,
        nse_ticker:            h.nse_ticker,
        bse_ticker:            h.bse_ticker,
        collateral_quantity:   h.collateral_quantity,
        transactable_quantity: h.transactable_quantity,
        smallcase_quantity:    h.smallcase_quantity,
        nse_quantity:          h.nse_quantity,
        nse_avg_price:         h.nse_avg_price,
        bse_quantity:          h.bse_quantity,
        bse_avg_price:         h.bse_avg_price,
        suspended_nse:         h.suspended_nse,
        suspended_bse:         h.suspended_bse,
      };
      await prisma.smallcaseHolding.upsert({
        where:  { smallcase_user_id_ticker: { smallcase_user_id: scUser.id, ticker: h.ticker } },
        create: { smallcase_user_id: scUser.id, ticker: h.ticker, ...holdingData },
        update: holdingData,
      });
    }

    const totalInvested = holdings.reduce((s, h) => s + h.invested_value, 0);
    // This endpoint carries no live price, so most/all current_value are null. When we
    // have no market value at all, fall back to invested value so P&L reads as 0 rather
    // than a bogus -100%. Real current_value / P&L land once market-data enrichment runs.
    const havePrices    = holdings.some((h) => h.current_value != null);
    const totalValue    = havePrices
      ? holdings.reduce((s, h) => s + (h.current_value ?? h.invested_value), 0)
      : totalInvested;
    const totalPnl      = totalValue - totalInvested;
    const totalPnlPct   = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    await prisma.smallcasePortfolio.upsert({
      where:  { smallcase_user_id: scUser.id },
      create: { smallcase_user_id: scUser.id, total_value: totalValue, total_invested: totalInvested, total_pnl: totalPnl, total_pnl_pct: totalPnlPct, synced_at: now },
      update: { total_value: totalValue, total_invested: totalInvested, total_pnl: totalPnl, total_pnl_pct: totalPnlPct, synced_at: now },
    });
  }

  // Upsert the user's smallcase baskets (independent of the securities list above).
  for (const b of baskets) {
    const basketData = {
      name:              b.name,
      short_description: b.short_description,
      investment_url:    b.investment_url,
      image_url:         b.image_url,
      current_value:     b.current_value,
      total_returns:     b.total_returns,
      constituents:      b.constituents ?? undefined,
      is_private:        b.is_private,
    };
    await prisma.smallcaseBasket.upsert({
      where:  { smallcase_user_id_scid: { smallcase_user_id: scUser.id, scid: b.scid } },
      create: { smallcase_user_id: scUser.id, scid: b.scid, ...basketData },
      update: basketData,
    });
  }

  await prisma.smallcaseUser.update({
    where: { id: scUser.id },
    data:  { last_synced_at: now },
  });

  // Mirror the freshly-synced holdings into the user's default Holdings journal
  // (add-only, non-fatal). This is the single chokepoint for connect, webhook, and
  // manual POST /sync, so the journal stays current on every sync path.
  await syncHoldingsJournalSafe(userId);

  return { holdings_synced: holdings.length, baskets_synced: baskets.length, synced_at: now };
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

  const security = { ticker: scid, type: normalizedType.toUpperCase() };
  if (amount != null) security.amount = amount;

  const orderConfig = { type: 'SECURITIES', securities: [security] };

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
    include: { holdings: true, portfolio: true, baskets: true },
  });

  if (!scUser || !scUser.is_connected) {
    throw badRequest('Smallcase account not connected', 404);
  }

  // The broker lives on the SmallcaseUser (set at confirm time). All of a user's
  // smallcase holdings are held at that same broker, so attribute each row with it.
  const broker = scUser.broker || null;

  // The smallcase holdings endpoint carries no live price, so current_value/pnl are
  // stored null. Enrich here with live LTP (same market-data path the uploaded
  // portfolio uses) so the frontend gets real amounts instead of 0.
  const tickers    = [...new Set(scUser.holdings.map(h => h.ticker))];
  const marketData = await enrichHoldings(tickers);

  const holdings = scUser.holdings.map((h) => {
    const md           = marketData[h.ticker] ?? null;
    const ltp          = md?.ltp ?? h.current_price ?? null;
    const currentValue = ltp != null ? h.quantity * ltp : null;
    const pnl          = currentValue != null ? currentValue - h.invested_value : null;
    const pnlPct       = pnl != null && h.invested_value > 0 ? (pnl / h.invested_value) * 100 : null;
    // display_value is what the UI's amount column should render: live market value when
    // we have a price, else invested value (what was paid). Never null — never shows 0.
    const displayValue = currentValue ?? h.invested_value;
    return {
      ...h,
      broker,
      current_price:  ltp,
      current_value:  currentValue,
      pnl,
      pnl_pct:        pnlPct,
      display_value:  displayValue,
      has_live_price: ltp != null,
      market_data:    md,
    };
  });

  // Portfolio totals recomputed from the (now enriched) holdings so they agree with the
  // rows. Falls back to invested value for any ticker without a live price.
  const totalInvested = holdings.reduce((s, h) => s + (h.invested_value || 0), 0);
  const totalValue    = holdings.reduce((s, h) => s + (h.display_value  || 0), 0);
  const totalPnl      = totalValue - totalInvested;
  const totalPnlPct   = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  return {
    portfolio: {
      total_value:    totalValue,
      total_invested: totalInvested,
      total_pnl:      totalPnl,
      total_pnl_pct:  totalPnlPct,
      synced_at:      scUser.portfolio?.synced_at ?? scUser.last_synced_at ?? null,
    },
    holdings,
    baskets:  scUser.baskets,
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
