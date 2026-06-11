const express = require('express');
const router = express.Router();
const orgController = require('../controllers/orgController');
const { protect } = require('../middlewares/authMiddleware');

router.post('/register', protect, orgController.register);
router.post('/setup-azure', protect, orgController.setupAzure);
router.post('/setup-devops', protect, orgController.setupDevops);
router.post('/setup-dns', protect, orgController.setupDns);
router.post('/complete', protect, orgController.complete);
router.get('/status', protect, orgController.getStatus);

// Test credentials endpoints
router.post('/test/azure', protect, orgController.testAzure);
router.post('/test/github', protect, orgController.testGithub);
router.post('/test/devops', protect, orgController.testDevops);
router.post('/test/godaddy', protect, orgController.testDns);

module.exports = router;
