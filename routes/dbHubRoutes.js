const express = require('express');
const router = express.Router();
const dbHubController = require('../controllers/dbHubController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.post('/compare', protect, dbHubController.compareSchemas);
router.post('/migrate', protect, restrictTo('owner', 'admin', 'contributor'), dbHubController.executeMigration);
router.get('/erd', protect, dbHubController.getErdSchema);

module.exports = router;
