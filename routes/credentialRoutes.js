const express = require('express');
const router = express.Router();
const credentialController = require('../controllers/credentialController');

// Save/update credentials
router.post('/', credentialController.saveCredentials);

// Decrypt credentials
router.get('/decrypt', credentialController.getDecryptedCredentials);

// List credentials (metadata only)
router.get('/', credentialController.getCredentialsList);

module.exports = router;
