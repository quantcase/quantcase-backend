'use strict';

const router = require('express').Router();
const { signin, getMe } = require('../controllers/auth.controller');
const authenticate = require('../middleware/authenticate');

router.post('/signin', signin);
router.get('/me', authenticate, getMe);

module.exports = router;
