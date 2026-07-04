'use strict';

const { resolveGroup, resolveConfigKeyForTicker } = require('./resolver');
const { listGroups, getGroup, createGroup, updateGroup, deleteGroup, resolveGroupBySlug } = require('./groups.service');

module.exports = {
  resolveGroup,
  resolveConfigKeyForTicker,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  resolveGroupBySlug,
};
