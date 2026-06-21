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

module.exports = router;
