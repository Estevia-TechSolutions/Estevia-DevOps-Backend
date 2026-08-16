const express = require('express');
const router = express.Router();
const m365Controller = require('../controllers/m365Controller');
const { protect } = require('../middlewares/authMiddleware');

router.get('/subscriptions', protect, m365Controller.getSubscriptions);
router.get('/users', protect, m365Controller.getUsers);
router.post('/assign', protect, m365Controller.assignLicense);
router.post('/verify-godaddy', protect, m365Controller.verifyGoDaddy);

// OAuth Admin Consent flow — protected initiate, public callback (Microsoft redirects here)
router.get('/auth/initiate', protect, m365Controller.initiateAdminConsent);
router.get('/auth/callback', m365Controller.handleAdminConsentCallback);

module.exports = router;
