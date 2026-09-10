'use strict';

const prisma = require('../../config/prisma');
const { writeAuditLog, getClientById } = require('./clients.service');

async function listNotes(orgId, clientId, wealthRole = null, rmProfileId = null) {
  await getClientById(orgId, clientId, wealthRole, rmProfileId);

  return prisma.wealthClientNote.findMany({
    where: {
      client_id: clientId,
      org_id:    orgId,
    },
    orderBy: [
      { is_pinned:  'desc' },
      { created_at: 'desc' },
    ],
  });
}

async function createNote(orgId, clientId, data, authorMemberId, wealthRole = null, rmProfileId = null) {
  await getClientById(orgId, clientId, wealthRole, rmProfileId);

  const note = await prisma.wealthClientNote.create({
    data: {
      org_id:           orgId,
      client_id:        clientId,
      author_member_id: authorMemberId,
      content:          data.content,
      is_pinned:        data.is_pinned || false,
    },
  });

  await writeAuditLog(orgId, 'client_note', note.id, 'created', rmProfileId, { clientId, is_pinned: note.is_pinned });
  return note;
}

async function updateNote(orgId, noteId, data, rmProfileId = null) {
  const existing = await prisma.wealthClientNote.findFirst({
    where: { id: noteId, org_id: orgId },
  });

  if (!existing) {
    const err = new Error('Note not found');
    err.status = 404;
    throw err;
  }

  const updateData = {};
  if (data.content !== undefined) updateData.content = data.content;
  if (data.is_pinned !== undefined) updateData.is_pinned = data.is_pinned;

  const updated = await prisma.wealthClientNote.update({
    where: { id: noteId },
    data:  updateData,
  });

  await writeAuditLog(orgId, 'client_note', noteId, 'updated', rmProfileId, updateData);
  return updated;
}

async function deleteNote(orgId, noteId, rmProfileId = null) {
  const existing = await prisma.wealthClientNote.findFirst({
    where: { id: noteId, org_id: orgId },
  });

  if (!existing) {
    const err = new Error('Note not found');
    err.status = 404;
    throw err;
  }

  await prisma.wealthClientNote.delete({ where: { id: noteId } });
  await writeAuditLog(orgId, 'client_note', noteId, 'deleted', rmProfileId, null);
}

module.exports = { listNotes, createNote, updateNote, deleteNote };
