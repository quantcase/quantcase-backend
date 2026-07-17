'use strict';

const { resolveGroup, invalidateGroupCache, resolveConfigKeyForTicker } = require('./resolver');
const { listGroups, getGroup, createGroup, updateGroup, deleteGroup, resolveGroupBySlug } = require('./groups.service');
const { listAttachedFilters, attachFilter, detachFilter, recomputeGroup } = require('./filters.service');

module.exports = {
  resolveGroup,
  invalidateGroupCache,
  resolveConfigKeyForTicker,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  resolveGroupBySlug,
  listAttachedFilters,
  attachFilter,
  detachFilter,
  recomputeGroup,
};
