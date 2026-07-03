'use strict';

const { resolveGroup } = require('./resolver');
const { listGroups, getGroup, createGroup, updateGroup, deleteGroup, resolveGroupBySlug } = require('./groups.service');

module.exports = {
  resolveGroup,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  resolveGroupBySlug,
};
