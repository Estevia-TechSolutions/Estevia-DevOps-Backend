const express = require('express');
const router = express.Router();
const dbHubController = require('../controllers/dbHubController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.post('/compare', protect, dbHubController.compareSchemas);
router.post('/migrate', protect, restrictTo('owner', 'admin', 'contributor'), dbHubController.executeMigration);
router.post('/migrate-data', protect, restrictTo('owner', 'admin', 'contributor'), dbHubController.migrateData);
router.get('/erd', protect, dbHubController.getErdSchema);
router.get('/backup', protect, dbHubController.backupDatabase);
router.post('/proxy-query', protect, dbHubController.proxyDatabaseQuery);

module.exports = router;
