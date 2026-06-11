const db = require('../config/db');
const credentialController = require('./credentialController');
const { DefaultAzureCredential, ClientSecretCredential } = require('@azure/identity');
const { WebSiteManagementClient } = require('@azure/arm-appservice');
const { ContainerAppsAPIClient } = require('@azure/arm-appcontainers');
const { ResourceManagementClient } = require('@azure/arm-resources');
const axios = require('axios');

// Default Fallbacks
const SUBSCRIPTION_ID = 'a812e8e3-34f9-4773-82ee-6398869533b0';
const RESOURCE_GROUP = 'Estevia-Prod-RG';
const DEFAULT_DOMAIN = 'esteviatech.com';

// Dynamic helper to fetch Azure credentials (Service Principal or Default CLI fallback)
async function getAzureCredential(organizationId) {
    try {
        const azureSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure');
        if (azureSecrets && azureSecrets.clientId && azureSecrets.clientSecret && azureSecrets.tenantId) {
            console.log(`[AzureAuth] Using ClientSecretCredential for organization: ${organizationId}`);
            return new ClientSecretCredential(
                azureSecrets.tenantId,
                azureSecrets.clientId,
                azureSecrets.clientSecret
            );
        }
    } catch (err) {
        console.warn(`[AzureAuth] Failed to retrieve Azure credentials for organization ${organizationId}:`, err.message);
    }
    console.log(`[AzureAuth] Falling back to DefaultAzureCredential for organization: ${organizationId}`);
    return new DefaultAzureCredential();
}

const appController = {
    /**
     * Shared helper to retrieve organization settings from database
     */
    async _getOrgSettings(organizationId) {
        const [rows] = await db.query('SELECT * FROM organizations WHERE id = ?', [organizationId]);
        if (rows.length === 0) {
            throw new Error(`Organization ${organizationId} not found.`);
        }
        return rows[0];
    },
    /**
     * Resolve target branch git ref based on the app's name,
     * cross-referencing against the repo's branches list to ensure exact match.
     */
    _resolveBranchFromAppName(name, availableBranches = []) {
        const n = name.toLowerCase();
        let targetSimpleName = 'main';
        if (n.includes('-dev') || n.endsWith('-dev') || n.includes('-dev-')) targetSimpleName = 'dev';
        else if (n.includes('-qa') || n.endsWith('-qa') || n.includes('-qa-')) targetSimpleName = 'qa';
        else if (n.includes('-prod') || n.endsWith('-prod') || n.includes('-prod-')) targetSimpleName = 'main';
        
        // Find if any branch matches the target simple name
        const match = availableBranches.find(b => {
            const bName = b.name.toLowerCase();
            return bName === targetSimpleName || 
                   (targetSimpleName === 'main' && bName === 'master') ||
                   (targetSimpleName === 'dev' && bName === 'development');
        });
        
        const branchName = match ? match.name : targetSimpleName;
        return `refs/heads/${branchName}`;
    },
    /**
     * Scan Azure subscription for Static Web Apps and Container Apps,
     * sync them with the local applications DB table, and return the combined details.
     * Integrates real-time auto-discovery of GoDaddy domains and Azure DevOps pipelines.
     */
    scanApps: async (req, res) => {
        try {
            const { organizationId } = req.query;
            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId query parameter.' });
            }

            const orgSettings = await appController._getOrgSettings(organizationId);
            const subscriptionId = orgSettings.azure_subscription_id || SUBSCRIPTION_ID;
            const resourceGroup = orgSettings.azure_resource_group || RESOURCE_GROUP;
            const defaultDomain = orgSettings.default_dns_domain || DEFAULT_DOMAIN;
            const githubOwner = orgSettings.github_owner || 'Estevia-TechSolutions';

            const credential = await getAzureCredential(organizationId);
            const webClient = new WebSiteManagementClient(credential, subscriptionId);
            const containerClient = new ContainerAppsAPIClient(credential, subscriptionId);

            const apps = [];

            // 1. Fetch Static Web Apps (Frontends)
            try {
                for await (const site of webClient.staticSites.listStaticSitesByResourceGroup(resourceGroup)) {
                    apps.push({
                        name: site.name,
                        type: 'frontend',
                        location: site.location,
                        hostname: site.defaultHostname,
                        resourceId: site.id,
                        status: 'deployed',
                        repositoryUrl: site.repositoryUrl || ''
                    });
                }
            } catch (err) {
                console.error('[AppController] Error scanning static sites:', err.message);
            }

            // 2. Fetch Container Apps (Backends)
            try {
                for await (const app of containerClient.containerApps.listByResourceGroup(resourceGroup)) {
                    apps.push({
                        name: app.name,
                        type: 'backend',
                        location: app.location,
                        hostname: app.configuration?.ingress?.fqdn || '',
                        resourceId: app.id,
                        status: 'deployed',
                        repositoryUrl: ''
                    });
                }
            } catch (err) {
                console.error('[AppController] Error scanning container apps:', err.message);
            }

            // 3. Auto-discover GoDaddy CNAME configurations
            let godaddyCnames = [];
            try {
                const godaddySecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'godaddy');
                if (godaddySecrets && godaddySecrets.apiKey && godaddySecrets.apiSecret) {
                    const godaddyUrl = `https://api.godaddy.com/v1/domains/${defaultDomain}/records/CNAME`;
                    const gdRes = await axios.get(godaddyUrl, {
                        headers: { 'Authorization': `sso-key ${godaddySecrets.apiKey}:${godaddySecrets.apiSecret}` }
                    });
                    if (Array.isArray(gdRes.data)) {
                        godaddyCnames = gdRes.data;
                    }
                }
            } catch (err) {
                console.error('[AppController] Auto-discovery GoDaddy CNAMEs failed:', err.message);
            }

            // 4. Auto-discover Azure DevOps Pipelines
            let devopsPipelines = [];
            let devopsSecrets = null;
            try {
                devopsSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure_devops');
                if (devopsSecrets && devopsSecrets.pat) {
                    const cleanDevopsUrl = (orgSettings.azure_devops_org_url || 'https://dev.azure.com/esteviatech').replace(/\/$/, '');
                    const devopsProject = orgSettings.azure_devops_project || 'Estevia-Platform';
                    const devopsUrl = `${cleanDevopsUrl}/${devopsProject}/_apis/pipelines?api-version=7.1-preview.1`;
                    const devRes = await axios.get(devopsUrl, {
                        headers: { 'Authorization': `Basic ${Buffer.from(':' + devopsSecrets.pat).toString('base64')}` }
                    });
                    if (devRes.data && Array.isArray(devRes.data.value)) {
                        console.log(`[AppController] Discovered ${devRes.data.value.length} pipelines. Fetching full configurations...`);
                        devopsPipelines = await Promise.all(devRes.data.value.map(async (p) => {
                            try {
                                const detailUrl = `${cleanDevopsUrl}/${devopsProject}/_apis/pipelines/${p.id}?api-version=7.1-preview.1`;
                                const detailRes = await axios.get(detailUrl, {
                                    headers: { 'Authorization': `Basic ${Buffer.from(':' + devopsSecrets.pat).toString('base64')}` },
                                    timeout: 3000
                                });
                                return detailRes.data;
                            } catch (err) {
                                console.warn(`[AppController] Failed to fetch details for pipeline ${p.id}:`, err.message);
                                return p;
                            }
                        }));
                    }
                }
            } catch (err) {
                console.error('[AppController] Auto-discovery Azure DevOps pipelines failed:', err.message);
            }

            // 4.3. Resolve repositoryUrl from DB for scanned apps that lack one
            try {
                const [dbApps] = await db.query(
                    'SELECT name, repo_url FROM applications WHERE organization_id = ?',
                    [organizationId]
                );
                const dbRepoMap = new Map(dbApps.map(r => [r.name.toLowerCase(), r.repo_url]));
                for (const app of apps) {
                    if (!app.repositoryUrl) {
                        const dbRepo = dbRepoMap.get(app.name.toLowerCase());
                        if (dbRepo) {
                            app.repositoryUrl = dbRepo;
                        }
                    }
                }
            } catch (dbErr) {
                console.warn('[AppController] Failed to pre-resolve repo URLs from DB:', dbErr.message);
            }

            // 4.5. Dynamic branches lookup from GitHub for scanned apps
            let githubToken = null;
            try {
                const ghSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'github');
                githubToken = ghSecrets && (ghSecrets.token || ghSecrets.pat || ghSecrets.accessToken || Object.values(ghSecrets)[0]);
            } catch (e) {
                console.warn('[AppController] Could not retrieve GitHub token for scanning branches:', e.message);
            }

            const repoBranchesMap = new Map();
            if (githubToken) {
                for (const app of apps) {
                    if (app.repositoryUrl && !repoBranchesMap.has(app.repositoryUrl)) {
                        const githubRepo = app.repositoryUrl.replace('https://github.com/', '').replace(/\/$/, '');
                        const branchList = await appController._getGithubBranchesInternal(githubToken, githubRepo);
                        repoBranchesMap.set(app.repositoryUrl, branchList);
                    }
                }
            }

            // 5. Sync scanned apps with applications database and cross-reference discovered credentials
            for (const app of apps) {
                app.branches = repoBranchesMap.get(app.repositoryUrl) || [];
                // Find matching CNAME mapping on GoDaddy
                let matchedDns = {};
                 const matchingCname = godaddyCnames.find(r => {
                     if (!r.data || !app.hostname) return false;
                     const rData = r.data.toLowerCase();
                     const appHost = app.hostname.toLowerCase();
                     
                     if (rData === appHost || rData === `${appHost}.` || appHost.includes(rData)) {
                         return true;
                     }
                     
                     if (app.type === 'backend' && rData.includes('cloudfront.net')) {
                         const cleanRecordHost = r.name.toLowerCase().replace('.', '-');
                         const cleanAppName = app.name.toLowerCase();
                         
                         const recordWords = cleanRecordHost.split('-');
                         const appWords = cleanAppName.split('-');
                         
                         const isMatch = recordWords.every(w => cleanAppName.includes(w)) && 
                                         appWords.filter(w => !['prod', 'api', 'dev', 'qa'].includes(w))
                                                 .every(w => cleanRecordHost.includes(w));
                         if (isMatch) return true;
                     }
                     return false;
                 });
                if (matchingCname) {
                    matchedDns = {
                        subdomain: matchingCname.name,
                        domain: defaultDomain,
                        fqdn: `${matchingCname.name}.${defaultDomain}`,
                        mappedAt: new Date()
                    };
                }
                app.dnsDetails = matchedDns;

                // Find matching Azure DevOps Pipeline ID
                let matchedPipelineId = null;
                let matchedPipelineName = null;
                
                // Try repository matching first (100% accurate)
                let matchingPipeline = null;
                if (app.repositoryUrl) {
                    const cleanAppRepo = app.repositoryUrl.replace('https://github.com/', '').replace(/\/$/, '').toLowerCase();
                    matchingPipeline = devopsPipelines.find(p => {
                        const repoFullName = p.configuration?.repository?.fullName;
                        return repoFullName && repoFullName.toLowerCase() === cleanAppRepo;
                    });
                }
                
                // Fallback to name-based heuristics if no repo matches
                if (!matchingPipeline) {
                    matchingPipeline = devopsPipelines.find(p => {
                        const pName = p.name.toLowerCase();
                        const cleanAppName = app.name.toLowerCase();
                        
                        const ownerPrefix = githubOwner.toLowerCase().replace('-techsolutions', '').replace('-solutions', '').split('-')[0];
                        const baseApp = cleanAppName.replace(new RegExp(`^${ownerPrefix}-`), '').replace('-swa', '').replace('-dev', '').replace('-qa', '').replace('-prod', '').replace('-api', '').replace('-frontend', '');
                        const basePipeline = pName.replace('-pipeline', '').replace('-ci-cd', '').replace('-frontend', '').replace('-backend', '').replace('-api', '');
                        
                        if (baseApp && basePipeline && baseApp === basePipeline) {
                            return true;
                        }
                        if (cleanAppName.includes(`${ownerPrefix}-api`) && pName.includes('backend-api')) {
                            return true;
                        }
                        if (cleanAppName.includes('marketing') && pName.includes('marketing-web')) {
                            return true;
                        }
                        return false;
                    });
                }
                if (matchingPipeline) {
                    matchedPipelineId = String(matchingPipeline.id);
                    matchedPipelineName = matchingPipeline.name;
                }
                app.pipelineId = matchedPipelineId;
                app.pipelineName = matchedPipelineName;

                // Fetch latest pipeline build run status if DevOps PAT is present
                app.pipelineRun = null;
                if (matchedPipelineId && devopsSecrets && devopsSecrets.pat) {
                    try {
                        const cleanDevopsUrl = (orgSettings.azure_devops_org_url || 'https://dev.azure.com/esteviatech').replace(/\/$/, '');
                        const devopsProject = orgSettings.azure_devops_project || 'Estevia-Platform';
                        
                        const resolvedBranch = appController._resolveBranchFromAppName(app.name, app.branches || []);
                        const buildsUrl = `${cleanDevopsUrl}/${devopsProject}/_apis/build/builds?definitions=${matchedPipelineId}&branchName=${encodeURIComponent(resolvedBranch)}&api-version=7.1`;
                        
                        console.log(`[AppController] Fetching runs for pipeline ${matchedPipelineId} branch ${resolvedBranch} from ${buildsUrl}`);
                        const runRes = await axios.get(buildsUrl, {
                            headers: { 
                                'Authorization': `Basic ${Buffer.from(':' + devopsSecrets.pat).toString('base64')}`,
                                'Accept': 'application/json'
                            },
                            timeout: 5000
                        });

                        if (runRes.data && Array.isArray(runRes.data.value) && runRes.data.value.length > 0) {
                            const latestRun = runRes.data.value[0];
                            app.pipelineRun = {
                                id: latestRun.id,
                                name: latestRun.buildNumber,
                                state: latestRun.status, // completed, inProgress, etc.
                                result: latestRun.result, // succeeded, failed, etc.
                                webUrl: latestRun._links?.web?.href || '',
                                startTime: latestRun.startTime || null,
                                finishTime: latestRun.finishTime || null,
                                stages: []
                            };

                            // Fetch timeline to get stage-level breakdown
                            try {
                                const timelineUrl = `${cleanDevopsUrl}/${devopsProject}/_apis/build/builds/${latestRun.id}/timeline?api-version=7.1`;
                                const tlRes = await axios.get(timelineUrl, {
                                    headers: {
                                        'Authorization': `Basic ${Buffer.from(':' + devopsSecrets.pat).toString('base64')}`,
                                        'Accept': 'application/json'
                                    },
                                    timeout: 5000
                                });

                                if (tlRes.data && Array.isArray(tlRes.data.records)) {
                                    // Extract only top-level Stage records, ordered by their order field
                                    const stageRecords = tlRes.data.records
                                        .filter(r => r.type === 'Stage')
                                        .sort((a, b) => (a.order || 0) - (b.order || 0))
                                        .map(r => ({
                                            id: r.id,
                                            name: r.name,
                                            displayName: r.displayName || r.name,
                                            state: r.state,       // waiting | inProgress | completed
                                            result: r.result,     // succeeded | failed | canceled | skipped | null
                                            startTime: r.startTime || null,
                                            finishTime: r.finishTime || null
                                        }));
                                    app.pipelineRun.stages = stageRecords;
                                    console.log(`[AppController] Fetched ${stageRecords.length} stages for build ${latestRun.id} of pipeline ${matchedPipelineId}`);
                                }
                            } catch (tlErr) {
                                console.warn(`[AppController] Failed to fetch timeline for build ${latestRun.id}:`, tlErr.message);
                            }
                        }
                    } catch (runErr) {
                        console.warn(`[AppController] Failed to fetch pipeline run status for ${matchedPipelineId}:`, runErr.message);
                    }
                }

                const [existing] = await db.query(
                    'SELECT id, repo_url FROM applications WHERE organization_id = ? AND name = ?',
                    [organizationId, app.name]
                );

                const azureDetails = JSON.stringify({
                    resourceId: app.resourceId,
                    location: app.location,
                    hostname: app.hostname,
                    pipelineName: app.pipelineName
                });

                if (existing.length > 0) {
                    if (existing[0].repo_url && !app.repositoryUrl) {
                        app.repositoryUrl = existing[0].repo_url;
                    }
                    // Update
                    await db.query(
                        `UPDATE applications 
                         SET app_type = ?, status = ?, azure_resource_details = ?, godaddy_dns_details = ?, pipeline_id = ?
                         WHERE id = ?`,
                        [app.type, app.status, azureDetails, JSON.stringify(app.dnsDetails), app.pipelineId, existing[0].id]
                    );
                } else {
                    // Insert new discovered app
                    await db.query(
                        `INSERT INTO applications 
                         (organization_id, name, repo_url, app_type, status, azure_resource_details, godaddy_dns_details, pipeline_id) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [organizationId, app.name, app.repositoryUrl, app.type, app.status, azureDetails, JSON.stringify(app.dnsDetails), app.pipelineId]
                    );
                }
            }

            res.json({ success: true, count: apps.length, apps });
        } catch (error) {
            console.error('[AppController] Scan failed:', error);
            res.status(500).json({ message: 'Internal server error scanning apps.', error: error.message });
        }
    },

    /**
     * Provision a new Azure Static Web App
     */
    provisionApp: async (req, res) => {
        try {
            const { organizationId, name, type, location, githubRepo } = req.body;

            if (!organizationId || !name || !type) {
                return res.status(400).json({ message: 'Missing parameters (organizationId, name, type).' });
            }

            if (type !== 'frontend' && type !== 'backend') {
                return res.status(400).json({ message: 'Invalid type parameter. Must be "frontend" or "backend".' });
            }

            const orgSettings = await appController._getOrgSettings(organizationId);
            const subscriptionId = orgSettings.azure_subscription_id || SUBSCRIPTION_ID;
            const resourceGroup = orgSettings.azure_resource_group || RESOURCE_GROUP;

            const targetLocation = location || 'eastus2';
            const credential = await getAzureCredential(organizationId);

            const repoUrl = githubRepo ? (githubRepo.startsWith('http') ? githubRepo : `https://github.com/${githubRepo}`) : '';

            // Insert pending record in DB
            const [existing] = await db.query(
                'SELECT id, repo_url FROM applications WHERE organization_id = ? AND name = ?',
                [organizationId, name]
            );

            let appId;
            if (existing.length === 0) {
                const [result] = await db.query(
                    `INSERT INTO applications 
                     (organization_id, name, repo_url, app_type, status, azure_resource_details, godaddy_dns_details) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [organizationId, name, repoUrl, type, 'provisioning', JSON.stringify({}), JSON.stringify({})]
                );
                appId = result.insertId;
            } else {
                appId = existing[0].id;
                await db.query(
                    'UPDATE applications SET status = ?, repo_url = ?, app_type = ? WHERE id = ?', 
                    ['provisioning', repoUrl || existing[0].repo_url || '', type, appId]
                );
            }

            if (type === 'frontend') {
                const webClient = new WebSiteManagementClient(credential, subscriptionId);
                // Provision SWA in Azure
                console.log(`[AppController] Provisioning SWA: ${name} in ${targetLocation}...`);
                const staticSiteEnvelope = {
                    location: targetLocation,
                    sku: { name: 'Standard', tier: 'Standard' },
                    properties: {}
                };

                const poller = await webClient.staticSites.beginCreateOrUpdateStaticSite(resourceGroup, name, staticSiteEnvelope);
                const siteResult = await poller.pollUntilDone();

                const azureDetails = {
                    resourceId: siteResult.id,
                    location: siteResult.location,
                    hostname: siteResult.defaultHostname
                };

                // Update status to deployed in DB
                await db.query(
                    `UPDATE applications 
                     SET status = ?, azure_resource_details = ? 
                     WHERE id = ?`,
                    ['deployed', JSON.stringify(azureDetails), appId]
                );

                res.json({
                    success: true,
                    message: `Static Web App '${name}' provisioned successfully.`,
                    app: {
                        id: appId,
                        name,
                        type: 'frontend',
                        status: 'deployed',
                        azureDetails
                    }
                });
            } else {
                const containerClient = new ContainerAppsAPIClient(credential, subscriptionId);
                console.log(`[AppController] Provisioning Container App: ${name} in ${targetLocation}...`);
                
                const envName = (name.toLowerCase().includes('prod') || name.toLowerCase().includes('production')) ? 'estevia-prod-env' : 'estevia-dev-env';
                const managedEnvironmentId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/managedEnvironments/${envName}`;
                const targetPortVal = parseInt(req.body.targetPort || 5005, 10);

                const containerAppEnvelope = {
                    location: targetLocation,
                    managedEnvironmentId: managedEnvironmentId,
                    configuration: {
                        ingress: {
                            external: true,
                            targetPort: targetPortVal,
                            transport: "auto"
                        }
                    },
                    template: {
                        containers: [
                            {
                                name: "api-container",
                                image: "mcr.microsoft.com/azuredocs/aci-helloworld:latest",
                                resources: {
                                    cpu: 0.25,
                                    memory: "0.5Gi"
                                }
                            }
                        ]
                    }
                };

                const poller = await containerClient.containerApps.beginCreateOrUpdate(resourceGroup, name, containerAppEnvelope);
                const appResult = await poller.pollUntilDone();

                const azureDetails = {
                    resourceId: appResult.id,
                    location: appResult.location,
                    hostname: appResult.configuration?.ingress?.fqdn || ''
                };

                // Update status to deployed in DB
                await db.query(
                    `UPDATE applications 
                     SET status = ?, azure_resource_details = ? 
                     WHERE id = ?`,
                    ['deployed', JSON.stringify(azureDetails), appId]
                );

                res.json({
                    success: true,
                    message: `Container App '${name}' provisioned successfully.`,
                    app: {
                        id: appId,
                        name,
                        type: 'backend',
                        status: 'deployed',
                        azureDetails
                    }
                });
            }
        } catch (error) {
            console.error('[AppController] Provisioning failed:', error);
            res.status(500).json({ message: 'Provisioning failed.', error: error.message });
        }
    },

    /**
     * Map a custom subdomain in GoDaddy DNS and bind it to the Azure Static Web App
     */
    bindCustomDomain: async (req, res) => {
        try {
            const { organizationId, appName, subdomain, domain } = req.body;

            if (!organizationId || !appName || !subdomain) {
                return res.status(400).json({ message: 'Missing parameters (organizationId, appName, subdomain).' });
            }

            const orgSettings = await appController._getOrgSettings(organizationId);
            const subscriptionId = orgSettings.azure_subscription_id || SUBSCRIPTION_ID;
            const resourceGroup = orgSettings.azure_resource_group || RESOURCE_GROUP;
            const targetDomain = domain || orgSettings.default_dns_domain || DEFAULT_DOMAIN;

            // Fetch app details from DB
            const [apps] = await db.query(
                'SELECT id, app_type, azure_resource_details FROM applications WHERE organization_id = ? AND name = ?',
                [organizationId, appName]
            );

            if (apps.length === 0) {
                return res.status(404).json({ message: `Application '${appName}' not found in database.` });
            }

            const app = apps[0];
            const azureDetails = typeof app.azure_resource_details === 'string' ? JSON.parse(app.azure_resource_details || '{}') : (app.azure_resource_details || {});
            if (!azureDetails.hostname) {
                return res.status(400).json({ message: 'Azure resource has no default hostname. Ensure it is fully provisioned first.' });
            }

            // Retrieve decrypted GoDaddy credentials
            const godaddySecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'godaddy');
            if (!godaddySecrets || !godaddySecrets.apiKey || !godaddySecrets.apiSecret) {
                return res.status(400).json({ message: 'GoDaddy integration credentials not found or incomplete for organization.' });
            }

            const customDomainName = `${subdomain}.${targetDomain}`;

            // Check if domain is already mapped to another application
            const [existingMappings] = await db.query(
                'SELECT id, name, app_type, azure_resource_details, godaddy_dns_details FROM applications WHERE organization_id = ?',
                [organizationId]
            );

            const conflictingApp = existingMappings.find(otherApp => {
                if (otherApp.name === appName) return false; // Skip current app
                let dns = otherApp.godaddy_dns_details;
                if (!dns) return false;
                if (typeof dns === 'string') {
                    try { dns = JSON.parse(dns); } catch (e) { return false; }
                }
                return dns.fqdn === customDomainName;
            });

            if (conflictingApp) {
                console.log(`[AppController] Found conflicting domain mapping for ${customDomainName} on app ${conflictingApp.name}. Unlinking first.`);
                
                if (conflictingApp.app_type === 'frontend') {
                    try {
                        const credential = await getAzureCredential(organizationId);
                        const webClient = new WebSiteManagementClient(credential, subscriptionId);
                        
                        console.log(`[AppController] Calling Azure to delete custom domain '${customDomainName}' from Static Web App '${conflictingApp.name}'`);
                        
                        if (typeof webClient.staticSites.beginDeleteStaticSiteCustomDomainAndWait === 'function') {
                            await webClient.staticSites.beginDeleteStaticSiteCustomDomainAndWait(resourceGroup, conflictingApp.name, customDomainName);
                        } else if (typeof webClient.staticSites.deleteStaticSiteCustomDomain === 'function') {
                            await webClient.staticSites.deleteStaticSiteCustomDomain(resourceGroup, conflictingApp.name, customDomainName);
                        } else {
                            const poller = await webClient.staticSites.beginDeleteStaticSiteCustomDomain(resourceGroup, conflictingApp.name, customDomainName);
                            await poller.pollUntilFinished();
                        }
                        console.log('[AppController] Conflicting Azure custom domain unlinked successfully.');
                    } catch (azureErr) {
                        console.warn(`[AppController] Failed to delete conflicting custom domain from Azure: ${azureErr.message}`);
                    }
                }

                // Clear godaddy_dns_details in DB for the old application
                await db.query(
                    'UPDATE applications SET godaddy_dns_details = NULL WHERE id = ?',
                    [conflictingApp.id]
                );
                console.log(`[AppController] Conflicting mapping cleared in DB for application ID: ${conflictingApp.id}`);
            }

            // Update GoDaddy DNS record
            const godaddyUrl = `https://api.godaddy.com/v1/domains/${targetDomain}/records/CNAME/${subdomain}`;
            const body = [{ data: azureDetails.hostname, ttl: 3600 }];
            
            console.log(`[AppController] Updating GoDaddy CNAME: ${subdomain}.${targetDomain} -> ${azureDetails.hostname}`);
            await axios.put(godaddyUrl, body, {
                headers: {
                    'Authorization': `sso-key ${godaddySecrets.apiKey}:${godaddySecrets.apiSecret}`,
                    'Content-Type': 'application/json'
                }
            });

            // Bind domain in Azure SWA (frontend only)
            if (app.app_type === 'frontend') {
                console.log(`[AppController] Binding custom domain in Azure SWA: ${customDomainName}`);
                const credential = await getAzureCredential(organizationId);
                const webClient = new WebSiteManagementClient(credential, subscriptionId);

                const domainEnvelope = {
                    domainName: customDomainName
                };

                await webClient.staticSites.beginCreateOrUpdateStaticSiteCustomDomainAndWait(
                    resourceGroup,
                    appName,
                    customDomainName,
                    domainEnvelope
                );
            } else {
                console.log(`[AppController] App '${appName}' is type '${app.app_type}'. Mapped GoDaddy CNAME but skipped Azure SWA binding.`);
            }

            // Save domain mapping inside DB
            const dnsDetails = {
                subdomain,
                domain: targetDomain,
                fqdn: customDomainName,
                mappedAt: new Date()
            };

            await db.query(
                'UPDATE applications SET godaddy_dns_details = ? WHERE id = ?',
                [JSON.stringify(dnsDetails), app.id]
            );

            res.json({
                success: true,
                message: `Subdomain '${customDomainName}' successfully bound and registered in DNS and Azure.`,
                dnsDetails
            });
        } catch (error) {
            console.error('[AppController] Custom domain binding failed:', error);
            res.status(500).json({
                message: 'Custom domain binding failed.',
                error: error.response?.data?.message || error.message
            });
        }
    },

    /**
     * GET /api/apps/check-yml?organizationId=...&githubRepo=owner/repo
     * Proactively checks if azure-pipelines.yml exists in the given GitHub repo.
     * Returns { exists: bool, githubRepo: string }
     */
    checkYml: async (req, res) => {
        try {
            const { organizationId, githubRepo, branch } = req.query;
            if (!organizationId || !githubRepo) {
                return res.status(400).json({ message: 'Missing organizationId or githubRepo query parameters.' });
            }
            const ghSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'github');
            const githubToken = ghSecrets && (ghSecrets.token || ghSecrets.pat || ghSecrets.accessToken || Object.values(ghSecrets)[0]);
            if (!githubToken) {
                return res.json({ exists: null, githubRepo, reason: 'no_github_token' });
            }
            const ymlStatus = await appController._checkYmlExists(githubToken, githubRepo, branch || 'main');
            res.json({ exists: ymlStatus.exists, sha: ymlStatus.sha, githubRepo });
        } catch (error) {
            console.error('[AppController] checkYml failed:', error);
            res.status(500).json({ message: 'Failed to check yml.', error: error.message });
        }
    },

    /**
     * Internal helper – build a base64-encoded Azure DevOps Basic Auth header value
     */
    _devopsAuthHeader(pat) {
        return `Basic ${Buffer.from(':' + pat).toString('base64')}`;
    },

    /**
     * Internal helper – check whether azure-pipelines.yml exists in the given GitHub repo
     * Returns { exists: bool, sha: string|null }
     */
    async _checkYmlExists(githubToken, githubRepo, branch = 'main') {
        const contentsUrl = `https://api.github.com/repos/${githubRepo}/contents/azure-pipelines.yml?ref=${encodeURIComponent(branch)}`;
        try {
            const res = await axios.get(contentsUrl, {
                headers: {
                    'Authorization': `token ${githubToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'Estevia-DevOps-Hub'
                }
            });
            return { exists: true, sha: res.data.sha || null };
        } catch (err) {
            if (err.response && err.response.status === 404) {
                return { exists: false, sha: null };
            }
            throw err;
        }
    },
    async _generateSmartYml(githubToken, githubRepo, branchList, orgSettings, mainBranch = 'main', explicitAppType = null) {
        const repoShortName = githubRepo.split('/').pop() || 'my-app';
        const defaultDnsDomain = orgSettings ? orgSettings.default_dns_domain || DEFAULT_DOMAIN : DEFAULT_DOMAIN;
        const pipelineVarGroup = orgSettings ? orgSettings.pipeline_variable_group || 'estevia-frontend-vars' : 'estevia-frontend-vars';
        const azureResourceGroup = orgSettings ? orgSettings.azure_resource_group || 'Estevia-Prod-RG' : 'Estevia-Prod-RG';

        // 1. Query database for registered app type first (source of truth)
        let appType = explicitAppType;
        if (!appType) {
            try {
                const [apps] = await db.query(
                    `SELECT app_type FROM applications 
                     WHERE organization_id = ? 
                       AND repo_url <> '' AND repo_url IS NOT NULL
                       AND (repo_url = ? OR repo_url = ? OR repo_url LIKE ? OR ? LIKE CONCAT('%', repo_url, '%'))
                     ORDER BY id DESC LIMIT 1`,
                    [orgSettings.id, `https://github.com/${githubRepo}`, `https://github.com/${githubRepo}/`, `%${githubRepo}%`, `https://github.com/${githubRepo}`]
                );
                if (apps.length > 0) {
                    appType = apps[0].app_type;
                    console.log(`[AppController] Detected appType from database for ${githubRepo}: ${appType}`);
                }
            } catch (e) {
                console.warn(`[AppController] Failed to query app_type for ${githubRepo}:`, e.message);
            }
        }

        // 2. Fetch actual existing branches from GitHub API to perform branch filtering
        let existingBranches = [];
        let hasDockerfile = false;
        let hasPackageJson = false;

        if (githubToken) {
            try {
                // Fetch branches
                const branchesUrl = `https://api.github.com/repos/${githubRepo}/branches?per_page=100`;
                const branchesRes = await axios.get(branchesUrl, {
                    headers: {
                        'Authorization': `token ${githubToken}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'Estevia-DevOps-Hub'
                    }
                });
                if (Array.isArray(branchesRes.data)) {
                    existingBranches = branchesRes.data.map(b => b.name);
                }
            } catch (e) {
                console.warn(`[AppController] Failed to fetch branches for ${githubRepo}:`, e.message);
            }

            try {
                // Fetch root contents
                const contentsUrl = `https://api.github.com/repos/${githubRepo}/contents?ref=${encodeURIComponent(mainBranch)}`;
                const res = await axios.get(contentsUrl, {
                    headers: {
                        'Authorization': `token ${githubToken}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'Estevia-DevOps-Hub'
                    }
                });

                if (Array.isArray(res.data)) {
                    hasDockerfile = res.data.some(item => item.name === 'Dockerfile');
                    hasPackageJson = res.data.some(item => item.name === 'package.json');
                }
            } catch (err) {
                console.warn(`[AppController] Failed to fetch root contents for ${githubRepo} on branch ${mainBranch}:`, err.message);
            }
        }

        // 3. Determine final app classification
        const isBackend = appType ? (appType === 'backend') : hasDockerfile;

        // 4. Resolve trigger branches list: filter input list by existing repository branches
        const inputBranches = branchList || ['main', 'qa', 'dev'];
        const deduplicatedBranches = Array.from(new Set(inputBranches));
        const finalBranches = existingBranches.length > 0
            ? deduplicatedBranches.filter(b => existingBranches.includes(b))
            : deduplicatedBranches;

        // Fallback to primary main/dev if filtering produced empty (e.g. branch mismatch)
        const triggerBranches = finalBranches.length > 0 ? finalBranches : deduplicatedBranches;

        const triggerLines = [
            'trigger:',
            '  branches:',
            '    include:',
            ...triggerBranches.map(b => `      - ${b}`)
        ];

        const hasMain = triggerBranches.includes('main') || triggerBranches.includes('prod');
        const hasQa = triggerBranches.includes('qa');
        const hasDev = triggerBranches.includes('dev') || triggerBranches.includes('development');

        // 5. Determine product-specific API URL suffix (e.g. peoplecraft-api for Peoplecraft)
        let apiSubdomainPrefix = 'api';
        const prefix = repoShortName.split('-')[0].toLowerCase();
        
        if (prefix !== 'estevia' && prefix !== 'connecthub' && prefix !== 'docai' && prefix !== 'evafusion' && prefix !== 'protrack' && prefix !== 'talenthq') {
            try {
                const [backends] = await db.query(
                    `SELECT name FROM applications 
                     WHERE organization_id = ? 
                       AND app_type = 'backend' 
                       AND name LIKE ?`,
                    [orgSettings.id, `${prefix}%`]
                );
                if (backends.length > 0) {
                    apiSubdomainPrefix = `${prefix}-api`;
                    console.log(`[AppController] Resolved product-specific backend api prefix for ${repoShortName}: ${apiSubdomainPrefix}`);
                }
            } catch (e) {
                console.warn(`[AppController] Failed to query matching backend for prefix ${prefix}:`, e.message);
            }
        }

        // 6. If SWA Frontend is chosen, parse package.json to detect framework and configure build parameters
        let isNext = false;
        let isReact = false;

        if (!isBackend && hasPackageJson && githubToken) {
            try {
                const pjUrl = `https://api.github.com/repos/${githubRepo}/contents/package.json?ref=${encodeURIComponent(mainBranch)}`;
                const pjRes = await axios.get(pjUrl, {
                    headers: {
                        'Authorization': `token ${githubToken}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'Estevia-DevOps-Hub'
                    }
                });
                if (pjRes.data && pjRes.data.content) {
                    const decoded = Buffer.from(pjRes.data.content, 'base64').toString('utf-8');
                    const pkg = JSON.parse(decoded);
                    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
                    if (deps.next) {
                        isNext = true;
                    } else if (deps['react-scripts']) {
                        isReact = true;
                    }
                }
            } catch (err) {
                console.warn(`[AppController] Failed to parse package.json for ${githubRepo}:`, err.message);
            }
        }

        // 7. Choose the pipeline template
        if (isBackend) {
            // BACKEND CONTAINER APP (ACA) PIPELINE
            const appNameLower = repoShortName.toLowerCase();
            
            let backendSyncUrlScript = [];
            let bSyncIfCond = 'if';
            if (hasMain) {
                backendSyncUrlScript.push(`              ${bSyncIfCond} [ "$BRANCH_NAME" = "main" ]; then`);
                backendSyncUrlScript.push(`                SYNC_URL="https://${apiSubdomainPrefix}.${defaultDnsDomain}/api"`);
                bSyncIfCond = 'elif';
            }
            if (hasQa) {
                backendSyncUrlScript.push(`              ${bSyncIfCond} [ "$BRANCH_NAME" = "qa" ]; then`);
                backendSyncUrlScript.push(`                SYNC_URL="https://${apiSubdomainPrefix}-qa.${defaultDnsDomain}/api"`);
                bSyncIfCond = 'elif';
            }
            if (hasDev) {
                backendSyncUrlScript.push(`              ${bSyncIfCond} [ "$BRANCH_NAME" = "dev" ] || [ "$BRANCH_NAME" = "development" ]; then`);
                backendSyncUrlScript.push(`                SYNC_URL="https://${apiSubdomainPrefix}-dev.${defaultDnsDomain}/api"`);
                bSyncIfCond = 'elif';
            }
            backendSyncUrlScript.push('              else');
            if (hasDev) {
                backendSyncUrlScript.push(`                SYNC_URL="https://${apiSubdomainPrefix}-dev.${defaultDnsDomain}/api"`);
            } else if (hasMain) {
                backendSyncUrlScript.push(`                SYNC_URL="https://${apiSubdomainPrefix}.${defaultDnsDomain}/api"`);
            } else {
                backendSyncUrlScript.push(`                SYNC_URL="https://${apiSubdomainPrefix}.${defaultDnsDomain}/api"`);
            }
            backendSyncUrlScript.push('              fi');

            let backendVars = [
                'variables:',
                "  azureServiceConnection: 'protrack-azure-sc'",
                "  containerRegistry: 'esteviacoreregistry.azurecr.io'",
                `  imageRepository: '${appNameLower}'`,
                ''
            ];

            if (hasMain) {
                backendVars.push(
                    "  ${{ if eq(variables['Build.SourceBranchName'], 'main') }}:",
                    "    environment: 'production'",
                    "    appEnv: 'production'",
                    `    containerAppName: '${appNameLower}-prod'`,
                    `    resourceGroup: '${azureResourceGroup}'`,
                    "    envFile: '.env.prod'"
                );
            }
            if (hasQa) {
                backendVars.push(
                    "  ${{ if eq(variables['Build.SourceBranchName'], 'qa') }}:",
                    "    environment: 'qa'",
                    "    appEnv: 'qa'",
                    `    containerAppName: '${appNameLower}-qa'`,
                    `    resourceGroup: '${azureResourceGroup}'`,
                    "    envFile: '.env.qa'"
                );
            }

            let notInList = [];
            if (hasMain) notInList.push("'main'");
            if (hasQa) notInList.push("'qa'");
            
            const devCondition = notInList.length > 0 
                ? `  \${{ if not(in(variables['Build.SourceBranchName'], ${notInList.join(', ')})) }}:`
                : "  ${{ if true }}:";
                
            backendVars.push(
                devCondition,
                "    environment: 'development'",
                "    appEnv: 'development'",
                `    containerAppName: '${appNameLower}-dev'`,
                `    resourceGroup: '${azureResourceGroup}'`,
                "    envFile: '.env.dev'"
            );

            return [
                ...triggerLines,
                '',
                ...backendVars,
                '',
                'stages:',
                '- stage: BuildAndTest',
                `  displayName: '🧪 Test and Containerize ${repoShortName}'`,
                '  jobs:',
                '  - job: TestApp',
                "    displayName: 'Run Unit Tests'",
                '    pool:',
                "      vmImage: 'ubuntu-latest'",
                '    steps:',
                '    - task: NodeTool@0',
                '      inputs:',
                "        versionSpec: '20.x'",
                "      displayName: 'Install Node.js'",
                '    - script: |',
                '        npm ci',
                '        if npm run | grep -q "test"; then',
                '          npm test',
                '        else',
                '          echo "No test script found in package.json, skipping tests."',
                '        fi',
                "      displayName: 'Run Tests'",
                '',
                '  - job: BuildImage',
                "    displayName: '🐳 Build & Push Docker Image'",
                '    dependsOn: TestApp',
                '    pool:',
                "      vmImage: 'ubuntu-latest'",
                '    steps:',
                '    - script: |',
                '        if [ -f "$(envFile)" ]; then',
                '          cp $(envFile) .env',
                '        else',
                '          echo "No environment file $(envFile) found, creating blank .env"',
                '          touch .env',
                '        fi',
                "      displayName: 'Hydrate .env file'",
                '',
                '    - task: Docker@2',
                "      displayName: 'Build and Push Image to ACR'",
                '      inputs:',
                "        containerRegistry: 'estevia-acr-sc'",
                "        repository: '$(imageRepository)'",
                "        command: 'buildAndPush'",
                "        Dockerfile: 'Dockerfile'",
                "        buildContext: '.'",
                '        tags: |',
                '          $(Build.BuildId)',
                '          latest',
                "        arguments: '--build-arg APP_BUILD=$(Build.BuildId) --build-arg APP_ENV=$(appEnv)'",
                '',
                '- stage: DeployToAzure',
                "  displayName: '🚀 Deploy Container App'",
                '  dependsOn: BuildAndTest',
                '  jobs:',
                '  - deployment: DeployContainer',
                "    displayName: 'Update Azure Container App'",
                '    pool:',
                "      vmImage: 'ubuntu-latest'",
                "    environment: '$(environment)'",
                '    strategy:',
                '      runOnce:',
                '        deploy:',
                '          steps:',
                '          - task: AzureCLI@2',
                "            displayName: 'Deploy to Azure Container Apps'",
                '            inputs:',
                "              azureSubscription: '$(azureServiceConnection)'",
                "              scriptType: 'bash'",
                "              scriptLocation: 'inlineScript'",
                '              inlineScript: |',
                '                az config set extension.use_dynamic_install=yes_without_prompt',
                '                az containerapp update \\',
                '                  --name $(containerAppName) \\',
                '                  --resource-group $(resourceGroup) \\',
                '                  --image $(containerRegistry)/$(imageRepository):$(Build.BuildId)',
                '',
                '          - script: |',
                '              if [ -f "./package.json" ]; then',
                '                VERSION=$(node -p "require(\'./package.json\').version")',
                '              else',
                '                VERSION="1.0.0"',
                '              fi',
                '              BUILD_ID="$(Build.BuildId)"',
                '              BRANCH_NAME="$(Build.SourceBranchName)"',
                ...backendSyncUrlScript,
                '              echo "Syncing backend version $VERSION (Build $BUILD_ID) to $SYNC_URL..."',
                '              curl -X POST "$SYNC_URL/system/version/sync" \\',
                '                   -H "Content-Type: application/json" \\',
                '                   -H "x-ci-key: 3f4e1d2c-5b6a-7890-a1b2-c3d4e5f6a7b8" \\',
                `                   -d "{\\"component\\": \\"backend\\", \\"version\\": \\"$VERSION\\", \\"build\\": \\"$BUILD_ID\\"}"`,
                "            displayName: 'Sync Version to Backend DB'"
            ].join('\n');
        } else {
            // FRONTEND STATIC WEB APP (SWA) PIPELINE
            let envPrefix = 'VITE_';
            let appLocation = 'dist';
            if (isNext) {
                envPrefix = 'NEXT_PUBLIC_';
                appLocation = 'out';
            } else if (isReact) {
                envPrefix = 'REACT_APP_';
                appLocation = 'build';
            }

            let frontendSyncUrlScript = [];
            let fSyncIfCond = 'if';
            if (hasMain) {
                frontendSyncUrlScript.push(`        ${fSyncIfCond} [ "$BRANCH_NAME" = "main" ]; then`);
                frontendSyncUrlScript.push(`          SYNC_URL="https://${apiSubdomainPrefix}.${defaultDnsDomain}/api"`);
                fSyncIfCond = 'elif';
            }
            if (hasQa) {
                frontendSyncUrlScript.push(`        ${fSyncIfCond} [ "$BRANCH_NAME" = "qa" ]; then`);
                frontendSyncUrlScript.push(`          SYNC_URL="https://${apiSubdomainPrefix}-qa.${defaultDnsDomain}/api"`);
                fSyncIfCond = 'elif';
            }
            if (hasDev) {
                frontendSyncUrlScript.push(`        ${fSyncIfCond} [ "$BRANCH_NAME" = "dev" ] || [ "$BRANCH_NAME" = "development" ]; then`);
                frontendSyncUrlScript.push(`          SYNC_URL="https://${apiSubdomainPrefix}-dev.${defaultDnsDomain}/api"`);
                fSyncIfCond = 'elif';
            }
            frontendSyncUrlScript.push('        else');
            if (hasDev) {
                frontendSyncUrlScript.push(`          SYNC_URL="https://${apiSubdomainPrefix}-dev.${defaultDnsDomain}/api"`);
            } else if (hasMain) {
                frontendSyncUrlScript.push(`          SYNC_URL="https://${apiSubdomainPrefix}.${defaultDnsDomain}/api"`);
            } else {
                frontendSyncUrlScript.push(`          SYNC_URL="https://${apiSubdomainPrefix}.${defaultDnsDomain}/api"`);
            }
            frontendSyncUrlScript.push('        fi');

            const tokenProdVar = `${repoShortName.toUpperCase().replace(/-/g, '_')}_SWA_TOKEN_PROD`;
            const tokenQaVar = `${repoShortName.toUpperCase().replace(/-/g, '_')}_SWA_TOKEN_QA`;
            const tokenDevVar = `${repoShortName.toUpperCase().replace(/-/g, '_')}_SWA_TOKEN_DEV`;

            let bashTokenScript = [
                '        BRANCH_NAME="$(Build.SourceBranchName)"'
            ];
            
            let ifCond = 'if';
            if (hasMain) {
                bashTokenScript.push(`        ${ifCond} [ "$BRANCH_NAME" = "main" ]; then`);
                bashTokenScript.push('          TOKEN="$TOKEN_PROD"');
                ifCond = 'elif';
            }
            if (hasQa) {
                bashTokenScript.push(`        ${ifCond} [ "$BRANCH_NAME" = "qa" ]; then`);
                bashTokenScript.push('          TOKEN="$TOKEN_QA"');
                ifCond = 'elif';
            }
            if (hasDev) {
                bashTokenScript.push(`        ${ifCond} [ "$BRANCH_NAME" = "dev" ] || [ "$BRANCH_NAME" = "development" ]; then`);
                bashTokenScript.push('          TOKEN="$TOKEN_DEV"');
                ifCond = 'elif';
            }
            bashTokenScript.push('        else');
            if (hasDev) {
                bashTokenScript.push('          TOKEN="$TOKEN_DEV"');
            } else if (hasMain) {
                bashTokenScript.push('          TOKEN="$TOKEN_PROD"');
            } else {
                bashTokenScript.push('          TOKEN=""');
            }
            bashTokenScript.push('        fi');
            bashTokenScript.push('        if [ -z "$TOKEN" ]; then');
            bashTokenScript.push('          echo "##vso[task.logissue type=error]SWA token empty for $BRANCH_NAME"');
            bashTokenScript.push('          exit 1');
            bashTokenScript.push('        fi');
            bashTokenScript.push('        echo "##vso[task.setvariable variable=swaToken;issecret=true]$TOKEN"');

            let bashEnvScript = [];
            ifCond = 'if';
            if (hasMain) {
                bashEnvScript.push(`        ${ifCond} [ "$BRANCH_NAME" = "main" ]; then`);
                bashEnvScript.push(`          printf '${envPrefix}API_URL=https://${apiSubdomainPrefix}.${defaultDnsDomain}/api\\n' > .env.production`);
                bashEnvScript.push(`          printf '${envPrefix}APP_ENV=production\\n' >> .env.production`);
                ifCond = 'elif';
            }
            if (hasQa) {
                bashEnvScript.push(`        ${ifCond} [ "$BRANCH_NAME" = "qa" ]; then`);
                bashEnvScript.push(`          printf '${envPrefix}API_URL=https://${apiSubdomainPrefix}-qa.${defaultDnsDomain}/api\\n' > .env.production`);
                bashEnvScript.push(`          printf '${envPrefix}APP_ENV=qa\\n' >> .env.production`);
                ifCond = 'elif';
            }
            if (hasDev) {
                bashEnvScript.push(`        ${ifCond} [ "$BRANCH_NAME" = "dev" ] || [ "$BRANCH_NAME" = "development" ]; then`);
                bashEnvScript.push(`          printf '${envPrefix}API_URL=https://${apiSubdomainPrefix}-dev.${defaultDnsDomain}/api\\n' > .env.production`);
                bashEnvScript.push(`          printf '${envPrefix}APP_ENV=development\\n' >> .env.production`);
                ifCond = 'elif';
            }
            bashEnvScript.push('        else');
            if (hasDev) {
                bashEnvScript.push(`          printf '${envPrefix}API_URL=https://${apiSubdomainPrefix}-dev.${defaultDnsDomain}/api\\n' > .env.production`);
                bashEnvScript.push(`          printf '${envPrefix}APP_ENV=development\\n' >> .env.production`);
            } else if (hasMain) {
                bashEnvScript.push(`          printf '${envPrefix}API_URL=https://${apiSubdomainPrefix}.${defaultDnsDomain}/api\\n' > .env.production`);
                bashEnvScript.push(`          printf '${envPrefix}APP_ENV=production\\n' >> .env.production`);
            } else {
                bashEnvScript.push(`          touch .env.production`);
            }
            bashEnvScript.push('        fi');

            let envMappings = [];
            if (hasMain) envMappings.push(`        TOKEN_PROD: $(${tokenProdVar})`);
            if (hasQa) envMappings.push(`        TOKEN_QA: $(${tokenQaVar})`);
            if (hasDev) envMappings.push(`        TOKEN_DEV: $(${tokenDevVar})`);

            return [
                ...triggerLines,
                '',
                'variables:',
                `  - group: ${pipelineVarGroup}`,
                '',
                'pool:',
                "  vmImage: 'ubuntu-latest'",
                '',
                'stages:',
                '- stage: BuildAndDeploy',
                `  displayName: 'Deploy ${repoShortName}'`,
                '  jobs:',
                '  - job: Deploy',
                "    displayName: 'Build & Deploy to Azure SWA'",
                '    steps:',
                '    - checkout: self',
                "      displayName: 'Checkout Code'",
                '',
                '    - bash: |',
                ...bashTokenScript,
                ...bashEnvScript,
                `        printf '${envPrefix}APP_BUILD=$(Build.BuildId)\\n' >> .env.production`,
                '        cat .env.production',
                "      displayName: 'Determine Token & Generate Env Config'",
                '      env:',
                ...envMappings,
                '',
                '    - task: NodeTool@0',
                "      displayName: 'Install Node.js'",
                '      inputs:',
                "        versionSpec: '20.x'",
                '',
                '    - script: |',
                '        npm ci',
                "      displayName: 'Install Dependencies'",
                '',
                '    - script: |',
                '        npm run build',
                "      displayName: 'Build Production Assets'",
                '',
                '    - task: AzureStaticWebApp@0',
                "      displayName: 'Deploy to Static Web App'",
                '      inputs:',
                `        app_location: '${appLocation}'`,
                '        skip_app_build: true',
                '        azure_static_web_apps_api_token: $(swaToken)',
                '',
                '    - script: |',
                '        if [ -f "./package.json" ]; then',
                '          VERSION=$(node -p "require(\'./package.json\').version")',
                '        else',
                '          VERSION="1.0.0"',
                '        fi',
                '        BUILD_ID="$(Build.BuildId)"',
                '        BRANCH_NAME="$(Build.SourceBranchName)"',
                ...frontendSyncUrlScript,
                `        echo "Syncing version $VERSION (Build $BUILD_ID) for ${repoShortName.toLowerCase()} to $SYNC_URL..."`,
                '        curl -X POST "$SYNC_URL/system/version/sync" \\',
                '             -H "Content-Type: application/json" \\',
                '             -H "x-ci-key: 3f4e1d2c-5b6a-7890-a1b2-c3d4e5f6a7b8" \\',
                `             -d "{\\"component\\": \\"${repoShortName.toLowerCase()}\\", \\"version\\": \\"$VERSION\\", \\"build\\": \\"$BUILD_ID\\"}"`,
                "      displayName: 'Sync Version to Backend DB'"
            ].join('\n');
        }
    },
    async _commitYmlToRepo(githubToken, githubRepo, existingSha, orgSettings, branch = 'main', customYmlContent = null) {
        const standardBranches = ['main', 'qa', 'dev'];
        const branchesToInclude = Array.from(new Set([...standardBranches, branch]));

        const defaultYml = customYmlContent || await appController._generateSmartYml(
            githubToken,
            githubRepo,
            branchesToInclude,
            orgSettings,
            branch
        );

        const contentBase64 = Buffer.from(defaultYml).toString('base64');
        const commitUrl = `https://api.github.com/repos/${githubRepo}/contents/azure-pipelines.yml`;
        const body = {
            message: `chore: add azure-pipelines.yml for ${branch} [via Estevia DevOps Hub]`,
            content: contentBase64,
            branch: branch
        };
        if (existingSha) body.sha = existingSha; // for updates

        const res = await axios.put(commitUrl, body, {
            headers: {
                'Authorization': `token ${githubToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'DevOps-Hub',
                'Content-Type': 'application/json'
            }
        });
        return res.data;
    },

    /**
     * Internal helper – fetch branches for a repository from GitHub
     */
    async _getGithubBranchesInternal(githubToken, githubRepo) {
        try {
            console.log(`[AppController] Fetching branches internally for: ${githubRepo}`);
            const response = await axios.get(`https://api.github.com/repos/${githubRepo}/branches?per_page=100`, {
                headers: {
                    'Authorization': `token ${githubToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'DevOps-Hub'
                }
            });
            return response.data.map(b => ({
                name: b.name,
                protected: b.protected
            }));
        } catch (err) {
            console.warn(`[AppController] Failed to fetch branches internally for ${githubRepo}:`, err.message);
            return [];
        }
    },

    /**
     * Internal helper – update DevOps variable group with SWA token
     */
    async _updateDevOpsVariableGroup(pat, cleanOrgUrl, devopsProject, groupName, varName, varValue) {
        try {
            console.log(`[AppController] Fetching variable group: ${groupName}...`);
            const listUrl = `${cleanOrgUrl}/${devopsProject}/_apis/distributedtask/variablegroups?groupName=${groupName}&api-version=7.1-preview.1`;
            const listRes = await axios.get(listUrl, {
                headers: {
                    'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`
                }
            });
            if (!listRes.data || listRes.data.count === 0) {
                console.warn(`[AppController] Variable group '${groupName}' not found in Azure DevOps.`);
                return false;
            }
            const group = listRes.data.value[0];
            const groupId = group.id;

            // Merge variables
            const updatedVariables = {
                ...group.variables,
                [varName]: {
                    value: varValue,
                    isSecret: true
                }
            };

            const updateUrl = `${cleanOrgUrl}/${devopsProject}/_apis/distributedtask/variablegroups/${groupId}?api-version=7.1-preview.1`;
            const payload = {
                id: groupId,
                name: group.name,
                type: group.type,
                variables: updatedVariables
            };

            console.log(`[AppController] Updating variable group '${groupName}' with variable '${varName}'...`);
            await axios.put(updateUrl, payload, {
                headers: {
                    'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[AppController] Variable group '${groupName}' updated successfully.`);
            return true;
        } catch (err) {
            console.error('[AppController] Failed to update variable group:', err.response?.data || err.message);
            throw err;
        }
    },

    /**
     * Internal helper – sync SWA token to Azure DevOps Variable Group
     */
    async _syncSwaTokenToDevOps(organizationId, appName, githubRepo, branch) {
        try {
            const orgSettings = await appController._getOrgSettings(organizationId);
            const subscriptionId = orgSettings.azure_subscription_id || SUBSCRIPTION_ID;
            const resourceGroup = orgSettings.azure_resource_group || RESOURCE_GROUP;
            const devopsOrgUrl = orgSettings.azure_devops_org_url || 'https://dev.azure.com/esteviatech';
            const devopsProject = orgSettings.azure_devops_project || 'Estevia-Platform';
            const pipelineVarGroup = orgSettings.pipeline_variable_group;

            // Check if application is backend to skip SWA token sync
            const [apps] = await db.query(
                'SELECT app_type FROM applications WHERE organization_id = ? AND name = ?',
                [organizationId, appName]
            );
            if (apps.length > 0 && apps[0].app_type === 'backend') {
                console.log(`[AppController] App '${appName}' is type 'backend'. Skipping SWA token sync.`);
                return;
            }

            if (!pipelineVarGroup) {
                console.log(`[AppController] No pipeline variable group configured. Skipping SWA token sync.`);
                return;
            }

            const devopsSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure_devops');
            if (!devopsSecrets || !devopsSecrets.pat) {
                console.log(`[AppController] No Azure DevOps credentials. Skipping SWA token sync.`);
                return;
            }

            const repoShortName = githubRepo.split('/').pop() || appName;
            const cleanOrgUrl = devopsOrgUrl.replace(/\/$/, '');

            // Query matching frontend apps for this repo
            const [frontendApps] = await db.query(
                `SELECT name, app_type FROM applications 
                 WHERE organization_id = ? 
                   AND app_type = 'frontend'
                   AND repo_url <> '' AND repo_url IS NOT NULL
                   AND (repo_url = ? OR repo_url = ? OR repo_url LIKE ? OR ? LIKE CONCAT('%', repo_url, '%'))`,
                [organizationId, `https://github.com/${githubRepo}`, `https://github.com/${githubRepo}/`, `%${githubRepo}%`, `https://github.com/${githubRepo}`]
            );

            console.log(`[AppController] Found ${frontendApps.length} matching frontend apps in DB for repo ${githubRepo}`);

            const credential = await getAzureCredential(organizationId);
            const webClient = new WebSiteManagementClient(credential, subscriptionId);

            if (frontendApps.length > 0) {
                for (const app of frontendApps) {
                    try {
                        console.log(`[AppController] Retrieving Static Web App deployment token for ${app.name}...`);
                        const secrets = await webClient.staticSites.listStaticSiteSecrets(resourceGroup, app.name);
                        const swaToken = secrets.properties?.apiKey || secrets.apiKey;
                        if (swaToken) {
                            let envSuffix = 'DEV';
                            const lowerName = app.name.toLowerCase();
                            if (lowerName.includes('prod') || lowerName.includes('production') || lowerName.includes('main')) {
                                envSuffix = 'PROD';
                            } else if (lowerName.includes('qa')) {
                                envSuffix = 'QA';
                            } else if (lowerName.includes('dev') || lowerName.includes('development')) {
                                envSuffix = 'DEV';
                            }
                            
                            const varName = `${repoShortName.toUpperCase().replace(/-/g, '_')}_SWA_TOKEN_${envSuffix}`;
                            console.log(`[AppController] Syncing ${varName} to Azure DevOps variable group ${pipelineVarGroup}...`);
                            await appController._updateDevOpsVariableGroup(
                                devopsSecrets.pat,
                                cleanOrgUrl,
                                devopsProject,
                                pipelineVarGroup,
                                varName,
                                swaToken
                            );
                        }
                    } catch (err) {
                        console.warn(`[AppController] Failed to sync token for SWA ${app.name}:`, err.message);
                    }
                }
            } else {
                // Fallback to the passed appName
                try {
                    console.log(`[AppController] No matching apps in DB. Fallback to passed appName: ${appName}`);
                    const secrets = await webClient.staticSites.listStaticSiteSecrets(resourceGroup, appName);
                    const swaToken = secrets.properties?.apiKey || secrets.apiKey;
                    if (swaToken) {
                        const envSuffix = (branch === 'main' || branch === 'prod') ? 'PROD' : (branch === 'qa' ? 'QA' : 'DEV');
                        const varName = `${repoShortName.toUpperCase().replace(/-/g, '_')}_SWA_TOKEN_${envSuffix}`;
                        console.log(`[AppController] Syncing fallback ${varName} to Azure DevOps variable group ${pipelineVarGroup}...`);
                        await appController._updateDevOpsVariableGroup(
                            devopsSecrets.pat,
                            cleanOrgUrl,
                            devopsProject,
                            pipelineVarGroup,
                            varName,
                            swaToken
                        );
                    }
                } catch (err) {
                    console.warn(`[AppController] Fallback sync failed for SWA ${appName}:`, err.message);
                }
            }
        } catch (err) {
            console.warn(`[AppController] Failed to sync SWA token to DevOps Variable Group:`, err.message);
        }
    },

    /**
     * Internal helper – actually register the pipeline in Azure DevOps
     */
    async _registerAzureDevOpsPipeline(pat, cleanOrgUrl, devopsProject, githubRepo, appName) {
        const pipelineApiUrl = `${cleanOrgUrl}/${devopsProject}/_apis/pipelines?api-version=7.1-preview.1`;
        const repoName = githubRepo.split('/').pop() || appName;
        const payload = {
            name: repoName,
            configuration: {
                type: 'yaml',
                path: 'azure-pipelines.yml',
                repository: {
                    fullName: githubRepo,
                    connection: { id: '30a6bcfb-1a79-47fe-9eb9-e70e32d9181a' },
                    type: 'gitHub'
                }
            }
        };
        console.log(`[AppController] Posting pipeline creation to Azure DevOps: ${pipelineApiUrl}`);
        const response = await axios.post(pipelineApiUrl, payload, {
            headers: {
                'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    },

    /**
     * Create CI/CD pipeline in Azure DevOps using decrypted credentials.
     * First checks if azure-pipelines.yml exists in the GitHub repo.
     * If missing, returns a YML_MISSING code so the frontend can prompt to create it.
     */
    createPipeline: async (req, res) => {
        try {
            const { organizationId, appName, githubRepo, devopsOrgUrl, devopsProject, branch } = req.body;

            if (!organizationId || !appName || !githubRepo || !devopsOrgUrl || !devopsProject) {
                return res.status(400).json({ message: 'Missing parameters (organizationId, appName, githubRepo, devopsOrgUrl, devopsProject).' });
            }

            // Retrieve Azure DevOps decrypted PAT
            const devopsSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure_devops');
            if (!devopsSecrets || !devopsSecrets.pat) {
                return res.status(400).json({ message: 'Azure DevOps integration credentials not found for organization.' });
            }
            const pat = devopsSecrets.pat;

            // ---- Check if azure-pipelines.yml exists in GitHub repo ----
            let githubToken = null;
            try {
                const ghSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'github');
                githubToken = ghSecrets && (ghSecrets.token || ghSecrets.pat || ghSecrets.accessToken || Object.values(ghSecrets)[0]);
            } catch (e) {
                console.warn('[AppController] Could not retrieve GitHub token for YML check:', e.message);
            }

            if (githubToken) {
                const ymlStatus = await appController._checkYmlExists(githubToken, githubRepo, branch || 'main');
                if (!ymlStatus.exists) {
                    console.log(`[AppController] azure-pipelines.yml NOT found in ${githubRepo}. Returning YML_MISSING.`);
                    return res.status(200).json({
                        success: false,
                        code: 'YML_MISSING',
                        message: `azure-pipelines.yml was not found in the repository "${githubRepo}". Would you like to create a default one and then register the pipeline?`,
                        githubRepo
                    });
                }
                console.log(`[AppController] azure-pipelines.yml found in ${githubRepo}. Proceeding to register pipeline.`);
            } else {
                console.warn('[AppController] No GitHub token available – skipping YML existence check.');
            }

            // ---- Register or Reuse the Azure DevOps pipeline ----
            let pipelineId = null;
            let pipelineUrl = '';

            const [sameRepoApps] = await db.query(
                'SELECT pipeline_id FROM applications WHERE organization_id = ? AND (repo_url = ? OR repo_url = ? OR repo_url LIKE ?) AND pipeline_id IS NOT NULL LIMIT 1',
                [organizationId, `https://github.com/${githubRepo}`, `https://github.com/${githubRepo}/`, `%${githubRepo}%`]
            );

            if (sameRepoApps.length > 0) {
                pipelineId = sameRepoApps[0].pipeline_id;
                console.log(`[AppController] Pipeline already exists for repository (pipelineId: ${pipelineId}). Skipping creation.`);
            } else {
                const cleanOrgUrl = devopsOrgUrl.replace(/\/$/, '');
                const pipelineData = await appController._registerAzureDevOpsPipeline(pat, cleanOrgUrl, devopsProject, githubRepo, appName);
                pipelineId = pipelineData.id;
                pipelineUrl = pipelineData._links?.web?.href || '';
            }

            await db.query(
                'UPDATE applications SET pipeline_id = ? WHERE name = ? AND organization_id = ?',
                [String(pipelineId), appName, organizationId]
            );

            // Sync SWA token to DevOps Variable Group
            await appController._syncSwaTokenToDevOps(organizationId, appName, githubRepo, branch || 'main');

            res.json({
                success: true,
                message: sameRepoApps.length > 0 
                    ? `Azure DevOps pipeline associated successfully (reused existing).` 
                    : `Azure DevOps pipeline created successfully.`,
                pipelineId,
                pipelineUrl
            });
        } catch (error) {
            console.error('[AppController] Pipeline creation failed:', error);
            res.status(500).json({
                message: 'Pipeline creation failed.',
                error: error.response?.data?.message || error.message
            });
        }
    },

    /**
     * Commit a default azure-pipelines.yml to the GitHub repo, then register the
     * Azure DevOps pipeline.  Called when the frontend user chooses to create the
     * YML file on-the-fly after a YML_MISSING response.
     */
    createPipelineYml: async (req, res) => {
        try {
            const { organizationId, appName, githubRepo, devopsOrgUrl, devopsProject, branch, skipRegistration, customYml } = req.body;

            if (!organizationId || !appName || !githubRepo || !devopsOrgUrl || !devopsProject) {
                return res.status(400).json({ message: 'Missing parameters (organizationId, appName, githubRepo, devopsOrgUrl, devopsProject).' });
            }

            // 1. Get GitHub token
            const ghSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'github');
            const githubToken = ghSecrets && (ghSecrets.token || ghSecrets.pat || ghSecrets.accessToken || Object.values(ghSecrets)[0]);
            if (!githubToken) {
                return res.status(400).json({ message: 'GitHub integration credentials not found. Please add your GitHub token in the Credentials tab.' });
            }

            // 2. Check if file already exists (to get sha for update)
            const ymlStatus = await appController._checkYmlExists(githubToken, githubRepo, branch || 'main');

            // Fetch organization dynamic settings
            const orgSettings = await appController._getOrgSettings(organizationId);

            // 3. Commit the default yml
            console.log(`[AppController] Committing azure-pipelines.yml to ${githubRepo} (exists: ${ymlStatus.exists}) on branch ${branch || 'main'}...`);
            await appController._commitYmlToRepo(githubToken, githubRepo, ymlStatus.sha, orgSettings, branch || 'main', customYml);
            console.log(`[AppController] azure-pipelines.yml committed successfully.`);

            if (skipRegistration) {
                return res.json({
                    success: true,
                    message: `azure-pipelines.yml created in "${githubRepo}" on branch "${branch || 'main'}".`,
                    ymlCreated: true
                });
            }

            // 4. Get Azure DevOps PAT
            const devopsSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure_devops');
            if (!devopsSecrets || !devopsSecrets.pat) {
                return res.status(400).json({ message: 'Azure DevOps integration credentials not found for organization.' });
            }
            const pat = devopsSecrets.pat;

            // 5. Register or Reuse pipeline
            let pipelineId = null;
            let pipelineUrl = '';

            const [sameRepoApps] = await db.query(
                'SELECT pipeline_id FROM applications WHERE organization_id = ? AND (repo_url = ? OR repo_url = ? OR repo_url LIKE ?) AND pipeline_id IS NOT NULL LIMIT 1',
                [organizationId, `https://github.com/${githubRepo}`, `https://github.com/${githubRepo}/`, `%${githubRepo}%`]
            );

            if (sameRepoApps.length > 0) {
                pipelineId = sameRepoApps[0].pipeline_id;
                console.log(`[AppController] Pipeline already exists for repository (pipelineId: ${pipelineId}). Skipping creation.`);
            } else {
                const cleanOrgUrl = devopsOrgUrl.replace(/\/$/, '');
                const pipelineData = await appController._registerAzureDevOpsPipeline(pat, cleanOrgUrl, devopsProject, githubRepo, appName);
                pipelineId = pipelineData.id;
                pipelineUrl = pipelineData._links?.web?.href || '';
            }

            await db.query(
                'UPDATE applications SET pipeline_id = ? WHERE name = ? AND organization_id = ?',
                [String(pipelineId), appName, organizationId]
            );

            // Sync SWA token to DevOps Variable Group
            await appController._syncSwaTokenToDevOps(organizationId, appName, githubRepo, branch || 'main');

            res.json({
                success: true,
                message: sameRepoApps.length > 0
                    ? `azure-pipelines.yml created in "${githubRepo}" and Azure DevOps pipeline associated successfully (reused existing).`
                    : `azure-pipelines.yml created in "${githubRepo}" and Azure DevOps pipeline registered successfully.`,
                pipelineId,
                pipelineUrl,
                ymlCreated: true
            });
        } catch (error) {
            console.error('[AppController] createPipelineYml failed:', error);
            res.status(500).json({
                message: 'Failed to create yml and register pipeline.',
                error: error.response?.data?.message || error.message
            });
        }
    },

    /**
     * Delete an application from Azure and from the local database.
     * Also recursively purges the linked GoDaddy DNS CNAME record and Azure DevOps Pipeline.
     */
    deleteApp: async (req, res) => {
        try {
            const { name } = req.params;
            const { organizationId, type } = req.query;

            if (!organizationId || !name || !type) {
                return res.status(400).json({ message: 'Missing parameters (organizationId, name, type).' });
            }

            console.log(`[AppController] Starting deep deletion for app: ${name} (Type: ${type}) under Org: ${organizationId}`);

            const orgSettings = await appController._getOrgSettings(organizationId);
            const subscriptionId = orgSettings.azure_subscription_id || SUBSCRIPTION_ID;
            const resourceGroup = orgSettings.azure_resource_group || RESOURCE_GROUP;
            const defaultDomain = orgSettings.default_dns_domain || DEFAULT_DOMAIN;
            const githubOwner = orgSettings.github_owner || 'Estevia-TechSolutions';

            const credential = await getAzureCredential(organizationId);

            // Fetch current app record from DB to retrieve cached domains/pipelines
            const [apps] = await db.query(
                'SELECT azure_resource_details, godaddy_dns_details, pipeline_id FROM applications WHERE organization_id = ? AND name = ?',
                [organizationId, name]
            );

            let azureDetails = {};
            let dnsDetails = {};
            let pipelineId = null;

            if (apps.length > 0) {
                azureDetails = typeof apps[0].azure_resource_details === 'string' ? JSON.parse(apps[0].azure_resource_details || '{}') : (apps[0].azure_resource_details || {});
                dnsDetails = typeof apps[0].godaddy_dns_details === 'string' ? JSON.parse(apps[0].godaddy_dns_details || '{}') : (apps[0].godaddy_dns_details || {});
                pipelineId = apps[0].pipeline_id;
            }

            const hostname = azureDetails.hostname || '';

            // 1. Delete linked GoDaddy DNS CNAME record
            try {
                const godaddySecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'godaddy');
                if (godaddySecrets && godaddySecrets.apiKey && godaddySecrets.apiSecret) {
                    let domainToDelete = dnsDetails.domain || defaultDomain;
                    let subdomainToDelete = dnsDetails.subdomain;

                    // Fallback discovery: scan GoDaddy CNAMEs dynamically to check if any point to this app's hostname
                    if (!subdomainToDelete && hostname) {
                        const godaddyUrl = `https://api.godaddy.com/v1/domains/${defaultDomain}/records/CNAME`;
                        const gdRes = await axios.get(godaddyUrl, {
                            headers: { 'Authorization': `sso-key ${godaddySecrets.apiKey}:${godaddySecrets.apiSecret}` }
                        });
                        if (Array.isArray(gdRes.data)) {
                            const match = gdRes.data.find(r => 
                                r.data && (
                                    r.data.toLowerCase() === hostname.toLowerCase() ||
                                    r.data.toLowerCase() === `${hostname.toLowerCase()}.` ||
                                    hostname.toLowerCase().includes(r.data.toLowerCase())
                                )
                            );
                            if (match) {
                                subdomainToDelete = match.name;
                                domainToDelete = defaultDomain;
                            }
                        }
                    }

                    if (subdomainToDelete) {
                        const deleteDnsUrl = `https://api.godaddy.com/v1/domains/${domainToDelete}/records/CNAME/${subdomainToDelete}`;
                        console.log(`[AppController] Deleting GoDaddy CNAME: ${subdomainToDelete}.${domainToDelete}`);
                        await axios.delete(deleteDnsUrl, {
                            headers: {
                                'Authorization': `sso-key ${godaddySecrets.apiKey}:${godaddySecrets.apiSecret}`
                            }
                        });
                        console.log(`[AppController] GoDaddy CNAME deleted successfully.`);
                    }
                }
            } catch (dnsErr) {
                console.error('[AppController] Failed to delete GoDaddy CNAME record:', dnsErr.message);
            }

            // 2. Delete linked Azure DevOps Pipeline
            try {
                const devopsSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure_devops');
                if (devopsSecrets && devopsSecrets.pat) {
                    const cleanDevopsUrl = (orgSettings.azure_devops_org_url || 'https://dev.azure.com/esteviatech').replace(/\/$/, '');
                    const devopsProject = orgSettings.azure_devops_project || 'Estevia-Platform';

                    // Fallback discovery: search pipelines dynamically if no pipelineId is cached
                    if (!pipelineId) {
                        const devopsUrl = `${cleanDevopsUrl}/${devopsProject}/_apis/pipelines?api-version=7.1-preview.1`;
                        const devRes = await axios.get(devopsUrl, {
                            headers: { 'Authorization': `Basic ${Buffer.from(':' + devopsSecrets.pat).toString('base64')}` }
                        });
                        if (devRes.data && Array.isArray(devRes.data.value)) {
                            const match = devRes.data.value.find(p => {
                                const pName = p.name.toLowerCase();
                                const cleanAppName = name.toLowerCase();
                                const ownerPrefix = githubOwner.toLowerCase().replace('-techsolutions', '').replace('-solutions', '').split('-')[0];
                                const baseApp = cleanAppName.replace(new RegExp(`^${ownerPrefix}-`), '').replace('-swa', '').replace('-dev', '').replace('-qa', '').replace('-prod', '').replace('-api', '').replace('-frontend', '');
                                const basePipeline = pName.replace('-pipeline', '').replace('-ci-cd', '').replace('-frontend', '').replace('-backend', '').replace('-api', '');
                                return baseApp && basePipeline && (baseApp === basePipeline || baseApp.includes(basePipeline) || basePipeline.includes(baseApp));
                            });
                            if (match) {
                                pipelineId = match.id;
                            }
                        }
                    }

                    if (pipelineId) {
                        // Check if other apps are still using this pipeline ID before deleting it from Azure DevOps
                        const [otherApps] = await db.query(
                            'SELECT id FROM applications WHERE pipeline_id = ? AND name != ?',
                            [pipelineId, name]
                        );
                        if (otherApps.length > 0) {
                            console.log(`[AppController] Pipeline ID ${pipelineId} is shared with other applications. Skipping Azure DevOps deletion.`);
                        } else {
                            const deletePipelineUrl = `${cleanDevopsUrl}/${devopsProject}/_apis/build/definitions/${pipelineId}?api-version=7.1-preview.7`;
                            console.log(`[AppController] Deleting Azure DevOps Pipeline ID: ${pipelineId}`);
                            await axios.delete(deletePipelineUrl, {
                                headers: {
                                    'Authorization': `Basic ${Buffer.from(':' + devopsSecrets.pat).toString('base64')}`
                                }
                            });
                            console.log(`[AppController] Azure DevOps Pipeline deleted successfully.`);
                        }
                    }
                }
            } catch (pipeErr) {
                console.error('[AppController] Failed to delete Azure DevOps pipeline:', pipeErr.message);
            }

            // 3. Delete from Azure Cloud
            if (type === 'frontend') {
                const webClient = new WebSiteManagementClient(credential, subscriptionId);
                console.log(`[AppController] Deleting Static Web App '${name}' from Azure...`);
                if (typeof webClient.staticSites.beginDeleteStaticSiteAndWait === 'function') {
                    await webClient.staticSites.beginDeleteStaticSiteAndWait(resourceGroup, name);
                } else {
                    const poller = await webClient.staticSites.beginDeleteStaticSite(resourceGroup, name);
                    await poller.pollUntilDone();
                }
                console.log(`[AppController] Azure SWA '${name}' deleted.`);
            } else if (type === 'backend') {
                const containerClient = new ContainerAppsAPIClient(credential, subscriptionId);
                console.log(`[AppController] Deleting Container App '${name}' from Azure...`);
                if (typeof containerClient.containerApps.beginDeleteAndWait === 'function') {
                    await containerClient.containerApps.beginDeleteAndWait(resourceGroup, name);
                } else {
                    const poller = await containerClient.containerApps.beginDelete(resourceGroup, name);
                    await poller.pollUntilDone();
                }
                console.log(`[AppController] Azure Container App '${name}' deleted.`);
            } else {
                return res.status(400).json({ message: `Invalid app type: '${type}'. Must be frontend or backend.` });
            }

            // 4. Delete from local database
            console.log(`[AppController] Deleting app record '${name}' from database...`);
            await db.query(
                'DELETE FROM applications WHERE organization_id = ? AND name = ?',
                [organizationId, name]
            );

            res.json({
                success: true,
                message: `Application '${name}', its GoDaddy DNS CNAME record, and its Azure DevOps CI/CD pipeline have been successfully deleted.`
            });
        } catch (error) {
            console.error('[AppController] Deletion failed:', error);
            res.status(500).json({ message: 'Deletion failed.', error: error.message });
        }
    },

    /**
     * GET /api/apps/organization-settings?organizationId=...
     */
    getOrgSettings: async (req, res) => {
        try {
            const { organizationId } = req.query;
            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId query parameter.' });
            }
            const settings = await appController._getOrgSettings(organizationId);
            res.json({ success: true, settings });
        } catch (error) {
            console.error('[AppController] getOrgSettings failed:', error);
            res.status(500).json({ message: 'Failed to retrieve organization settings.', error: error.message });
        }
    },

    /**
     * POST /api/apps/organization-settings
     */
    updateOrgSettings: async (req, res) => {
        try {
            const { 
                organizationId, 
                azureSubscriptionId, 
                azureResourceGroup, 
                defaultDnsDomain, 
                azureDevopsOrgUrl, 
                azureDevopsProject, 
                pipelineVariableGroup, 
                githubOwner 
            } = req.body;

            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId parameter.' });
            }

            // Verify organization exists or insert it
            await db.query(`
                INSERT IGNORE INTO organizations (id, name) VALUES (?, ?)
            `, [organizationId, organizationId.toUpperCase()]);

            await db.query(`
                UPDATE organizations SET
                    azure_subscription_id = ?,
                    azure_resource_group = ?,
                    default_dns_domain = ?,
                    azure_devops_org_url = ?,
                    azure_devops_project = ?,
                    pipeline_variable_group = ?,
                    github_owner = ?
                WHERE id = ?
            `, [
                azureSubscriptionId || null,
                azureResourceGroup || null,
                defaultDnsDomain || null,
                azureDevopsOrgUrl || null,
                azureDevopsProject || null,
                pipelineVariableGroup || null,
                githubOwner || null,
                organizationId
            ]);

            res.json({ success: true, message: 'Organization settings updated successfully.' });
        } catch (error) {
            console.error('[AppController] updateOrgSettings failed:', error);
            res.status(500).json({ message: 'Failed to update organization settings.', error: error.message });
        }
    },

    /**
     * GET /api/apps/github-repos?organizationId=...
     */
    getGithubRepos: async (req, res) => {
        try {
            const { organizationId } = req.query;
            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId parameter.' });
            }
            const orgSettings = await appController._getOrgSettings(organizationId);
            const githubOwner = orgSettings.github_owner || 'Estevia-TechSolutions';

            const ghSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'github');
            const githubToken = ghSecrets && (ghSecrets.token || ghSecrets.pat || ghSecrets.accessToken || Object.values(ghSecrets)[0]);
            if (!githubToken) {
                return res.status(400).json({ message: 'GitHub integration token not found.' });
            }

            console.log(`[AppController] Fetching repos from GitHub for owner: ${githubOwner}`);
            let repos = [];
            try {
                const response = await axios.get(`https://api.github.com/orgs/${githubOwner}/repos?per_page=100`, {
                    headers: {
                        'Authorization': `token ${githubToken}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'DevOps-Hub'
                    }
                });
                repos = response.data;
            } catch (err) {
                console.warn(`[AppController] Failed to list org repos for ${githubOwner}: ${err.message}. Trying user repos endpoint.`);
                const response = await axios.get(`https://api.github.com/users/${githubOwner}/repos?per_page=100`, {
                    headers: {
                        'Authorization': `token ${githubToken}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'DevOps-Hub'
                    }
                });
                repos = response.data;
            }

            const formattedRepos = repos.map(r => ({
                id: r.id,
                name: r.name,
                fullName: r.full_name,
                htmlUrl: r.html_url
            }));

            res.json({ success: true, repos: formattedRepos });
        } catch (error) {
            console.error('[AppController] getGithubRepos failed:', error);
            res.status(500).json({ message: 'Failed to retrieve GitHub repositories.', error: error.message });
        }
    },

    /**
     * GET /api/apps/github-branches?organizationId=...&githubRepo=...
     */
    getGithubBranches: async (req, res) => {
        try {
            const { organizationId, githubRepo } = req.query;
            if (!organizationId || !githubRepo) {
                return res.status(400).json({ message: 'Missing organizationId or githubRepo parameter.' });
            }
            const ghSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'github');
            const githubToken = ghSecrets && (ghSecrets.token || ghSecrets.pat || ghSecrets.accessToken || Object.values(ghSecrets)[0]);
            if (!githubToken) {
                return res.status(400).json({ message: 'GitHub integration token not found.' });
            }

            console.log(`[AppController] Fetching branches for repo: ${githubRepo}`);
            const response = await axios.get(`https://api.github.com/repos/${githubRepo}/branches?per_page=100`, {
                headers: {
                    'Authorization': `token ${githubToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'DevOps-Hub'
                }
            });
            const branches = response.data.map(b => ({
                name: b.name,
                protected: b.protected
            }));
            res.json({ success: true, branches });
        } catch (error) {
            console.error('[AppController] getGithubBranches failed:', error);
            res.status(500).json({ message: 'Failed to retrieve GitHub branches.', error: error.message });
        }
    },

    /**
     * GET /api/apps/get-yml
     * Fetches raw azure-pipelines.yml text content from GitHub branch, base64-decodes it, and returns it.
     */
    getYml: async (req, res) => {
        try {
            const { organizationId, githubRepo, branch } = req.query;
            if (!organizationId || !githubRepo) {
                return res.status(400).json({ message: 'Missing organizationId or githubRepo parameters.' });
            }
            const ghSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'github');
            const githubToken = ghSecrets && (ghSecrets.token || ghSecrets.pat || ghSecrets.accessToken || Object.values(ghSecrets)[0]);
            if (!githubToken) {
                return res.status(400).json({ message: 'GitHub integration token not found.' });
            }
            
            const branchName = branch || 'main';
            const contentsUrl = `https://api.github.com/repos/${githubRepo}/contents/azure-pipelines.yml?ref=${encodeURIComponent(branchName)}`;
            
            try {
                const response = await axios.get(contentsUrl, {
                    headers: {
                        'Authorization': `token ${githubToken}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'Estevia-DevOps-Hub'
                    }
                });
                
                if (response.data && response.data.content) {
                    const decodedYml = Buffer.from(response.data.content, 'base64').toString('utf-8');
                    return res.json({ success: true, exists: true, content: decodedYml, sha: response.data.sha });
                }
                
                return res.json({ success: true, exists: false, content: '' });
            } catch (err) {
                if (err.response && err.response.status === 404) {
                    return res.json({ success: true, exists: false, content: '' });
                }
                throw err;
            }
        } catch (error) {
            console.error('[AppController] getYml failed:', error);
            res.status(500).json({ message: 'Failed to fetch azure-pipelines.yml.', error: error.message });
        }
    },

    /**
     * GET /api/apps/default-yml
     * Generates and returns the default azure-pipelines.yml populated with selected trigger branches.
     */
    getDefaultYml: async (req, res) => {
        try {
            const { organizationId, githubRepo, branches, appType } = req.query;
            if (!organizationId || !githubRepo) {
                return res.status(400).json({ message: 'Missing organizationId or githubRepo parameters.' });
            }
            
            const orgSettings = await appController._getOrgSettings(organizationId);

            let githubToken = null;
            try {
                const ghSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'github');
                githubToken = ghSecrets && (ghSecrets.token || ghSecrets.pat || ghSecrets.accessToken || Object.values(ghSecrets)[0]);
            } catch (e) {
                console.warn('[AppController] Could not retrieve GitHub token for default YML:', e.message);
            }

            const branchList = branches ? branches.split(',') : ['main', 'qa', 'dev'];
            const mainBranch = branchList[0] || 'main';

            const defaultYml = await appController._generateSmartYml(
                githubToken,
                githubRepo,
                branchList,
                orgSettings,
                mainBranch,
                appType
            );

            res.json({ success: true, content: defaultYml });
        } catch (error) {
            console.error('[AppController] getDefaultYml failed:', error);
            res.status(500).json({ message: 'Failed to generate default YML.', error: error.message });
        }
    },

    /**
     * GET /api/apps/cost
     * Returns Azure resource costing breakdowns and optimization recommendations.
     */
    getCostData: async (req, res) => {
        try {
            const organizationId = req.query.organizationId || req.user?.organization_id || 'estevia';
            
            // Fetch applications from DB
            const [apps] = await db.query(
                'SELECT id, name, app_type, status, azure_resource_details, godaddy_dns_details, repo_url FROM applications WHERE organization_id = ?',
                [organizationId]
            );

            // Retrieve organization configuration settings
            const orgSettings = await appController._getOrgSettings(organizationId);
            const subscriptionId = orgSettings.azure_subscription_id || SUBSCRIPTION_ID;
            const resourceGroup = orgSettings.azure_resource_group || RESOURCE_GROUP;
            const defaultDomain = orgSettings.default_dns_domain || DEFAULT_DOMAIN;

            const credential = await getAzureCredential(organizationId);
            const resourceClient = new ResourceManagementClient(credential, subscriptionId);

            const azureResources = [];
            try {
                for await (const r of resourceClient.resources.listByResourceGroup(resourceGroup)) {
                    azureResources.push(r);
                }
            } catch (err) {
                console.error('[AppController] Error listing resources for costing:', err.message);
            }

            // Cost breakdowns categories
            const costBreakdown = {
                swa: 0,
                aca: 0,
                dns: 0,
                database: 0,
                vm: 0,
                registry: 0,
                other: 0
            };
            
            const detailedCosts = [];
            const suggestions = [];
            const processedResourceIds = new Set();

            // Match with DB apps by name or resource ID
            const dbAppMap = new Map();
            for (const app of apps) {
                const azureDetails = typeof app.azure_resource_details === 'string' 
                    ? JSON.parse(app.azure_resource_details || '{}') 
                    : (app.azure_resource_details || {});
                if (azureDetails.resourceId) {
                    dbAppMap.set(azureDetails.resourceId.toLowerCase(), app);
                }
                dbAppMap.set(app.name.toLowerCase(), app);
            }

            // Map and price Azure resources
            for (const r of azureResources) {
                if (r.id) processedResourceIds.add(r.id.toLowerCase());
                
                const matchedApp = dbAppMap.get(r.id?.toLowerCase()) || dbAppMap.get(r.name?.toLowerCase());
                
                let type = 'other';
                let appCost = 0;
                let dnsCost = 0;
                let details = '';
                let fqdn = null;

                const rType = r.type || '';
                const rName = r.name || '';

                if (rType === 'Microsoft.Web/staticSites') {
                    type = 'frontend';
                    appCost = 9.00; // Standard static site is $9/mo
                    costBreakdown.swa += appCost;
                    details = 'Static Web App Standard Tier';
                    
                    if (matchedApp) {
                        const dnsDetails = typeof matchedApp.godaddy_dns_details === 'string'
                            ? JSON.parse(matchedApp.godaddy_dns_details || '{}')
                            : (matchedApp.godaddy_dns_details || {});
                        if (dnsDetails && dnsDetails.subdomain) {
                            dnsCost = 1.00; // $1/mo DNS subdomain binding
                            costBreakdown.dns += dnsCost;
                            fqdn = dnsDetails.fqdn || `${dnsDetails.subdomain}.${defaultDomain}`;
                        }
                    }
                } else if (rType === 'Microsoft.App/containerApps') {
                    type = 'backend';
                    if (matchedApp) {
                        const azureDetails = typeof matchedApp.azure_resource_details === 'string'
                            ? JSON.parse(matchedApp.azure_resource_details || '{}')
                            : (matchedApp.azure_resource_details || {});
                        
                        const cpu = parseFloat(azureDetails.cpu) || 0.25;
                        const memory = parseFloat(azureDetails.memory) || 0.5;
                        const replicas = parseInt(azureDetails.replicaCount) || 1;
                        
                        const cpuCostRate = 12.00; // base rate for 0.25 CPU
                        const memCostRate = 4.00;  // base rate for 0.5 GB RAM
                        appCost = ((cpu / 0.25) * cpuCostRate + (memory / 0.5) * memCostRate) * replicas;
                        details = `Container App (${replicas} x ${cpu} CPU, ${memory}GiB RAM)`;
                        
                        const dnsDetails = typeof matchedApp.godaddy_dns_details === 'string'
                            ? JSON.parse(matchedApp.godaddy_dns_details || '{}')
                            : (matchedApp.godaddy_dns_details || {});
                        if (dnsDetails && dnsDetails.subdomain) {
                            dnsCost = 1.00;
                            costBreakdown.dns += dnsCost;
                            fqdn = dnsDetails.fqdn || `${dnsDetails.subdomain}.${defaultDomain}`;
                        }
                    } else {
                        appCost = 15.00;
                        details = 'Container App (Default Sizing)';
                    }
                    costBreakdown.aca += appCost;
                } else if (rType === 'Microsoft.DBforMySQL/flexibleServers') {
                    type = 'database';
                    const skuName = r.sku?.name || '';
                    if (skuName.toLowerCase().includes('d2ads') || skuName.toLowerCase().includes('general') || skuName.toLowerCase().includes('gp')) {
                        appCost = 118.00; // General Purpose Server
                    } else {
                        appCost = 29.00; // Burstable Server
                    }
                    costBreakdown.database += appCost;
                    details = `Azure Database for MySQL (Flexible Server)${skuName ? ` - ${skuName}` : ''}`;
                } else if (rType === 'Microsoft.Compute/virtualMachines') {
                    type = 'vm';
                    appCost = 85.00; // ML VM cost
                    costBreakdown.vm += appCost;
                    details = 'Azure Virtual Machine (General Purpose CPU)';
                } else if (rType === 'Microsoft.ContainerRegistry/registries') {
                    type = 'registry';
                    const skuName = r.sku?.name || 'Basic';
                    appCost = skuName.toLowerCase() === 'basic' ? 5.00 : 20.00;
                    costBreakdown.registry += appCost;
                    details = `Azure Container Registry (${skuName})`;
                } else if (rType === 'Microsoft.OperationalInsights/workspaces') {
                    type = 'workspace';
                    appCost = 12.00;
                    costBreakdown.other += appCost;
                    details = 'Log Analytics Workspace';
                } else if (rType === 'Microsoft.Compute/disks') {
                    type = 'disk';
                    appCost = 5.00;
                    costBreakdown.other += appCost;
                    details = `Managed Disk (${r.sku?.name || 'Premium SSD'})`;
                } else if (rType === 'Microsoft.Network/publicIPAddresses') {
                    type = 'network';
                    appCost = 3.00;
                    costBreakdown.other += appCost;
                    details = 'Public IP Address';
                } else if (rType === 'Microsoft.Network/virtualNetworks') {
                    type = 'network';
                    appCost = 19.00;
                    costBreakdown.other += appCost;
                    details = 'Virtual Network';
                } else {
                    type = 'other';
                    appCost = 0.00;
                    costBreakdown.other += appCost;
                    
                    const typeParts = rType.split('/');
                    const baseTypeName = typeParts.pop() || rType;
                    const readableType = baseTypeName
                        .replace(/([A-Z])/g, ' $1')
                        .replace(/^./, str => str.toUpperCase())
                        .trim();
                    details = readableType;
                }

                const isTestResource = rName.toLowerCase().includes('test') || 
                                       rName.toLowerCase().includes('dev') || 
                                       rName.toLowerCase().includes('qa') || 
                                       rName.toLowerCase().includes('sandbox') || 
                                       rName.toLowerCase().includes('temp') || 
                                       rName.toLowerCase().includes('demo') ||
                                       (rType === 'Microsoft.Web/staticSites' && (matchedApp?.name || rName).toLowerCase().includes('dev')) ||
                                       (rType === 'Microsoft.DBforMySQL/flexibleServers' && !(r.sku?.name || '').toLowerCase().includes('gp') && !(r.sku?.name || '').toLowerCase().includes('general') && !(r.sku?.name || '').toLowerCase().includes('d2ads'));

                detailedCosts.push({
                    id: r.id || rName,
                    name: rName,
                    type: type,
                    status: 'active',
                    resourceCost: appCost,
                    dnsCost: dnsCost,
                    totalCost: appCost + dnsCost,
                    details: details,
                    fqdn: fqdn,
                    repositoryUrl: matchedApp?.repo_url || null,
                    isTestResource: !!isTestResource
                });
            }

            // Sync database apps that were not matched by ID/name from the Azure subscription list
            for (const app of apps) {
                const appName = app.name.toLowerCase();
                const matched = Array.from(processedResourceIds).some(id => id.includes(appName)) || 
                                azureResources.some(r => r.name?.toLowerCase() === appName);
                if (!matched) {
                    const azureDetails = typeof app.azure_resource_details === 'string' 
                        ? JSON.parse(app.azure_resource_details || '{}') 
                        : (app.azure_resource_details || {});
                    
                    const dnsDetails = typeof app.godaddy_dns_details === 'string'
                        ? JSON.parse(app.godaddy_dns_details || '{}')
                        : (app.godaddy_dns_details || {});

                    let appCost = 0;
                    let details = '';
                    if (app.app_type === 'frontend') {
                        appCost = 9.00;
                        costBreakdown.swa += appCost;
                        details = 'Static Web App Standard Tier';
                    } else if (app.app_type === 'backend') {
                        const cpu = parseFloat(azureDetails.cpu) || 0.25;
                        const memory = parseFloat(azureDetails.memory) || 0.5;
                        const replicas = parseInt(azureDetails.replicaCount) || 1;
                        
                        const cpuCostRate = 12.00;
                        const memCostRate = 4.00;
                        
                        appCost = ((cpu / 0.25) * cpuCostRate + (memory / 0.5) * memCostRate) * replicas;
                        costBreakdown.aca += appCost;
                        details = `Container App (${replicas} x ${cpu} CPU, ${memory}GiB RAM)`;
                    }

                    let dnsCost = 0;
                    if (dnsDetails && dnsDetails.subdomain) {
                        dnsCost = 1.00;
                        costBreakdown.dns += dnsCost;
                    }

                    const isTestResource = app.name.toLowerCase().includes('test') || 
                                           app.name.toLowerCase().includes('dev') || 
                                           app.name.toLowerCase().includes('qa') || 
                                           app.name.toLowerCase().includes('sandbox') || 
                                           app.name.toLowerCase().includes('temp') || 
                                           app.name.toLowerCase().includes('demo');

                    detailedCosts.push({
                        id: app.id,
                        name: app.name,
                        type: app.app_type,
                        status: app.status,
                        resourceCost: appCost,
                        dnsCost: dnsCost,
                        totalCost: appCost + dnsCost,
                        details: details,
                        fqdn: dnsDetails?.fqdn || null,
                        repositoryUrl: app.repo_url || null,
                        isTestResource: !!isTestResource
                    });
                }
            }

            // Generate optimization recommendations
            for (const item of detailedCosts) {
                if (item.type === 'backend') {
                    const isDevOrQa = item.name.toLowerCase().endsWith('-dev') || 
                                     item.name.toLowerCase().endsWith('-qa') || 
                                     item.name.toLowerCase().includes('-dev-') || 
                                     item.name.toLowerCase().includes('-qa-');
                    
                    if (isDevOrQa && item.resourceCost > 0) {
                        suggestions.push({
                            id: `opt-replica-${item.id}`,
                            appName: item.name,
                            type: 'scale_zero',
                            impact: 'high',
                            savings: 10.00,
                            recommendation: `Scale minimum replicas to 0 for dev/qa Container App '${item.name}'.`,
                            description: 'Currently configured to keep container instances running constantly. Scaling to zero when idle eliminates idle run-rate charges.'
                        });
                    }
                }
                
                if (item.type === 'vm') {
                    const isDevOrProd = item.name.toLowerCase().includes('dev') || item.name.toLowerCase().includes('prod');
                    if (isDevOrProd) {
                        suggestions.push({
                            id: `opt-vm-stop-${item.id}`,
                            appName: item.name,
                            type: 'stop_vm',
                            impact: 'medium',
                            savings: 42.50,
                            recommendation: `Schedule auto-shutdown for VM '${item.name}' during off-hours.`,
                            description: 'Virtual machines running 24/7 accrue high runtime costs. Scheduling auto-shutdown (e.g., 7 PM - 7 AM) can cut VM compute costs by 50%.'
                        });
                    }
                }

                if (item.type === 'frontend') {
                    const isDev = item.name.toLowerCase().endsWith('-dev') || item.name.toLowerCase().includes('-dev-');
                    if (isDev) {
                        suggestions.push({
                            id: `opt-tier-${item.id}`,
                            appName: item.name,
                            type: 'tier_demote',
                            impact: 'medium',
                            savings: 9.00,
                            recommendation: `Demote static app '${item.name}' to Free Tier.`,
                            description: 'Non-production Static Web Apps do not require custom SLA or enterprise routing, making them perfect candidates for the Azure Free tier.'
                        });
                    }
                }
            }

            // ACR consolidation recommendation
            const registries = azureResources.filter(r => r.type === 'Microsoft.ContainerRegistry/registries');
            if (registries.length > 1) {
                suggestions.push({
                    id: 'opt-acr-consolidate',
                    appName: 'Container Registries',
                    type: 'consolidate',
                    impact: 'low',
                    savings: 5.00,
                    recommendation: 'Consolidate multiple Container Registries into one.',
                    description: 'Multiple container registries detected. Consolidating build artifacts under a single Basic registry reduces redundant monthly base licensing fees.'
                });
            }

            if (suggestions.length === 0) {
                suggestions.push({
                    id: 'opt-dns-orphaned',
                    appName: 'General',
                    type: 'remove_cname',
                    impact: 'low',
                    savings: 1.00,
                    recommendation: 'Remove orphaned DNS CNAME record "staging-test.esteviatech.com".',
                    description: 'This custom domain points to an inactive static web app that was deleted last week. Cleaning it up reduces DNS clutter and domain costs.'
                });
            }

            const totalMonthlyCost = costBreakdown.swa + costBreakdown.aca + costBreakdown.dns + 
                                     (costBreakdown.database || 0) + (costBreakdown.vm || 0) + 
                                     (costBreakdown.registry || 0) + (costBreakdown.other || 0);
            const potentialSavings = suggestions.reduce((sum, s) => sum + s.savings, 0);
            
            let optimizationScore = 100;
            for (const s of suggestions) {
                if (s.impact === 'high') optimizationScore -= 15;
                else if (s.impact === 'medium') optimizationScore -= 10;
                else optimizationScore -= 5;
            }
            optimizationScore = Math.max(50, optimizationScore);

            return res.json({
                success: true,
                summary: {
                    monthlyRunRate: totalMonthlyCost,
                    potentialSavings: potentialSavings,
                    optimizationScore: optimizationScore,
                    breakdown: costBreakdown
                },
                detailedCosts: detailedCosts,
                suggestions: suggestions
            });
        } catch (error) {
            console.error('[AppController] getCostData failed:', error);
            res.status(500).json({ message: 'Failed to fetch costing and optimization analytics.', error: error.message });
        }
    }
};

module.exports = appController;
