const router = require('express').Router();
const accessRequestController = require('../controllers/accessRequest.controller');

router.post('/', accessRequestController.createAccessRequest);

module.exports = router;
