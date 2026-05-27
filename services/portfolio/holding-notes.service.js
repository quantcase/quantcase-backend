'use strict';

const prisma = require('../../config/prisma');

async function createNote(holdingId, userId, note_text) {
  await assertHoldingOwnership(holdingId, userId);
  return prisma.holdingNote.create({ data: { holding_id: holdingId, note_text } });
}

async function updateNote(noteId, userId, note_text) {
  await assertNoteOwnership(noteId, userId);
  return prisma.holdingNote.update({ where: { id: noteId }, data: { note_text } });
}

async function deleteNote(noteId, userId) {
  await assertNoteOwnership(noteId, userId);
  await prisma.holdingNote.delete({ where: { id: noteId } });
}

async function assertHoldingOwnership(holdingId, userId) {
  const holding = await prisma.holding.findFirst({
    where: {
      id: holdingId,
      OR: [
        { user_portfolio:   { user_id: userId } },
        { shadow_portfolio: { user_id: userId } },
      ],
    },
  });
  if (!holding) {
    const e = new Error('Holding not found or access denied');
    e.status = 404;
    throw e;
  }
}

async function assertNoteOwnership(noteId, userId) {
  const note = await prisma.holdingNote.findFirst({
    where: {
      id:      noteId,
      holding: {
        OR: [
          { user_portfolio:   { user_id: userId } },
          { shadow_portfolio: { user_id: userId } },
        ],
      },
    },
  });
  if (!note) {
    const e = new Error('Note not found or access denied');
    e.status = 404;
    throw e;
  }
}

module.exports = { createNote, updateNote, deleteNote };
