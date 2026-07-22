const express = require('express');
const router = express.Router();
const observabilityController = require('../controllers/observabilityController');
const userPermissionController = require('../controllers/userPermissionController');
const { protect, protectOptional } = require('../middlewares/authMiddleware');

// Gated routes for Metrics & Incidents
router.get('/metrics', protectOptional, observabilityController.getMetrics);
router.get('/incidents', protectOptional, observabilityController.getIncidents);
router.post('/incidents/:id/acknowledge', protectOptional, observabilityController.acknowledgeIncident);
router.post('/incidents/:id/resolve', protectOptional, observabilityController.resolveIncident);

// Resource ownership configuration per SWA, ACA, VM asset
router.get('/owners', protectOptional, observabilityController.getResourceOwners);
router.put('/owners', protectOptional, observabilityController.updateResourceOwners);

// Top-level navigation menu item permissions & Catalog Aliases
router.get('/resource-catalog', protectOptional, userPermissionController.getResourceCatalog);
router.get('/menu-permissions/:userId', protectOptional, observabilityController.getUserMenuPermissions);
router.put('/menu-permissions/:userId', protectOptional, observabilityController.updateUserMenuPermissions);

module.exports = router;
