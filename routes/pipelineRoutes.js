const express = require('express');
const router = express.Router();
const pipelineController = require('../controllers/pipelineController');

// ── Pipeline Endpoints ────────────────────────────────────────────────────────
router.get('/', pipelineController.listPipelines);
router.post('/create-on-the-fly', pipelineController.createPipelineOnTheFly);
router.get('/runs', pipelineController.listPipelineRuns);
router.get('/runs/:runId', pipelineController.getRunDetails);
router.get('/steps/:stepId/logs', pipelineController.getStepLogs);
router.get('/:id', pipelineController.getPipelineById);
router.post('/:pipelineId/trigger', pipelineController.triggerPipelineRun);
router.put('/:pipelineId/migrate-provider', pipelineController.migratePipelineProvider);

module.exports = router;
