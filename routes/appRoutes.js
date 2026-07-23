const express = require('express');
const router = express.Router();
const appController = require('../controllers/appController');
const { protect, protectOptional, restrictTo, lazyBillPackage } = require('../middlewares/authMiddleware');

// Mount Observability routes at the top before any parameterized routes
const observabilityRoutes = require('./observabilityRoutes');
router.use('/observability', observabilityRoutes);

// Scan active resources from Azure and sync with DB
router.get('/scan', protect, lazyBillPackage('DevOps'), appController.scanApps);

// Provision new Static Web App
router.post('/provision', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.provisionApp);

// Bind custom domain in DNS & Azure
router.post('/bind-domain', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.bindCustomDomain);

// Check if azure-pipelines.yml exists in a GitHub repo
router.get('/check-yml', lazyBillPackage('Developer'), appController.checkYml);

// Fetch existing azure-pipelines.yml from GitHub repo
router.get('/get-yml', lazyBillPackage('Developer'), appController.getYml);

// Generate default SWA pipeline template YML
router.get('/default-yml', lazyBillPackage('Developer'), appController.getDefaultYml);

// Create CI/CD pipeline in Azure DevOps
router.post('/pipeline', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.createPipeline);

// Get live build task logs from Azure DevOps
router.get('/pipeline/logs', protectOptional, lazyBillPackage('DevOps'), appController.getPipelineLogs);

// Get live build run state and timeline breakdown from Azure DevOps
router.get('/pipeline/timeline', protectOptional, lazyBillPackage('DevOps'), appController.getPipelineTimeline);

// Get the most recent build run for a given pipeline definition ID (for new-build discovery)
router.get('/pipeline/latest', protectOptional, lazyBillPackage('DevOps'), appController.getLatestPipelineBuild);

// Get pipeline build history
router.get('/pipeline/history', protectOptional, lazyBillPackage('DevOps'), appController.getBuildHistory);

// Re-deploy a previous build (roles gated inside controller)
router.post('/pipeline/redeploy', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.reDeployBuild);

// Cancel older duplicate builds for a pipeline
router.post('/pipeline/cancel-older', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.cancelOlderPipelineBuilds);

// Prioritize a queued build for a pipeline
router.post('/pipeline/prioritize', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.prioritizeBuild);

// Commit a default azure-pipelines.yml to GitHub repo, then register pipeline
router.post('/create-pipeline-yml', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.createPipelineYml);

// Get organization dynamic settings
router.get('/organization-settings', appController.getOrgSettings);

// Fetch Azure resource costs and optimizations
router.get('/cost', lazyBillPackage('Security'), appController.getCostData);

// Apply cost optimization remediation suggestion
router.post('/cost/apply-remediation', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Security'), appController.applyRemediation);

// Azure Policy Compliance Auditing
router.get('/compliance', lazyBillPackage('Security'), appController.getComplianceStatus);
router.get('/compliance/settings', lazyBillPackage('Security'), appController.getComplianceSettings);
router.post('/compliance/settings', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Security'), appController.updateComplianceSettings);
router.post('/compliance/remediate', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Security'), appController.remediateCompliance);


// Ask Eva AI about cost optimization
router.post('/cost/ask-eva', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Security'), appController.askEva);

// Fetch billing invoices history
router.get('/billing', appController.getBillingHistory);
router.get('/billing/forecast', appController.getBillingForecast);


// Preview impact of a tier downgrade before confirming
router.get('/downgrade-impact', restrictTo('owner', 'admin'), appController.getDowngradeImpact);

// Update organization settings
router.post('/organization-settings', restrictTo('owner', 'admin'), appController.updateOrgSettings);

// Test Microsoft Teams webhook connectivity
router.post('/test-teams-webhook', restrictTo('owner', 'admin'), lazyBillPackage('DevOps'), appController.testTeamsWebhook);

// Automated Microsoft Teams service hook setup
router.post('/setup-teams-service-hook', restrictTo('owner', 'admin'), lazyBillPackage('DevOps'), appController.setupTeamsServiceHook);

// Force discover Log Analytics workspace ID from Azure
router.post('/discover-workspace', restrictTo('owner', 'admin'), lazyBillPackage('Security'), appController.discoverWorkspace);

// Auto-discover Azure databases and managed environments
router.get('/discover-azure-resources', restrictTo('owner', 'admin'), lazyBillPackage('DevOps'), appController.discoverAzureResources);

// Fetch organization GitHub repos dynamically
router.get('/github-repos', lazyBillPackage('Developer'), appController.getGithubRepos);

// Fetch repository branches dynamically
router.get('/github-branches', lazyBillPackage('Developer'), appController.getGithubBranches);

// Check repo integrity: classify each branch as frontend/backend/mixed and cross-ref with deployed apps
router.get('/repo-integrity', lazyBillPackage('Developer'), appController.checkRepoIntegrity);


// Expose Database management endpoints
router.get('/db-servers', lazyBillPackage('Developer'), appController.getDbServers);
router.get('/databases', lazyBillPackage('Developer'), appController.getDatabases);
router.post('/databases', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Developer'), appController.provisionDatabase);
router.get('/database-schema', lazyBillPackage('Developer'), appController.getDatabaseSchema);
router.post('/execute-query', restrictTo('owner', 'admin', 'contributor', 'viewer'), lazyBillPackage('Developer'), appController.executeQuery);

// Get dynamic Azure provisioning metadata (Resource Groups, locations, envs, registries, DevOps service connections)
router.get('/provisioning-metadata', lazyBillPackage('DevOps'), appController.getProvisioningMetadata);

// List all available Azure resource groups
router.get('/resource-groups', lazyBillPackage('DevOps'), appController.getResourceGroups);

// Create default Dockerfile in user's GitHub repository
router.post('/create-dockerfile', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Developer'), appController.createDockerfile);

// Get Dockerfile content from user's GitHub repository
router.get('/get-dockerfile', lazyBillPackage('Developer'), appController.getDockerfile);

// Push edited Dockerfile content back to GitHub
router.put('/update-dockerfile', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Developer'), appController.updateDockerfile);

// Check CNAME propagation and SSL status for a custom domain
router.get('/domain-status', lazyBillPackage('DevOps'), appController.getDomainStatus);

// Control app power states (start/stop/restart)
router.post('/:name/control', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.controlApp);

// Revisions & traffic control for Container Apps (ACA)
router.get('/:name/revisions', lazyBillPackage('DevOps'), appController.getRevisions);
router.post('/:name/traffic', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.updateTraffic);
router.post('/:name/revision-mode', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.updateRevisionMode);

// DNS CNAME swap mapping (SWA/ACA)
router.post('/dns-swap', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.dnsSwap);

// Validate pipeline YAML content (azure-pipelines.yml or GitHub Actions workflow)
router.post('/validate-yml', lazyBillPackage('Developer'), appController.validateYml);

// Validate Dockerfile content
router.post('/validate-dockerfile', lazyBillPackage('Developer'), appController.validateDockerfile);

// Check YAML and Dockerfile health for a GitHub repo (for cloud scan indicators)
router.get('/yml-health', lazyBillPackage('Developer'), appController.checkYmlHealth);

// Delete SWA/ACA app from Azure and database
router.delete('/:name', restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.deleteApp);

module.exports = router;
