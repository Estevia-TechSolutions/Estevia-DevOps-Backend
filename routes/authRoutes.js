const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

router.post('/microsoft', authController.microsoftLogin);
router.post('/bypass', authController.bypassLogin);
router.get('/login-url', authController.getLoginUrl);
router.get('/me', protect, authController.getMe);

module.exports = router;
