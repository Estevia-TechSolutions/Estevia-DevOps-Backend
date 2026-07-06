const express = require('express');
const router = express.Router();
const crmController = require('../controllers/crmController');
const { protectCrm } = require('../middlewares/authMiddleware');

// Public route for CRM login
router.get('/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), routes: ['auth/login', 'auth/me', 'users', 'clients'] });
});
router.post('/auth/login', crmController.login);
router.get('/auth/login-url', crmController.getLoginUrl);
router.post('/auth/microsoft', crmController.microsoftLogin);

// Protected routes (require CRM token)
router.get('/auth/me', protectCrm, crmController.getMe);
router.post('/auth/create-user', protectCrm, crmController.createCrmUser);
router.get('/users', protectCrm, crmController.listCrmUsers);
router.put('/users/:id', protectCrm, crmController.updateCrmUser);
router.post('/users/sync', protectCrm, crmController.syncUsers);

router.get('/clients', protectCrm, crmController.listClients);
router.put('/clients/:id/licensing', protectCrm, crmController.updateLicensing);
router.put('/clients/:id/status', protectCrm, crmController.updateStatus);

router.get('/clients/:id/invoices', protectCrm, crmController.listClientInvoices);
router.post('/clients/:id/invoices', protectCrm, crmController.generateInvoice);
router.put('/invoices/:invoiceId/status', protectCrm, crmController.updateInvoiceStatus);

module.exports = router;
