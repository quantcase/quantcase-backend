'use strict';

const { parse } = require('csv-parse/sync');
const XLSX      = require('xlsx');
const prisma    = require('../../config/prisma');

const VALID_SEGMENTS     = ['HNI', 'UHNI', 'Retail', 'Institutional', 'Private'];
const VALID_RISK_PROFILES = ['conservative', 'moderate', 'aggressive'];
const VALID_STATUSES     = ['prospect', 'onboarding', 'active', 'dormant', 'churned'];
const VALID_ASSET_CLASSES = [
  'equity', 'debt', 'mutual_fund', 'etf', 'pms', 'aif',
  'reit', 'real_estate', 'gold', 'cash', 'other'
];

function parseFileToRows(buffer, originalname) {
  const ext = (originalname || '').toLowerCase().split('.').pop();

  if (ext === 'csv') {
    const text = buffer.toString('utf-8');
    return parse(text, {
      columns:          true,
      skip_empty_lines: true,
      trim:             true,
    });
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const workbook  = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet     = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet);
  }

  throw new Error('Unsupported file format. Please upload a .csv or .xlsx file.');
}

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function normalizeRow(row) {
  const normalized = {};
  for (const [k, v] of Object.entries(row)) {
    normalized[normalizeKey(k)] = typeof v === 'string' ? v.trim() : v;
  }
  return normalized;
}

function validateClientRows(rows) {
  const valid = [];
  const errors = [];

  rows.forEach((rawRow, idx) => {
    const row = normalizeRow(rawRow);
    const rowNum = idx + 2; // header is row 1
    const rowErrors = [];

    const name = row.name || row.client_name || row.full_name;
    if (!name) rowErrors.push('Missing client name');

    let segment = row.segment || 'HNI';
    if (!VALID_SEGMENTS.includes(segment)) {
      // Try loose matching
      const found = VALID_SEGMENTS.find(s => s.toLowerCase() === String(segment).toLowerCase());
      if (found) segment = found;
      else rowErrors.push(`Invalid segment '${segment}'. Allowed: ${VALID_SEGMENTS.join(', ')}`);
    }

    let riskProfile = (row.risk_profile || row.risk || 'moderate').toLowerCase();
    if (!VALID_RISK_PROFILES.includes(riskProfile)) {
      rowErrors.push(`Invalid risk profile '${riskProfile}'. Allowed: ${VALID_RISK_PROFILES.join(', ')}`);
    }

    const aum = parseFloat(row.aum_cr || row.aum || 0) || 0;

    if (rowErrors.length > 0) {
      errors.push({ row: rowNum, errors: rowErrors, data: row });
    } else {
      valid.push({
        name,
        email:            row.email || null,
        phone:            row.phone || row.mobile || null,
        city:             row.city || null,
        pan_number:       row.pan_number || row.pan || null,
        aum_cr:           aum,
        segment,
        risk_profile:     riskProfile,
        lifecycle_status: VALID_STATUSES.includes(row.lifecycle_status) ? row.lifecycle_status : 'prospect',
        tags:             row.tags ? String(row.tags).split(',').map(t => t.trim()).filter(Boolean) : [],
      });
    }
  });

  return { valid, errors, total: rows.length };
}

async function previewImport(buffer, originalname, entityType) {
  const rawRows = parseFileToRows(buffer, originalname);
  if (entityType === 'clients') {
    const validation = validateClientRows(rawRows);
    return {
      total_rows:   validation.total,
      valid_rows:   validation.valid.length,
      error_rows:   validation.errors.length,
      errors:       validation.errors.slice(0, 50),
      sample_valid: validation.valid.slice(0, 5),
    };
  }

  throw new Error(`Preview for entity type '${entityType}' is not yet supported`);
}

async function executeClientImport(orgId, buffer, originalname, memberId, wealthRole, rmProfileId) {
  const rawRows = parseFileToRows(buffer, originalname);
  const { valid, errors, total } = validateClientRows(rawRows);

  if (valid.length === 0) {
    throw new Error('No valid client records found in uploaded file');
  }

  // Create WealthDataImport record tracking this job
  const importLog = await prisma.wealthDataImport.create({
    data: {
      org_id:       orgId,
      initiated_by: memberId,
      entity_type:  'clients',
      file_name:    originalname,
      status:       'processing',
      total_rows:   total,
    },
  });

  try {
    const clientsToCreate = valid.map(c => ({
      ...c,
      org_id:        orgId,
      rm_profile_id: wealthRole === 'rm' ? rmProfileId : null,
    }));

    await prisma.$transaction(async (tx) => {
      // Bulk insert clients
      await tx.wealthClient.createMany({
        data: clientsToCreate,
      });

      // If RM uploaded, update RM's total AUM
      if (wealthRole === 'rm' && rmProfileId) {
        const rmClientsAum = await tx.wealthClient.aggregate({
          where: { rm_profile_id: rmProfileId, org_id: orgId },
          _sum:  { aum_cr: true },
        });
        await tx.wealthRmProfile.update({
          where: { id: rmProfileId },
          data:  { total_aum_cr: rmClientsAum._sum.aum_cr || 0 },
        });
      }
    });

    const status = errors.length > 0 ? 'completed_with_errors' : 'completed';
    await prisma.wealthDataImport.update({
      where: { id: importLog.id },
      data: {
        status,
        success_rows: valid.length,
        error_rows:   errors.length,
        errors:       errors.length > 0 ? errors.slice(0, 100) : undefined,
        completed_at: new Date(),
      },
    });

    return {
      import_id:    importLog.id,
      status,
      total_rows:   total,
      success_rows: valid.length,
      error_rows:   errors.length,
      errors:       errors.slice(0, 20),
    };
  } catch (err) {
    await prisma.wealthDataImport.update({
      where: { id: importLog.id },
      data: {
        status:       'failed',
        error_rows:   total,
        errors:       [{ message: err.message }],
        completed_at: new Date(),
      },
    });
    throw err;
  }
}

async function listImportHistory(orgId) {
  return prisma.wealthDataImport.findMany({
    where:   { org_id: orgId },
    orderBy: { created_at: 'desc' },
    take:    20,
  });
}

module.exports = {
  parseFileToRows,
  previewImport,
  executeClientImport,
  listImportHistory,
};
