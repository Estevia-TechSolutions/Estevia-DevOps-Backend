const express = require('express');
const router = express.Router();
const observabilityController = require('../controllers/observabilityController');
const userPermissionController = require('../controllers/userPermissionController');
const { protect, protectOptional, lazyBillPackage } = require('../middlewares/authMiddleware');

// Gated routes for Metrics & Incidents
router.get('/metrics', protectOptional, lazyBillPackage('Observability'), observabilityController.getMetrics);
router.get('/incidents', protectOptional, lazyBillPackage('Observability'), observabilityController.getIncidents);
router.post('/incidents/:id/acknowledge', protectOptional, lazyBillPackage('Observability'), observabilityController.acknowledgeIncident);
router.post('/incidents/:id/resolve', protectOptional, lazyBillPackage('Observability'), observabilityController.resolveIncident);

// Resource ownership configuration per SWA, ACA, VM asset
router.get('/owners', protectOptional, lazyBillPackage('Observability'), observabilityController.getResourceOwners);
router.put('/owners', protectOptional, lazyBillPackage('Observability'), observabilityController.updateResourceOwners);

// Top-level navigation menu item permissions & Catalog Aliases
router.get('/resource-catalog', protectOptional, userPermissionController.getResourceCatalog);
router.get('/menu-permissions/:userId', protectOptional, observabilityController.getUserMenuPermissions);
router.put('/menu-permissions/:userId', protectOptional, observabilityController.updateUserMenuPermissions);

module.exports = router;
