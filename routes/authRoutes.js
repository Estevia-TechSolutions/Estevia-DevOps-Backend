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
router.post(['/auth/mfa/setup', '/mfa/setup', '/setup'], authController.setupMfa);
router.post(['/auth/mfa/verify', '/mfa/verify', '/verify'], authController.verifyMfa);
router.post(['/auth/mfa/validate', '/mfa/validate', '/validate'], authController.validateMfa);
router.post(['/auth/mfa/request-reset', '/mfa/request-reset', '/request-reset'], authController.requestMfaReset);
router.post(['/auth/mfa/reset-confirm', '/mfa/reset-confirm', '/reset-confirm'], authController.confirmMfaReset);
router.put('/users/:userId/reset-mfa', protect, restrictTo('owner', 'admin'), authController.resetUserMfa);
router.post('/mfa-settings', protect, restrictTo('owner', 'admin'), authController.updateMfaSettings);
router.post(['/auth/mfa/setup-authenticated', '/mfa/setup-authenticated', '/setup-authenticated'], protect, authController.setupMfaAuthenticated);
router.post(['/auth/mfa/verify-authenticated', '/mfa/verify-authenticated', '/verify-authenticated'], protect, authController.verifyMfaAuthenticated);
router.post(['/auth/mfa/send-push-prompt', '/mfa/send-push-prompt', '/send-push-prompt'], authController.sendPushMfaPrompt);
router.post(['/auth/mfa/poll-push-status', '/mfa/poll-push-status', '/poll-push-status'], authController.pollPushMfaStatus);
router.post(['/auth/mfa/approve-push', '/mfa/approve-push', '/approve-push'], authController.approvePushMfa);
router.post(['/auth/mfa/send-email-otp', '/mfa/send-email-otp', '/send-email-otp'], authController.sendEmailMfaOtp);
router.post(['/auth/mfa/validate-email-otp', '/mfa/validate-email-otp', '/validate-email-otp'], authController.validateEmailMfaOtp);
router.post(['/auth/mfa/generate-recovery-codes', '/mfa/generate-recovery-codes', '/generate-recovery-codes'], authController.generateMfaRecoveryCodes);
router.post(['/auth/mfa/validate-recovery-code', '/mfa/validate-recovery-code', '/validate-recovery-code'], authController.validateMfaRecoveryCode);
router.post(['/auth/mfa/preferred-method', '/mfa/preferred-method', '/preferred-method'], authController.updatePreferredMfaMethod);

module.exports = router;
