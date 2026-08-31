'use strict';

const router       = require('express').Router();
const asyncHandler = require('../middleware/asyncHandler');
const authenticate = require('../middleware/authenticate');
const { register, googleAuth, signin, getMe, updateOnboarding, recordTickerView } = require('../controllers/auth.controller');

router.post('/register',        asyncHandler(register));
router.post('/google',          asyncHandler(googleAuth));
router.post('/signin',          asyncHandler(signin));
router.get('/me',               authenticate, asyncHandler(getMe));
router.patch('/me/onboarding',  authenticate, asyncHandler(updateOnboarding));
router.patch('/me/view-ticker', authenticate, asyncHandler(recordTickerView));

module.exports = router;
