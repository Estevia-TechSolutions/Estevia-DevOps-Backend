const express = require('express');
const router = express.Router();
const schedulerController = require('../controllers/schedulerController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.get('/rules', protect, schedulerController.getRules);
router.post('/rules', protect, restrictTo('owner', 'admin'), schedulerController.saveRules);

module.exports = router;
