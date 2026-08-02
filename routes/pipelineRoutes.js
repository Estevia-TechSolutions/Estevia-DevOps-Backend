const express = require('express');
const router = express.Router();
const pipelineController = require('../controllers/pipelineController');
const webhookController = require('../controllers/webhookController');

// ── Webhook & Execution Endpoints ─────────────────────────────────────────────
router.post('/webhooks/github', webhookController.handleGitHubWebhook);

// ── Pipeline Endpoints ────────────────────────────────────────────────────────
router.get('/', pipelineController.listPipelines);
router.post('/create-on-the-fly', pipelineController.createPipelineOnTheFly);
router.get('/runs', pipelineController.listPipelineRuns);
router.get('/runs/:runId', pipelineController.getRunDetails);
router.get('/steps/:stepId/logs', pipelineController.getStepLogs);
router.get('/:id', pipelineController.getPipelineById);
router.post('/:pipelineId/trigger', pipelineController.triggerPipelineRun);
router.put('/:pipelineId/migrate-provider', pipelineController.migratePipelineProvider);
router.post('/:id/decommission', pipelineController.decommissionLegacyPipeline);
router.delete('/:id', pipelineController.deletePipeline);

module.exports = router;
