'use strict';

const asyncHandler = require('../../middleware/asyncHandler');
const service      = require('../../services/wealthos/notes.service');

const listNotes = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const notes = await service.listNotes(
    orgId,
    req.params.clientId,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, data: notes });
});

const createNote = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const note = await service.createNote(
    orgId,
    req.params.clientId,
    req.body,
    req.wealthMember.id,
    req.wealthRole,
    req.wealthRmProfile?.id
  );
  res.status(201).json({ success: true, data: note });
});

const updateNote = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  const note = await service.updateNote(
    orgId,
    req.params.noteId,
    req.body,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, data: note });
});

const deleteNote = asyncHandler(async (req, res) => {
  const orgId = req.wealthOrg.id;
  await service.deleteNote(
    orgId,
    req.params.noteId,
    req.wealthRmProfile?.id
  );
  res.json({ success: true, message: 'Note deleted successfully' });
});

module.exports = { listNotes, createNote, updateNote, deleteNote };
