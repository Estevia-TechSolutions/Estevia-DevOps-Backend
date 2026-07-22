const express = require('express');
const router = express.Router();
const observabilityController = require('../controllers/observabilityController');
const { protect, lazyBillPackage } = require('../middlewares/authMiddleware');

// Gated routes for Metrics & Incidents
router.get('/metrics', protect, lazyBillPackage('Observability'), observabilityController.getMetrics);
router.get('/incidents', protect, lazyBillPackage('Observability'), observabilityController.getIncidents);
router.post('/incidents/:id/acknowledge', protect, lazyBillPackage('Observability'), observabilityController.acknowledgeIncident);
router.post('/incidents/:id/resolve', protect, lazyBillPackage('Observability'), observabilityController.resolveIncident);

// Resource ownership configuration per SWA, ACA, VM asset
router.get('/owners', protect, observabilityController.getResourceOwners);
router.put('/owners', protect, observabilityController.updateResourceOwners);

// Top-level navigation menu item permissions
router.get('/menu-permissions/:userId', protect, observabilityController.getUserMenuPermissions);
router.put('/menu-permissions/:userId', protect, observabilityController.updateUserMenuPermissions);

module.exports = router;
