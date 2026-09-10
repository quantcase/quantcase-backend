'use strict';

const XLSX   = require('xlsx');
const prisma = require('../../config/prisma');

function toCsvString(rows) {
  if (!rows || rows.length === 0) return '';
  const sheet = XLSX.utils.json_to_sheet(rows);
  return XLSX.utils.sheet_to_csv(sheet);
}

function toXlsxBuffer(rows, sheetName = 'Export') {
  const workbook = XLSX.utils.book_new();
  const sheet    = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function exportClients(orgId, wealthRole = null, rmProfileId = null, format = 'csv') {
  const where = { org_id: orgId };
  if (wealthRole === 'rm' && rmProfileId) {
    where.rm_profile_id = rmProfileId;
  }

  const clients = await prisma.wealthClient.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      rm: {
        select: { display_name: true, team: true },
      },
      portfolio: {
        select: { total_value_cr: true, risk_score: true },
      },
    },
  });

  const exportRows = clients.map((c) => ({
    'Client ID':        c.id,
    'Name':             c.name,
    'Email':            c.email || '',
    'Phone':            c.phone || '',
    'City':             c.city || '',
    'Segment':          c.segment,
    'Risk Profile':     c.risk_profile,
    'Lifecycle Status': c.lifecycle_status,
    'KYC Status':       c.kyc_status,
    'AUM (₹ Cr)':       c.aum_cr || c.portfolio?.total_value_cr || 0,
    'Portfolio Risk':   c.portfolio?.risk_score ?? '',
    'Assigned RM':      c.rm?.display_name || 'Unassigned',
    'RM Desk':          c.rm?.team || '',
    'Tags':             (c.tags || []).join(', '),
    'Created At':       c.created_at.toISOString().slice(0, 10),
  }));

  if (format === 'xlsx') {
    return {
      buffer:      toXlsxBuffer(exportRows, 'Clients'),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename:    `clients_export_${new Date().toISOString().slice(0, 10)}.xlsx`,
    };
  }

  return {
    content:     toCsvString(exportRows),
    contentType: 'text/csv',
    filename:    `clients_export_${new Date().toISOString().slice(0, 10)}.csv`,
  };
}

async function exportHoldings(orgId, wealthRole = null, rmProfileId = null, format = 'csv') {
  const where = { org_id: orgId };
  if (wealthRole === 'rm' && rmProfileId) {
    where.rm_profile_id = rmProfileId;
  }

  const clients = await prisma.wealthClient.findMany({
    where,
    include: {
      rm: {
        select: { display_name: true },
      },
      portfolio: {
        include: {
          holdings: {
            include: { alerts: { where: { is_resolved: false } } },
          },
        },
      },
    },
  });

  const exportRows = [];
  for (const c of clients) {
    const holdings = c.portfolio?.holdings || [];
    for (const h of holdings) {
      exportRows.push({
        'Client Name':      c.name,
        'Assigned RM':      c.rm?.display_name || '',
        'Ticker / Scheme':  h.ticker || h.scheme_name || 'Asset',
        'Asset Class':      h.asset_class,
        'ISIN':             h.isin || '',
        'Quantity':         h.quantity ?? '',
        'Avg Price (₹)':    h.avg_price ?? '',
        'Current Value (₹ Cr)': h.current_value_cr ?? '',
        'Weight (%)':       h.weight_pct ?? '',
        'As of Date':       h.as_of_date ? h.as_of_date.toISOString().slice(0, 10) : '',
        'Active Alerts':    h.alerts?.map(a => `${a.alert_type} (${a.severity})`).join('; ') || 'None',
      });
    }
  }

  if (format === 'xlsx') {
    return {
      buffer:      toXlsxBuffer(exportRows, 'Holdings'),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename:    `holdings_export_${new Date().toISOString().slice(0, 10)}.xlsx`,
    };
  }

  return {
    content:     toCsvString(exportRows),
    contentType: 'text/csv',
    filename:    `holdings_export_${new Date().toISOString().slice(0, 10)}.csv`,
  };
}

module.exports = { exportClients, exportHoldings };
