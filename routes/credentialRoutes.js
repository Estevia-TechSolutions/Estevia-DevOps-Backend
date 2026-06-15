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

// List credentials (metadata only)
router.get('/', restrictTo('owner', 'admin'), credentialController.getCredentialsList);

module.exports = router;
