const express = require('express');
const router = express.Router();
const observabilityController = require('../controllers/observabilityController');
const { protect } = require('../middlewares/authMiddleware');

router.get('/:appName/logs', protect, observabilityController.getLogs);
router.get('/:appName/metrics', protect, observabilityController.getMetrics);

module.exports = router;
