const express = require('express');
const router = express.Router();
const appController = require('../controllers/appController');

// Scan active resources from Azure and sync with DB
router.get('/scan', appController.scanApps);

// Provision new Static Web App
router.post('/provision', appController.provisionApp);

// Bind custom domain in DNS & Azure
router.post('/bind-domain', appController.bindCustomDomain);

// Check if azure-pipelines.yml exists in a GitHub repo
router.get('/check-yml', appController.checkYml);

// Fetch existing azure-pipelines.yml from GitHub repo
router.get('/get-yml', appController.getYml);

// Generate default SWA pipeline template YML
router.get('/default-yml', appController.getDefaultYml);

// Create CI/CD pipeline in Azure DevOps
router.post('/pipeline', appController.createPipeline);

// Commit a default azure-pipelines.yml to GitHub repo, then register pipeline
router.post('/create-pipeline-yml', appController.createPipelineYml);

// Get organization dynamic settings
router.get('/organization-settings', appController.getOrgSettings);

// Fetch Azure resource costs and optimizations
router.get('/cost', appController.getCostData);

// Update organization settings
router.post('/organization-settings', appController.updateOrgSettings);

// Fetch organization GitHub repos dynamically
router.get('/github-repos', appController.getGithubRepos);

// Fetch repository branches dynamically
router.get('/github-branches', appController.getGithubBranches);

// Expose Database management endpoints
router.get('/db-servers', appController.getDbServers);
router.get('/databases', appController.getDatabases);
router.post('/databases', appController.provisionDatabase);
router.get('/database-schema', appController.getDatabaseSchema);
router.post('/execute-query', appController.executeQuery);

// Get dynamic Azure provisioning metadata (Resource Groups, locations, envs, registries, DevOps service connections)
router.get('/provisioning-metadata', appController.getProvisioningMetadata);

// Create default Dockerfile in user's GitHub repository
router.post('/create-dockerfile', appController.createDockerfile);

// Get Dockerfile content from user's GitHub repository
router.get('/get-dockerfile', appController.getDockerfile);

// Push edited Dockerfile content back to GitHub
router.put('/update-dockerfile', appController.updateDockerfile);

// Check CNAME propagation and SSL status for a custom domain
router.get('/domain-status', appController.getDomainStatus);

// Delete SWA/ACA app from Azure and database
router.delete('/:name', appController.deleteApp);

module.exports = router;
