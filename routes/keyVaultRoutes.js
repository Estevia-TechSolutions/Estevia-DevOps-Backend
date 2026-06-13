const express = require('express');
const router = express.Router();
const keyVaultController = require('../controllers/keyVaultController');
const { protect, restrictTo } = require('../middlewares/authMiddleware');

router.get('/mappings', protect, keyVaultController.getMappings);
router.post('/map', protect, restrictTo('owner', 'admin'), keyVaultController.mapSecret);
router.delete('/mappings/:id', protect, restrictTo('owner', 'admin'), keyVaultController.deleteMapping);

module.exports = router;
