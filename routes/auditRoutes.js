const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.get('/', protect, restrictTo('owner', 'admin'), auditController.getAuditLogs);

module.exports = router;
