const express = require('express');
const router = express.Router();
const appController = require('../controllers/appController');
const { restrictTo } = require('../middlewares/authMiddleware');

// Scan active resources from Azure and sync with DB
router.get('/scan', appController.scanApps);

// Provision new Static Web App
router.post('/provision', restrictTo('owner', 'admin', 'contributor'), appController.provisionApp);

// Bind custom domain in DNS & Azure
router.post('/bind-domain', restrictTo('owner', 'admin', 'contributor'), appController.bindCustomDomain);

// Check if azure-pipelines.yml exists in a GitHub repo
router.get('/check-yml', appController.checkYml);

// Fetch existing azure-pipelines.yml from GitHub repo
router.get('/get-yml', appController.getYml);

// Generate default SWA pipeline template YML
router.get('/default-yml', appController.getDefaultYml);

// Create CI/CD pipeline in Azure DevOps
router.post('/pipeline', restrictTo('owner', 'admin', 'contributor'), appController.createPipeline);

// Get live build task logs from Azure DevOps
router.get('/pipeline/logs', appController.getPipelineLogs);

// Get live build run state and timeline breakdown from Azure DevOps
router.get('/pipeline/timeline', appController.getPipelineTimeline);

// Get the most recent build run for a given pipeline definition ID (for new-build discovery)
router.get('/pipeline/latest', appController.getLatestPipelineBuild);

// Get pipeline build history
router.get('/pipeline/history', appController.getBuildHistory);

// Re-deploy a previous build (roles gated inside controller)
router.post('/pipeline/redeploy', restrictTo('owner', 'admin', 'contributor'), appController.reDeployBuild);

// Commit a default azure-pipelines.yml to GitHub repo, then register pipeline
router.post('/create-pipeline-yml', restrictTo('owner', 'admin', 'contributor'), appController.createPipelineYml);

// Get organization dynamic settings
router.get('/organization-settings', appController.getOrgSettings);

// Fetch Azure resource costs and optimizations
router.get('/cost', appController.getCostData);

// Apply cost optimization remediation suggestion
router.post('/cost/apply-remediation', restrictTo('owner', 'admin', 'contributor'), appController.applyRemediation);

// Azure Policy Compliance Auditing
router.get('/compliance', appController.getComplianceStatus);
router.get('/compliance/settings', appController.getComplianceSettings);
router.post('/compliance/settings', restrictTo('owner', 'admin', 'contributor'), appController.updateComplianceSettings);
router.post('/compliance/remediate', restrictTo('owner', 'admin', 'contributor'), appController.remediateCompliance);


// Ask Eva AI about cost optimization
router.post('/cost/ask-eva', restrictTo('owner', 'admin', 'contributor'), appController.askEva);

// Fetch billing invoices history
router.get('/billing', appController.getBillingHistory);
router.get('/billing/forecast', appController.getBillingForecast);


// Preview impact of a tier downgrade before confirming
router.get('/downgrade-impact', restrictTo('owner', 'admin'), appController.getDowngradeImpact);

// Update organization settings
router.post('/organization-settings', restrictTo('owner', 'admin'), appController.updateOrgSettings);

// Test Microsoft Teams webhook connectivity
router.post('/test-teams-webhook', restrictTo('owner', 'admin'), appController.testTeamsWebhook);

// Automated Microsoft Teams service hook setup
router.post('/setup-teams-service-hook', restrictTo('owner', 'admin'), appController.setupTeamsServiceHook);

// Force discover Log Analytics workspace ID from Azure
router.post('/discover-workspace', restrictTo('owner', 'admin'), appController.discoverWorkspace);

// Auto-discover Azure databases and managed environments
router.get('/discover-azure-resources', restrictTo('owner', 'admin'), appController.discoverAzureResources);

// Fetch organization GitHub repos dynamically
router.get('/github-repos', appController.getGithubRepos);

// Fetch repository branches dynamically
router.get('/github-branches', appController.getGithubBranches);

// Check repo integrity: classify each branch as frontend/backend/mixed and cross-ref with deployed apps
router.get('/repo-integrity', appController.checkRepoIntegrity);


// Expose Database management endpoints
router.get('/db-servers', appController.getDbServers);
router.get('/databases', appController.getDatabases);
router.post('/databases', restrictTo('owner', 'admin', 'contributor'), appController.provisionDatabase);
router.get('/database-schema', appController.getDatabaseSchema);
router.post('/execute-query', restrictTo('owner', 'admin', 'contributor', 'viewer'), appController.executeQuery);

// Get dynamic Azure provisioning metadata (Resource Groups, locations, envs, registries, DevOps service connections)
router.get('/provisioning-metadata', appController.getProvisioningMetadata);

// List all available Azure resource groups
router.get('/resource-groups', appController.getResourceGroups);

// Create default Dockerfile in user's GitHub repository
router.post('/create-dockerfile', restrictTo('owner', 'admin', 'contributor'), appController.createDockerfile);

// Get Dockerfile content from user's GitHub repository
router.get('/get-dockerfile', appController.getDockerfile);

// Push edited Dockerfile content back to GitHub
router.put('/update-dockerfile', restrictTo('owner', 'admin', 'contributor'), appController.updateDockerfile);

// Check CNAME propagation and SSL status for a custom domain
router.get('/domain-status', appController.getDomainStatus);

// Control app power states (start/stop/restart)
router.post('/:name/control', restrictTo('owner', 'admin', 'contributor'), appController.controlApp);

// Revisions & traffic control for Container Apps (ACA)
router.get('/:name/revisions', appController.getRevisions);
router.post('/:name/traffic', restrictTo('owner', 'admin', 'contributor'), appController.updateTraffic);
router.post('/:name/revision-mode', restrictTo('owner', 'admin', 'contributor'), appController.updateRevisionMode);

// DNS CNAME swap mapping (SWA/ACA)
router.post('/dns-swap', restrictTo('owner', 'admin', 'contributor'), appController.dnsSwap);

// Validate pipeline YAML content (azure-pipelines.yml or GitHub Actions workflow)
router.post('/validate-yml', appController.validateYml);

// Validate Dockerfile content
router.post('/validate-dockerfile', appController.validateDockerfile);

// Check YAML and Dockerfile health for a GitHub repo (for cloud scan indicators)
router.get('/yml-health', appController.checkYmlHealth);

// Delete SWA/ACA app from Azure and database
router.delete('/:name', restrictTo('owner', 'admin', 'contributor'), appController.deleteApp);

module.exports = router;
