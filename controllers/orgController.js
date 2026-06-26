const db = require('../config/db');
const { encrypt } = require('../utils/crypto');
const axios = require('axios');
const { ClientSecretCredential } = require('@azure/identity');
const { ResourceManagementClient } = require('@azure/arm-resources');

const orgController = {
    // Step 1: Register organization
    register: async (req, res) => {
        try {
            const { name, adminEmail } = req.body;
            if (!name || !adminEmail) {
                return res.status(400).json({ message: 'Missing parameters (name, adminEmail).' });
            }

            const tenantId = req.user.tenant_id; // Added during microsoft login
            if (!tenantId) {
                return res.status(400).json({ message: 'User does not have a tenant ID.' });
            }

            // Check if organization with tenant ID already exists
            const [existing] = await db.query('SELECT * FROM organizations WHERE tenant_id = ?', [tenantId]);
            if (existing.length > 0) {
                return res.status(400).json({ message: 'An organization for this tenant already exists.' });
            }

            // Generate a slug-based organization ID
            let orgId = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            if (!orgId) orgId = 'org';
            
            // Check if ID is unique
            const [idCheck] = await db.query('SELECT id FROM organizations WHERE id = ?', [orgId]);
            if (idCheck.length > 0) {
                orgId = `${orgId}-${Math.floor(1000 + Math.random() * 9000)}`;
            }

            // Create organization
            await db.query(
                `INSERT INTO organizations (id, name, tenant_id, admin_email, onboarding_complete, created_by)
                 VALUES (?, ?, ?, ?, 0, ?)`,
                [orgId, name, tenantId, adminEmail, req.user.id]
            );

            // Update user to match this organization and set as admin
            await db.query(
                'UPDATE users SET organization_id = ?, role = "admin" WHERE id = ?',
                [orgId, req.user.id]
            );

            // Fetch created org
            const [newOrg] = await db.query('SELECT * FROM organizations WHERE id = ?', [orgId]);

            // Generate updated local JWT token since organization_id is now set
            const jwt = require('jsonwebtoken');
            const JWT_SECRET = process.env.JWT_SECRET || 'estevia-devops-jwt-super-secret-key-12345';
            const updatedToken = jwt.sign(
                { 
                    id: req.user.id, 
                    email: req.user.email, 
                    name: req.user.name, 
                    organization_id: orgId, 
                    role: 'admin' 
                },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            res.json({ success: true, organization: newOrg[0], token: updatedToken });
        } catch (error) {
            console.error('[OrgController] Register failed:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    },

    // Step 2: Save Azure credentials
    setupAzure: async (req, res) => {
        try {
            const { subscriptionId, tenantId, clientId, clientSecret, resourceGroup } = req.body;
            const organizationId = req.user.organization_id;

            if (!organizationId) {
                return res.status(400).json({ message: 'User is not associated with any organization.' });
            }
            if (!subscriptionId || !tenantId || !clientId || !clientSecret || !resourceGroup) {
                return res.status(400).json({ message: 'Missing required parameters.' });
            }

            // Save SP credentials encrypted
            const secrets = { tenantId, clientId, clientSecret };
            const secretsString = JSON.stringify(secrets);
            const { encrypted, iv, authTag } = encrypt(secretsString);

            // Check if provider credentials exist
            const [existing] = await db.query(
                'SELECT id FROM integration_credentials WHERE organization_id = ? AND provider = ?',
                [organizationId, 'azure']
            );

            if (existing.length > 0) {
                await db.query(
                    `UPDATE integration_credentials 
                     SET credential_name = ?, encrypted_secrets = ?, iv = ?, auth_tag = ?
                     WHERE organization_id = ? AND provider = ?`,
                    ['Azure Service Principal', encrypted, iv, authTag, organizationId, 'azure']
                );
            } else {
                await db.query(
                    `INSERT INTO integration_credentials 
                     (organization_id, provider, credential_name, encrypted_secrets, iv, auth_tag) 
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [organizationId, 'azure', 'Azure Service Principal', encrypted, iv, authTag]
                );
            }

            // Update organization settings
            const pipelineVariableGroup = `${organizationId}-frontend-vars`;
            await db.query(
                `UPDATE organizations 
                 SET azure_subscription_id = ?, azure_resource_group = ?, pipeline_variable_group = ? 
                 WHERE id = ?`,
                [subscriptionId, resourceGroup, pipelineVariableGroup, organizationId]
            );

            // Auto-discover infrastructure resources (DB servers & environments)
            try {
                const appController = require('./appController');
                const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
                const discovered = await appController._discoverAzureResourcesInternal(subscriptionId, resourceGroup, credential);
                
                await db.query(
                    `UPDATE organizations 
                     SET dev_db_host = ?, qa_db_host = ?, prod_db_host = ?, dev_managed_env_id = ?, prod_managed_env_id = ?
                     WHERE id = ?`,
                    [
                        discovered.devDbHost || null,
                        discovered.qaDbHost || null,
                        discovered.prodDbHost || null,
                        discovered.devManagedEnvId || null,
                        discovered.prodManagedEnvId || null,
                        organizationId
                    ]
                );
                console.log(`[OrgController] Onboarding Step 2: Auto-discovered and updated infra settings for organization: ${organizationId}`);
            } catch (discoveryErr) {
                console.warn(`[OrgController] Onboarding Step 2: Auto-discovery failed:`, discoveryErr.message);
            }

            res.json({ success: true, message: 'Azure credentials configured successfully.' });
        } catch (error) {
            console.error('[OrgController] setupAzure failed:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    },

    // Step 3: Save DevOps & GitHub credentials
    setupDevops: async (req, res) => {
        try {
            const { devopsOrgUrl, devopsProject, devopsPat, githubOwner, githubPat } = req.body;
            const organizationId = req.user.organization_id;

            if (!organizationId) {
                return res.status(400).json({ message: 'User is not associated with any organization.' });
            }
            if (!devopsOrgUrl || !devopsProject || !devopsPat || !githubOwner || !githubPat) {
                return res.status(400).json({ message: 'Missing required parameters.' });
            }

            // 1. Encrypt and save GitHub
            const ghSecrets = JSON.stringify({ token: githubPat });
            const ghEnc = encrypt(ghSecrets);
            const [existingGh] = await db.query(
                'SELECT id FROM integration_credentials WHERE organization_id = ? AND provider = ?',
                [organizationId, 'github']
            );
            if (existingGh.length > 0) {
                await db.query(
                    'UPDATE integration_credentials SET encrypted_secrets = ?, iv = ?, auth_tag = ? WHERE id = ?',
                    [ghEnc.encrypted, ghEnc.iv, ghEnc.authTag, existingGh[0].id]
                );
            } else {
                await db.query(
                    'INSERT INTO integration_credentials (organization_id, provider, credential_name, encrypted_secrets, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)',
                    [organizationId, 'github', 'GitHub Platform Token', ghEnc.encrypted, ghEnc.iv, ghEnc.authTag]
                );
            }

            // 2. Encrypt and save Azure DevOps
            const devopsSecrets = JSON.stringify({ pat: devopsPat });
            const devopsEnc = encrypt(devopsSecrets);
            const [existingDevops] = await db.query(
                'SELECT id FROM integration_credentials WHERE organization_id = ? AND provider = ?',
                [organizationId, 'azure_devops']
            );
            if (existingDevops.length > 0) {
                await db.query(
                    'UPDATE integration_credentials SET encrypted_secrets = ?, iv = ?, auth_tag = ? WHERE id = ?',
                    [devopsEnc.encrypted, devopsEnc.iv, devopsEnc.authTag, existingDevops[0].id]
                );
            } else {
                await db.query(
                    'INSERT INTO integration_credentials (organization_id, provider, credential_name, encrypted_secrets, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)',
                    [organizationId, 'azure_devops', 'Azure DevOps Pipeline PAT', devopsEnc.encrypted, devopsEnc.iv, devopsEnc.authTag]
                );
            }

            // 3. Update organization record
            await db.query(
                `UPDATE organizations 
                 SET azure_devops_org_url = ?, azure_devops_project = ?, github_owner = ? 
                 WHERE id = ?`,
                [devopsOrgUrl, devopsProject, githubOwner, organizationId]
            );

            res.json({ success: true, message: 'CI/CD credentials configured successfully.' });
        } catch (error) {
            console.error('[OrgController] setupDevops failed:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    },

    // Step 4: Save GoDaddy credentials
    setupDns: async (req, res) => {
        try {
            const { apiKey, apiSecret, defaultDomain } = req.body;
            const organizationId = req.user.organization_id;

            if (!organizationId) {
                return res.status(400).json({ message: 'User is not associated with any organization.' });
            }
            if (!apiKey || !apiSecret || !defaultDomain) {
                return res.status(400).json({ message: 'Missing required parameters.' });
            }

            // Encrypt and save GoDaddy
            const dnsSecrets = JSON.stringify({ apiKey, apiSecret });
            const dnsEnc = encrypt(dnsSecrets);
            const [existingDns] = await db.query(
                'SELECT id FROM integration_credentials WHERE organization_id = ? AND provider = ?',
                [organizationId, 'godaddy']
            );
            if (existingDns.length > 0) {
                await db.query(
                    'UPDATE integration_credentials SET encrypted_secrets = ?, iv = ?, auth_tag = ? WHERE id = ?',
                    [dnsEnc.encrypted, dnsEnc.iv, dnsEnc.authTag, existingDns[0].id]
                );
            } else {
                await db.query(
                    'INSERT INTO integration_credentials (organization_id, provider, credential_name, encrypted_secrets, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)',
                    [organizationId, 'godaddy', 'GoDaddy Domain API Keys', dnsEnc.encrypted, dnsEnc.iv, dnsEnc.authTag]
                );
            }

            // Update organization
            await db.query(
                'UPDATE organizations SET default_dns_domain = ? WHERE id = ?',
                [defaultDomain, organizationId]
            );

            res.json({ success: true, message: 'DNS domain credentials configured successfully.' });
        } catch (error) {
            console.error('[OrgController] setupDns failed:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    },

    // Step 5: Mark onboarding complete
    complete: async (req, res) => {
        try {
            const organizationId = req.user.organization_id;
            if (!organizationId) {
                return res.status(400).json({ message: 'User is not associated with any organization.' });
            }

            await db.query(
                'UPDATE organizations SET onboarding_complete = 1 WHERE id = ?',
                [organizationId]
            );

            res.json({ success: true, message: 'Onboarding completed successfully!' });
        } catch (error) {
            console.error('[OrgController] complete onboarding failed:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    },

    // Get current organization status
    getStatus: async (req, res) => {
        try {
            const organizationId = req.user.organization_id;
            if (!organizationId) {
                return res.json({ onboardingComplete: false, step: 1, organization: null, credentialGate: { isComplete: false, missing: { azure: true, github: true, azureDevops: true, godaddy: true } } });
            }

            const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [organizationId]);
            if (orgs.length === 0) {
                return res.json({ onboardingComplete: false, step: 1, organization: null, credentialGate: { isComplete: false, missing: { azure: true, github: true, azureDevops: true, godaddy: true } } });
            }

            const org = orgs[0];

            // Always check credential completeness regardless of onboarding_complete
            const [creds] = await db.query(
                'SELECT provider FROM integration_credentials WHERE organization_id = ?',
                [organizationId]
            );
            const providers = new Set(creds.map(c => c.provider));

            const credentialGate = {
                isComplete: providers.has('azure') &&
                            providers.has('github') &&
                            providers.has('azure_devops') &&
                            providers.has('godaddy'),
                missing: {
                    azure:       !providers.has('azure'),
                    github:      !providers.has('github'),
                    azureDevops: !providers.has('azure_devops'),
                    godaddy:     !providers.has('godaddy')
                }
            };

            let step = 1;
            if (org.onboarding_complete) {
                step = 5;
            } else {
                // Determine current step based on completed configuration
                if (!providers.has('azure')) {
                    step = 2;
                } else if (!providers.has('github') || !providers.has('azure_devops')) {
                    step = 3;
                } else if (!providers.has('godaddy')) {
                    step = 4;
                } else {
                    step = 5;
                }
            }

            res.json({
                onboardingComplete: !!org.onboarding_complete,
                step,
                organization: org,
                credentialGate
            });
        } catch (error) {
            console.error('[OrgController] getStatus failed:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    },

    // Test Azure credentials
    testAzure: async (req, res) => {
        try {
            const { subscriptionId, tenantId, clientId, clientSecret } = req.body;
            if (!subscriptionId || !tenantId || !clientId || !clientSecret) {
                return res.status(400).json({ message: 'Missing parameters for Azure validation.' });
            }

            const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
            const client = new ResourceManagementClient(credential, subscriptionId);
            
            // Try to list resource groups to verify access
            const groups = [];
            let count = 0;
            for await (const rg of client.resourceGroups.list()) {
                groups.push(rg.name);
                count++;
                if (count >= 3) break; // Check first few resource groups
            }

            res.json({ success: true, message: `Azure authenticated successfully. Found resource groups: ${groups.join(', ')}` });
        } catch (error) {
            console.error('[OrgController] testAzure failed:', error.message);
            res.status(400).json({ success: false, message: `Azure authentication failed: ${error.message}` });
        }
    },

    // Test GitHub token
    testGithub: async (req, res) => {
        try {
            const { githubPat, githubOwner } = req.body;
            if (!githubPat || !githubOwner) {
                return res.status(400).json({ message: 'Missing parameters for GitHub validation.' });
            }

            // Check user/org info
            const response = await axios.get(`https://api.github.com/users/${githubOwner}`, {
                headers: {
                    Authorization: `token ${githubPat}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            });

            res.json({ success: true, message: `GitHub authenticated successfully for owner: ${response.data.login}` });
        } catch (error) {
            console.error('[OrgController] testGithub failed:', error.message);
            res.status(400).json({ success: false, message: `GitHub verification failed: ${error.message}` });
        }
    },

    // Test Azure DevOps credentials
    testDevops: async (req, res) => {
        try {
            const { devopsOrgUrl, devopsProject, devopsPat } = req.body;
            if (!devopsOrgUrl || !devopsProject || !devopsPat) {
                return res.status(400).json({ message: 'Missing parameters for DevOps validation.' });
            }

            const cleanOrgUrl = devopsOrgUrl.replace(/\/$/, '');
            const tokenBase64 = Buffer.from(`:${devopsPat}`).toString('base64');
            
            // Verify access to the project
            await axios.get(`${cleanOrgUrl}/_apis/projects/${devopsProject}?api-version=7.1-preview.4`, {
                headers: {
                    Authorization: `Basic ${tokenBase64}`
                }
            });

            res.json({ success: true, message: `Azure DevOps authenticated successfully for project: ${devopsProject}` });
        } catch (error) {
            console.error('[OrgController] testDevops failed:', error.message);
            res.status(400).json({ success: false, message: `Azure DevOps verification failed: ${error.message}` });
        }
    },

    // Test GoDaddy domain keys
    testDns: async (req, res) => {
        try {
            const { apiKey, apiSecret, defaultDomain } = req.body;
            if (!apiKey || !apiSecret || !defaultDomain) {
                return res.status(400).json({ message: 'Missing parameters for GoDaddy validation.' });
            }

            // Verify domain access by listing domains (limit 1)
            const response = await axios.get(`https://api.godaddy.com/v1/domains?limit=1`, {
                headers: {
                    Authorization: `sso-key ${apiKey}:${apiSecret}`
                }
            });

            res.json({ success: true, message: `GoDaddy authenticated successfully.` });
        } catch (error) {
            console.error('[OrgController] testDns failed:', error.message);
            res.status(400).json({ success: false, message: `GoDaddy verification failed: ${error.message}` });
        }
    }
};

module.exports = orgController;
