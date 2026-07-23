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
router.post('/provision', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.provisionApp);

// Bind custom domain in DNS & Azure
router.post('/bind-domain', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.bindCustomDomain);

// Check if azure-pipelines.yml exists in a GitHub repo
router.get('/check-yml', protectOptional, lazyBillPackage('Developer'), appController.checkYml);

// Fetch existing azure-pipelines.yml from GitHub repo
router.get('/get-yml', protectOptional, lazyBillPackage('Developer'), appController.getYml);

// Generate default SWA pipeline template YML
router.get('/default-yml', protectOptional, lazyBillPackage('Developer'), appController.getDefaultYml);

// Create CI/CD pipeline in Azure DevOps
router.post('/pipeline', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.createPipeline);

// Get live build task logs from Azure DevOps
router.get('/pipeline/logs', protectOptional, lazyBillPackage('DevOps'), appController.getPipelineLogs);

// Get live build run state and timeline breakdown from Azure DevOps
router.get('/pipeline/timeline', protectOptional, lazyBillPackage('DevOps'), appController.getPipelineTimeline);

// Get the most recent build run for a given pipeline definition ID (for new-build discovery)
router.get('/pipeline/latest', protectOptional, lazyBillPackage('DevOps'), appController.getLatestPipelineBuild);

// Get pipeline build history
router.get('/pipeline/history', protectOptional, lazyBillPackage('DevOps'), appController.getBuildHistory);

// Re-deploy a previous build (roles gated inside controller)
router.post('/pipeline/redeploy', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.reDeployBuild);

// Cancel older duplicate builds for a pipeline
router.post('/pipeline/cancel-older', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.cancelOlderPipelineBuilds);

// Prioritize a queued build for a pipeline
router.post('/pipeline/prioritize', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.prioritizeBuild);

// Commit a default azure-pipelines.yml to GitHub repo, then register pipeline
router.post('/create-pipeline-yml', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.createPipelineYml);

// Get organization dynamic settings
router.get('/organization-settings', protectOptional, appController.getOrgSettings);

// Fetch Azure resource costs and optimizations
router.get('/cost', protectOptional, lazyBillPackage('Security'), appController.getCostData);
router.get('/cost/azure-bills', protectOptional, lazyBillPackage('Security'), appController.getAzureCloudBills);
router.get('/cost/azure-forecast', protectOptional, lazyBillPackage('Security'), appController.getAzureCloudForecast);

// Apply cost optimization remediation suggestion
router.post('/cost/apply-remediation', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Security'), appController.applyRemediation);

// Azure Policy Compliance Auditing
router.get('/compliance', protectOptional, lazyBillPackage('Security'), appController.getComplianceStatus);
router.get('/compliance/settings', protectOptional, lazyBillPackage('Security'), appController.getComplianceSettings);
router.post('/compliance/settings', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Security'), appController.updateComplianceSettings);
router.post('/compliance/remediate', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Security'), appController.remediateCompliance);


// Ask Eva AI about cost optimization
router.post('/cost/ask-eva', protectOptional, restrictTo('owner', 'admin', 'contributor', 'viewer'), lazyBillPackage('Security'), appController.askEva);

// Fetch billing invoices history
router.get('/billing', protectOptional, appController.getBillingHistory);
router.get('/billing/forecast', protectOptional, appController.getBillingForecast);


// Preview impact of a tier downgrade before confirming
router.get('/downgrade-impact', protect, restrictTo('owner', 'admin'), appController.getDowngradeImpact);

// Update organization settings
router.post('/organization-settings', protect, restrictTo('owner', 'admin'), appController.updateOrgSettings);

// Test Microsoft Teams webhook connectivity
router.post('/test-teams-webhook', protect, restrictTo('owner', 'admin'), lazyBillPackage('DevOps'), appController.testTeamsWebhook);

// Automated Microsoft Teams service hook setup
router.post('/setup-teams-service-hook', protect, restrictTo('owner', 'admin'), lazyBillPackage('DevOps'), appController.setupTeamsServiceHook);

// Force discover Log Analytics workspace ID from Azure
router.post('/discover-workspace', protect, restrictTo('owner', 'admin'), lazyBillPackage('Security'), appController.discoverWorkspace);

// Auto-discover Azure databases and managed environments
router.get('/discover-azure-resources', protect, restrictTo('owner', 'admin'), lazyBillPackage('DevOps'), appController.discoverAzureResources);

// Fetch organization GitHub repos dynamically
router.get('/github-repos', protectOptional, lazyBillPackage('Developer'), appController.getGithubRepos);

// Fetch repository branches dynamically
router.get('/github-branches', protectOptional, lazyBillPackage('Developer'), appController.getGithubBranches);

// Check repo integrity: classify each branch as frontend/backend/mixed and cross-ref with deployed apps
router.get('/repo-integrity', protectOptional, lazyBillPackage('Developer'), appController.checkRepoIntegrity);


// Expose Database management endpoints
router.get('/db-servers', protectOptional, lazyBillPackage('Developer'), appController.getDbServers);
router.get('/databases', protectOptional, lazyBillPackage('Developer'), appController.getDatabases);
router.post('/databases', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Developer'), appController.provisionDatabase);
router.get('/database-schema', protectOptional, lazyBillPackage('Developer'), appController.getDatabaseSchema);
router.post('/execute-query', protect, restrictTo('owner', 'admin', 'contributor', 'viewer'), lazyBillPackage('Developer'), appController.executeQuery);

// Get dynamic Azure provisioning metadata (Resource Groups, locations, envs, registries, DevOps service connections)
router.get('/provisioning-metadata', protectOptional, lazyBillPackage('DevOps'), appController.getProvisioningMetadata);

// List all available Azure resource groups
router.get('/resource-groups', protectOptional, lazyBillPackage('DevOps'), appController.getResourceGroups);

// Create default Dockerfile in user's GitHub repository
router.post('/create-dockerfile', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Developer'), appController.createDockerfile);

// Get Dockerfile content from user's GitHub repository
router.get('/get-dockerfile', protectOptional, lazyBillPackage('Developer'), appController.getDockerfile);

// Push edited Dockerfile content back to GitHub
router.put('/update-dockerfile', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('Developer'), appController.updateDockerfile);

// Check CNAME propagation and SSL status for a custom domain
router.get('/domain-status', protectOptional, lazyBillPackage('DevOps'), appController.getDomainStatus);

// Control app power states (start/stop/restart)
router.post('/:name/control', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.controlApp);

// Revisions & traffic control for Container Apps (ACA)
router.get('/:name/revisions', protectOptional, lazyBillPackage('DevOps'), appController.getRevisions);
router.post('/:name/traffic', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.updateTraffic);
router.post('/:name/revision-mode', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.updateRevisionMode);

// DNS CNAME swap mapping (SWA/ACA)
router.post('/dns-swap', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.dnsSwap);

// Validate pipeline YAML content (azure-pipelines.yml or GitHub Actions workflow)
router.post('/validate-yml', protectOptional, lazyBillPackage('Developer'), appController.validateYml);

// Validate Dockerfile content
router.post('/validate-dockerfile', protectOptional, lazyBillPackage('Developer'), appController.validateDockerfile);

// Check YAML and Dockerfile health for a GitHub repo (for cloud scan indicators)
router.get('/yml-health', protectOptional, lazyBillPackage('Developer'), appController.checkYmlHealth);

// Delete SWA/ACA app from Azure and database
router.delete('/:name', protect, restrictTo('owner', 'admin', 'contributor'), lazyBillPackage('DevOps'), appController.deleteApp);

module.exports = router;
