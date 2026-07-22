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

async function _assertKpiGroupExists(slug) {
  if (!slug) return;
  const exists = await prisma.kpiGroup.findUnique({ where: { slug }, select: { slug: true } });
  if (!exists) throw new HttpError(422, `kpi_group_slug "${slug}" does not exist.`);
}

async function _assertScreenConfigExists(key) {
  if (!key) return;
  const exists = await prisma.screenConfig.findUnique({ where: { key }, select: { key: true } });
  if (!exists) throw new HttpError(422, `variant_of_key "${key}" does not reference an existing ScreenConfig.`);
}

// variant_of_key and company_group_slug are a pair -- a variant with no
// company group to gate on (or a company_group_slug with nothing marking it
// as a variant) is ambiguous, so both must be set or both left null.
function _assertVariantPairing(variant_of_key, company_group_slug) {
  if (Boolean(variant_of_key) !== Boolean(company_group_slug)) {
    throw new HttpError(422, 'variant_of_key and company_group_slug must be set together (or both omitted).');
  }
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

async function createScreenConfig({ key, label, endpoint, periods_shown, decimal_places, kpi_group_slug, variant_of_key, company_group_slug }) {
  const existing = await prisma.screenConfig.findUnique({ where: { key } });
  if (existing) throw new HttpError(409, `ScreenConfig with key "${key}" already exists.`);
  await _assertKpiGroupExists(kpi_group_slug);
  _assertVariantPairing(variant_of_key, company_group_slug);
  await _assertScreenConfigExists(variant_of_key);
  await _assertCompanyGroupExists(company_group_slug);

  return prisma.screenConfig.create({
    data: {
      key,
      label,
      endpoint: endpoint ?? null,
      periods_shown: periods_shown ?? null,
      decimal_places: decimal_places ?? 2,
      kpi_group_slug: kpi_group_slug ?? null,
      variant_of_key: variant_of_key ?? null,
      company_group_slug: company_group_slug ?? null,
    },
  });
}

async function updateScreenConfig(key, patch) {
  const existing = await prisma.screenConfig.findUnique({ where: { key } });
  if (!existing) throw new HttpError(404, `No ScreenConfig with key "${key}".`);
  if ('kpi_group_slug' in patch) await _assertKpiGroupExists(patch.kpi_group_slug);

  const nextVariantOfKey     = 'variant_of_key' in patch ? patch.variant_of_key : existing.variant_of_key;
  const nextCompanyGroupSlug = 'company_group_slug' in patch ? patch.company_group_slug : existing.company_group_slug;
  _assertVariantPairing(nextVariantOfKey, nextCompanyGroupSlug);
  if ('variant_of_key' in patch) await _assertScreenConfigExists(patch.variant_of_key);
  if ('company_group_slug' in patch) await _assertCompanyGroupExists(patch.company_group_slug);

  const data = {};
  for (const field of ['label', 'endpoint', 'periods_shown', 'decimal_places', 'kpi_group_slug', 'variant_of_key', 'company_group_slug']) {
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
