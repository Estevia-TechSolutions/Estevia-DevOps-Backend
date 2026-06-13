const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

/**
 * POST /api/webhooks/azure-devops/:webhookToken
 *
 * Public endpoint — no authentication middleware.
 * The unguessable :webhookToken parameter serves as the shared secret.
 *
 * Register this URL in Azure DevOps:
 *   Project Settings → Service Hooks → + (Create Subscription) → Web Hooks
 *   Trigger: "Build completed"
 *   URL: https://<your-domain>/api/webhooks/azure-devops/<webhookToken>
 */
router.post('/azure-devops/:webhookToken', webhookController.handleAzureDevopsWebhook);

module.exports = router;
