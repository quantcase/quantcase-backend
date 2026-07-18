'use strict';

/**
 * Admin CRUD for ScreenConfig/ScreenConfigItem — which metrics/rows/series/
 * columns a given API response section shows, in what order, with what
 * precision. Decoupled from KpiGroup (see prisma/schema.prisma's
 * ScreenConfig docblock) — its own mechanism so it can eventually cover
 * config for any controller's response shape, not just KPI display grouping.
 */

const prisma = require('../config/prisma');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function _assertKpiExists(abbr) {
  const exists = await prisma.kpi.findUnique({ where: { abbr }, select: { abbr: true } });
  if (!exists) throw new HttpError(422, `kpi_abbr "${abbr}" does not exist.`);
}

async function _assertCompanyGroupExists(slug) {
  if (!slug) return;
  const exists = await prisma.companyGroup.findUnique({ where: { slug }, select: { slug: true } });
  if (!exists) throw new HttpError(422, `company_group_slug "${slug}" does not exist.`);
}

// ── ScreenConfig ─────────────────────────────────────────────────────────────

async function listScreenConfigs({ search } = {}) {
  return prisma.screenConfig.findMany({
    where: search
      ? { OR: [{ key: { contains: search, mode: 'insensitive' } }, { label: { contains: search, mode: 'insensitive' } }] }
      : {},
    orderBy: { key: 'asc' },
  });
}

async function getScreenConfig(key) {
  const config = await prisma.screenConfig.findUnique({
    where: { key },
    include: { items: { orderBy: { display_order: 'asc' } } },
  });
  if (!config) throw new HttpError(404, `No ScreenConfig with key "${key}".`);
  return config;
}

async function createScreenConfig({ key, label, endpoint, periods_shown, decimal_places }) {
  const existing = await prisma.screenConfig.findUnique({ where: { key } });
  if (existing) throw new HttpError(409, `ScreenConfig with key "${key}" already exists.`);

  return prisma.screenConfig.create({
    data: {
      key,
      label,
      endpoint: endpoint ?? null,
      periods_shown: periods_shown ?? null,
      decimal_places: decimal_places ?? 2,
    },
  });
}

async function updateScreenConfig(key, patch) {
  const existing = await prisma.screenConfig.findUnique({ where: { key } });
  if (!existing) throw new HttpError(404, `No ScreenConfig with key "${key}".`);

  const data = {};
  for (const field of ['label', 'endpoint', 'periods_shown', 'decimal_places']) {
    if (field in patch) data[field] = patch[field];
  }
  return prisma.screenConfig.update({ where: { key }, data });
}

async function deleteScreenConfig(key) {
  const existing = await prisma.screenConfig.findUnique({ where: { key } });
  if (!existing) throw new HttpError(404, `No ScreenConfig with key "${key}".`);
  // onDelete: Cascade on ScreenConfigItem takes care of its items.
  await prisma.screenConfig.delete({ where: { key } });
}

// ── ScreenConfigItem ─────────────────────────────────────────────────────────

async function addItem(key, { kpi_abbr, label, display_order, highlight, expandable, decimal_places, company_group_slug, series_type }) {
  const config = await prisma.screenConfig.findUnique({ where: { key } });
  if (!config) throw new HttpError(404, `No ScreenConfig with key "${key}".`);

  await _assertKpiExists(kpi_abbr);
  await _assertCompanyGroupExists(company_group_slug);

  const existing = await prisma.screenConfigItem.findUnique({
    where: { screen_config_id_kpi_abbr: { screen_config_id: config.id, kpi_abbr } },
  });
  if (existing) throw new HttpError(409, `"${kpi_abbr}" is already an item on "${key}".`);

  return prisma.screenConfigItem.create({
    data: {
      screen_config_id: config.id,
      kpi_abbr,
      label: label ?? null,
      display_order: display_order ?? 0,
      highlight: highlight ?? false,
      expandable: expandable ?? false,
      decimal_places: decimal_places ?? null,
      company_group_slug: company_group_slug ?? null,
      series_type: series_type ?? 'line',
    },
  });
}

async function updateItem(key, itemId, patch) {
  const config = await prisma.screenConfig.findUnique({ where: { key } });
  if (!config) throw new HttpError(404, `No ScreenConfig with key "${key}".`);

  const existing = await prisma.screenConfigItem.findUnique({ where: { id: itemId } });
  if (!existing || existing.screen_config_id !== config.id) {
    throw new HttpError(404, `No item "${itemId}" on "${key}".`);
  }

  if ('company_group_slug' in patch) await _assertCompanyGroupExists(patch.company_group_slug);

  const data = {};
  for (const field of ['label', 'display_order', 'highlight', 'expandable', 'decimal_places', 'company_group_slug', 'series_type']) {
    if (field in patch) data[field] = patch[field];
  }
  return prisma.screenConfigItem.update({ where: { id: itemId }, data });
}

async function removeItem(key, itemId) {
  const config = await prisma.screenConfig.findUnique({ where: { key } });
  if (!config) throw new HttpError(404, `No ScreenConfig with key "${key}".`);

  const existing = await prisma.screenConfigItem.findUnique({ where: { id: itemId } });
  if (!existing || existing.screen_config_id !== config.id) {
    throw new HttpError(404, `No item "${itemId}" on "${key}".`);
  }
  await prisma.screenConfigItem.delete({ where: { id: itemId } });
}

module.exports = {
  listScreenConfigs, getScreenConfig, createScreenConfig, updateScreenConfig, deleteScreenConfig,
  addItem, updateItem, removeItem,
  HttpError,
};
