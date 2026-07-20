const express = require('express');
const router = express.Router();
const emailTemplateController = require('../controllers/emailTemplateController');

// GET /api/devops/email-templates - Catalog list of EvaOps email templates
router.get('/', emailTemplateController.getEmailTemplates);

// GET /api/devops/email-templates/:id/preview - Render HTML preview
router.get('/:id/preview', emailTemplateController.getTemplatePreview);

// POST /api/devops/email-templates/test - Send test email
router.post('/test', emailTemplateController.sendTestEmail);

module.exports = router;
