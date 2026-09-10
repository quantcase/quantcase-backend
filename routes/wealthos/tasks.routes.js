'use strict';

const router   = require('express').Router();
const { z }    = require('zod');
const validate = require('../../middleware/validate');
const ctrl     = require('../../controllers/wealthos/tasks.controller');

const TASK_TYPES  = [
  'call', 'meeting', 'email', 'portfolio_review',
  'document_collection', 'compliance', 'other'
];
const TASK_STATUS = ['open', 'in_progress', 'done', 'cancelled', 'overdue'];

const listTasksSchema = z.object({
  page:          z.coerce.number().int().min(1).default(1),
  size:          z.coerce.number().int().min(1).max(100).default(20),
  client_id:     z.string().uuid().optional(),
  rm_profile_id: z.string().uuid().optional(),
  status:        z.enum(TASK_STATUS).optional(),
  task_type:     z.enum(TASK_TYPES).optional(),
  due_before:    z.string().optional(),
});

const createTaskSchema = z.object({
  title:                 z.string().min(1),
  task_type:             z.enum(TASK_TYPES),
  client_id:             z.string().uuid().optional().nullable(),
  rm_profile_id:         z.string().uuid().optional().nullable(),
  description:           z.string().optional().nullable(),
  status:                z.enum(TASK_STATUS).optional().default('open'),
  due_date:              z.string().optional().nullable(),
  linked_interaction_id: z.string().uuid().optional().nullable(),
});

const updateTaskSchema = createTaskSchema.partial();

router.get('/',           validate(listTasksSchema, 'query'),   ctrl.listTasks);
router.post('/',          validate(createTaskSchema, 'body'),   ctrl.createTask);
router.put('/:taskId',    validate(updateTaskSchema, 'body'),   ctrl.updateTask);
router.delete('/:taskId',                                       ctrl.deleteTask);

module.exports = router;
