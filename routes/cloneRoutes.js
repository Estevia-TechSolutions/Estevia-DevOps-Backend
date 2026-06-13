const express = require('express');
const router = express.Router();
const cloneController = require('../controllers/cloneController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.post('/clone', protect, restrictTo('owner', 'admin', 'contributor'), cloneController.cloneEnvironment);

module.exports = router;
