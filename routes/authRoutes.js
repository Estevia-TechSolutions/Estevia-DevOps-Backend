const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.post('/microsoft', authController.microsoftLogin);
router.post('/bypass', authController.bypassLogin);
router.post('/admin-override', authController.adminOverrideLogin);
router.get('/login-url', authController.getLoginUrl);
router.get('/me', protect, authController.getMe);
router.get('/diagnostic', authController.runDiagnostic);

// User and role management
router.get('/users', protect, restrictTo('owner', 'admin'), authController.listUsers);
router.put('/users/:userId/role', protect, restrictTo('owner', 'admin'), authController.updateUserRole);
router.post('/users/sync', protect, restrictTo('owner', 'admin'), authController.syncUsers);

// MFA Routes
router.post('/mfa/setup', authController.setupMfa);
router.post('/mfa/verify', authController.verifyMfa);
router.post('/mfa/validate', authController.validateMfa);
router.post('/mfa/request-reset', authController.requestMfaReset);
router.post('/mfa/reset-confirm', authController.confirmMfaReset);
router.put('/users/:userId/reset-mfa', protect, restrictTo('owner', 'admin'), authController.resetUserMfa);
router.post('/mfa-settings', protect, restrictTo('owner', 'admin'), authController.updateMfaSettings);
router.post('/mfa/setup-authenticated', protect, authController.setupMfaAuthenticated);
router.post('/mfa/verify-authenticated', protect, authController.verifyMfaAuthenticated);
router.post('/mfa/send-push-prompt', authController.sendPushMfaPrompt);
router.post('/mfa/poll-push-status', authController.pollPushMfaStatus);
router.post('/mfa/approve-push', authController.approvePushMfa);
router.post('/mfa/send-email-otp', authController.sendEmailMfaOtp);
router.post('/mfa/validate-email-otp', authController.validateEmailMfaOtp);
router.post('/mfa/generate-recovery-codes', authController.generateMfaRecoveryCodes);
router.post('/mfa/validate-recovery-code', authController.validateMfaRecoveryCode);
router.post('/mfa/preferred-method', authController.updatePreferredMfaMethod);

module.exports = router;
