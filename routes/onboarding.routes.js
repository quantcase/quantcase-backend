'use strict';

const router = require('express').Router();
const authenticate = require('../middleware/authenticate');
const onboardingController = require('../controllers/onboarding.controller');

router.post('/complete', authenticate, onboardingController.completeOnboarding);

module.exports = router;
