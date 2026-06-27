const express = require('express');
const router = express.Router();
const credentialController = require('../controllers/credentialController');
const { restrictTo } = require('../middlewares/authMiddleware');

// Save/update credentials
router.post('/', restrictTo('owner', 'admin'), credentialController.saveCredentials);

// Decrypt credentials
router.get('/decrypt', restrictTo('owner', 'admin'), credentialController.getDecryptedCredentials);

// Test/validate credentials health
router.post('/validate', restrictTo('owner', 'admin'), credentialController.validateCredentials);

// Auto-discover credentials from environment
router.get('/discover-env', restrictTo('owner', 'admin'), credentialController.discoverAzureEnvCredentials);

// Programmatically rotate Azure Client Secret
router.post('/rotate-azure', restrictTo('owner', 'admin'), credentialController.rotateAzureSecret);

// List credentials (metadata only)
router.get('/', restrictTo('owner', 'admin'), credentialController.getCredentialsList);

module.exports = router;
