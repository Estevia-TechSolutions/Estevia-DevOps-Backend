const db = require('../config/db');
const { encrypt, decrypt } = require('../utils/crypto');

const credentialController = {
    /**
     * Save (insert or update) integration credentials for an organization
     */
    saveCredentials: async (req, res) => {
        try {
            const { organizationId, provider, credentialName, secrets } = req.body;

            if (!organizationId || !provider || !credentialName || !secrets) {
                return res.status(400).json({ message: 'Missing required parameters.' });
            }

            // Verify organization exists
            const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [organizationId]);
            if (orgs.length === 0) {
                return res.status(404).json({ message: `Organization "${organizationId}" not found.` });
            }

            const keyVaultUrl = orgs[0]?.azure_key_vault_url;
            let secretsObj = typeof secrets === 'string' ? JSON.parse(secrets) : secrets;
            if (provider === 'azure' && secretsObj && (secretsObj.clientId === 'SYSTEM_MANAGED_IDENTITY' || secretsObj.type === 'managed_identity')) {
                secretsObj = {
                    type: 'managed_identity',
                    tenantId: secretsObj.tenantId || process.env.AZURE_TENANT_ID || process.env.MICROSOFT_TENANT_ID || ""
                };
            }
            const secretsString = JSON.stringify(secretsObj);
            
            let encrypted, iv, authTag;

            // Always encrypt the secrets locally first as a fallback/backup
            const encResult = encrypt(secretsString);
            encrypted = encResult.encrypted;
            iv = encResult.iv;
            authTag = encResult.authTag;

            if (keyVaultUrl) {
                try {
                    const { SecretClient } = require('@azure/keyvault-secrets');
                    let credential;

                    // If manually saving Azure Service Principal credentials, use them directly to authenticate against Key Vault
                    if (provider === 'azure' && secretsObj && secretsObj.clientId && secretsObj.clientSecret && secretsObj.tenantId && secretsObj.clientId !== 'SYSTEM_MANAGED_IDENTITY') {
                        const { ClientSecretCredential } = require('@azure/identity');
                        console.log(`[CredentialController] Initializing ClientSecretCredential for Key Vault write using manually supplied SP credentials.`);
                        credential = new ClientSecretCredential(secretsObj.tenantId, secretsObj.clientId, secretsObj.clientSecret);
                    } else {
                        const { DefaultAzureCredential } = require('@azure/identity');
                        console.log(`[CredentialController] Initializing DefaultAzureCredential for Key Vault write.`);
                        credential = new DefaultAzureCredential();
                    }

                    const client = new SecretClient(keyVaultUrl, credential);
                    const secretName = `${organizationId}-${provider}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                    
                    console.log(`[CredentialController] Writing secret '${secretName}' to Azure Key Vault: ${keyVaultUrl}`);
                    await client.setSecret(secretName, secretsString);
                    
                    encrypted = 'stored-in-azure-key-vault';
                    iv = 'kv';
                    authTag = 'kv';
                } catch (kvErr) {
                    console.warn(`[CredentialController] Failed to write secret to Azure Key Vault, falling back to local DB encryption:`, kvErr.message);
                    // Do not block saving to local database, proceed with local encrypted variables
                }
            }

            // Check if credentials for this organization and provider already exist
            const [existing] = await db.query(
                'SELECT id FROM integration_credentials WHERE organization_id = ? AND provider = ?',
                [organizationId, provider]
            );

            if (existing.length > 0) {
                // Update
                await db.query(
                    `UPDATE integration_credentials 
                     SET credential_name = ?, encrypted_secrets = ?, iv = ?, auth_tag = ?
                     WHERE organization_id = ? AND provider = ?`,
                    [credentialName, encrypted, iv, authTag, organizationId, provider]
                );
                return res.json({ success: true, message: 'Credentials updated successfully.' });
            } else {
                // Insert
                await db.query(
                    `INSERT INTO integration_credentials 
                     (organization_id, provider, credential_name, encrypted_secrets, iv, auth_tag) 
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [organizationId, provider, credentialName, encrypted, iv, authTag]
                );
                return res.json({ success: true, message: 'Credentials registered successfully.' });
            }
        } catch (error) {
            console.error('[CredentialController] Error saving credentials:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    },

    /**
     * Retrieve list of registered integration credentials (metadata only, secrets omitted)
     */
    getCredentialsList: async (req, res) => {
        try {
            const { organizationId } = req.query;

            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId parameter.' });
            }

            const [rows] = await db.query(
                `SELECT id, provider, credential_name, created_at, updated_at 
                 FROM integration_credentials 
                 WHERE organization_id = ?`,
                [organizationId]
            );

            res.json(rows);
        } catch (error) {
            console.error('[CredentialController] Error retrieving credentials list:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    },

    /**
     * Decrypt and return credentials for a provider
     */
    getDecryptedCredentials: async (req, res) => {
        try {
            const { organizationId, provider } = req.query;

            if (!organizationId || !provider) {
                return res.status(400).json({ message: 'Missing organizationId or provider parameter.' });
            }

            const credentials = await credentialController.getDecryptedCredentialsInternal(organizationId, provider);
            if (!credentials) {
                return res.status(404).json({ message: `Credentials for "${provider}" not found.` });
            }

            res.json({ success: true, secrets: credentials });
        } catch (error) {
            console.error('[CredentialController] Decrypt failed:', error);
            res.status(500).json({ message: 'Failed to decrypt credentials.', error: error.message });
        }
    },

    /**
     * Internal helper to decrypt and fetch credentials for code execution (not exposed as route)
     */
    getDecryptedCredentialsInternal: async (organizationId, provider) => {
        try {
            // Check if organization has Key Vault URL
            const [orgs] = await db.query('SELECT azure_key_vault_url FROM organizations WHERE id = ?', [organizationId]);
            const keyVaultUrl = orgs[0]?.azure_key_vault_url;

            if (keyVaultUrl) {
                try {
                    const { SecretClient } = require('@azure/keyvault-secrets');
                    const { DefaultAzureCredential } = require('@azure/identity');
                    const credential = new DefaultAzureCredential();
                    const client = new SecretClient(keyVaultUrl, credential);
                    const secretName = `${organizationId}-${provider}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                    
                    console.log(`[CredentialController] Fetching secret '${secretName}' from Azure Key Vault: ${keyVaultUrl}`);
                    const secret = await client.getSecret(secretName);
                    return JSON.parse(secret.value);
                } catch (kvErr) {
                    console.warn(`[CredentialController] Key Vault fetch failed for '${provider}' secret, falling back to local DB:`, kvErr.message);
                }
            }

            // Fallback: local DB decryption
            const [rows] = await db.query(
                `SELECT encrypted_secrets, iv, auth_tag 
                 FROM integration_credentials 
                 WHERE organization_id = ? AND provider = ?`,
                [organizationId, provider]
            );

            if (rows.length === 0) {
                return null;
            }

            const { encrypted_secrets, iv, auth_tag } = rows[0];
            
            // If it's a placeholder but the real vault fetch failed or vault url was deleted
            if (encrypted_secrets === 'stored-in-azure-key-vault') {
                console.error(`[CredentialController] Credentials placeholder found but Key Vault fetch was unsuccessful.`);
                return null;
            }

            const decryptedString = decrypt(encrypted_secrets, iv, auth_tag);
            return JSON.parse(decryptedString);
        } catch (error) {
            console.error(`[CredentialController] Internal decryption failed for ${provider}:`, error);
            throw error;
        }
    },

    /**
     * Decrypt and test connection health of credentials for a given provider
     */
    validateCredentials: async (req, res) => {
        try {
            const { organizationId, provider } = req.body;
            if (!organizationId || !provider) {
                return res.status(400).json({ message: 'Missing organizationId or provider parameter.' });
            }

            const secrets = await credentialController.getDecryptedCredentialsInternal(organizationId, provider);
            if (!secrets) {
                return res.status(404).json({ message: `No saved credentials found for "${provider}".` });
            }

            const axios = require('axios');

            if (provider === 'github') {
                const token = secrets.token || secrets.pat || secrets.accessToken || Object.values(secrets)[0];
                if (!token) return res.status(400).json({ message: 'Invalid GitHub credentials structure.' });
                
                try {
                    const response = await axios.get('https://api.github.com/user', {
                        headers: {
                            'Authorization': `token ${token}`,
                            'User-Agent': 'EvaOps-DevOps-Platform'
                        }
                    });
                    return res.json({ success: true, message: `GitHub connection healthy. Connected as user: ${response.data.login}` });
                } catch (err) {
                    const msg = err.response?.data?.message || err.message;
                    return res.status(400).json({ message: `GitHub authentication failed: ${msg}` });
                }
            } 
            
            else if (provider === 'azure_devops') {
                const pat = secrets.pat || Object.values(secrets)[0];
                if (!pat) return res.status(400).json({ message: 'Invalid Azure DevOps credentials structure.' });
                
                // Fetch DevOps Org URL from organization settings
                const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [organizationId]);
                if (orgs.length === 0) {
                    return res.status(404).json({ message: `Organization "${organizationId}" not found.` });
                }
                const orgUrl = orgs[0].azure_devops_org_url || 'https://dev.azure.com/esteviatech';
                const cleanOrgUrl = orgUrl.replace(/\/$/, '');
                
                const tokenBase64 = Buffer.from(`:${pat}`).toString('base64');
                try {
                    const response = await axios.get(`${cleanOrgUrl}/_apis/projects?api-version=6.0`, {
                        headers: {
                            'Authorization': `Basic ${tokenBase64}`,
                            'User-Agent': 'EvaOps-DevOps-Platform'
                        }
                    });
                    const count = response.data.count || 0;
                    return res.json({ success: true, message: `Azure DevOps connection healthy. Discovered ${count} projects.` });
                } catch (err) {
                    const msg = err.response?.data?.message || err.message;
                    return res.status(400).json({ message: `Azure DevOps PAT invalid: ${msg}` });
                }
            }

            else if (provider === 'godaddy') {
                const apiKey = secrets.apiKey;
                const apiSecret = secrets.apiSecret;
                if (!apiKey || !apiSecret) {
                    return res.status(400).json({ message: 'Invalid GoDaddy credentials structure.' });
                }

                try {
                    const response = await axios.get('https://api.godaddy.com/v1/domains?limit=1', {
                        headers: {
                            'Authorization': `sso-key ${apiKey}:${apiSecret}`,
                            'User-Agent': 'EvaOps-DevOps-Platform'
                        }
                    });
                    return res.json({ success: true, message: 'GoDaddy API connection healthy. Keys authenticated successfully.' });
                } catch (err) {
                    const msg = err.response?.data?.message || err.message;
                    return res.status(400).json({ message: `GoDaddy keys invalid: ${msg}` });
                }
            }

            else if (provider === 'azure') {
                const type = secrets.type || 'service_principal';
                const clientId = secrets.clientId;
                const clientSecret = secrets.clientSecret;
                const tenantId = secrets.tenantId;
                
                if (type !== 'managed_identity' && (!clientId || !clientSecret || !tenantId)) {
                    return res.status(400).json({ message: 'Invalid Azure credentials structure. Expected tenantId, clientId, and clientSecret.' });
                }

                // Retrieve subscription ID from organization
                const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [organizationId]);
                if (orgs.length === 0) {
                    return res.status(404).json({ message: `Organization "${organizationId}" not found.` });
                }
                const subscriptionId = orgs[0].azure_subscription_id;
                if (!subscriptionId) {
                    return res.status(400).json({ message: 'Azure Subscription ID is not configured for organization.' });
                }

                const { ClientSecretCredential, DefaultAzureCredential } = require('@azure/identity');
                const { ResourceManagementClient } = require('@azure/arm-resources');

                try {
                    const credential = type === 'managed_identity' 
                        ? new DefaultAzureCredential() 
                        : new ClientSecretCredential(tenantId, clientId, clientSecret);
                    const client = new ResourceManagementClient(credential, subscriptionId);
                    
                    // Verify access by trying to list resource groups (limit to first 2 for speed)
                    const groups = [];
                    let count = 0;
                    for await (const rg of client.resourceGroups.list()) {
                        groups.push(rg.name);
                        count++;
                        if (count >= 2) break;
                    }
                    const identityTypeLabel = type === 'managed_identity' ? 'Managed Identity' : 'Service Principal';
                    return res.json({ success: true, message: `Azure ${identityTypeLabel} authenticated. Discovered resource groups: ${groups.join(', ')}` });
                } catch (err) {
                    return res.status(400).json({ message: `Azure connection test failed: ${err.message}` });
                }
            }

            return res.status(400).json({ message: `Provider "${provider}" validation not supported.` });
        } catch (error) {
            console.error('[CredentialController] Validation failed:', error);
            res.status(500).json({ message: 'Validation failed.', error: error.message });
        }
    },

    /**
     * Auto-discover Azure Service Principal credentials from the server environment
     */
    discoverAzureEnvCredentials: async (req, res) => {
        try {
            const { organizationId } = req.query;
            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId parameter.' });
            }

            // Verify organization exists
            const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [organizationId]);
            if (orgs.length === 0) {
                return res.status(404).json({ message: `Organization "${organizationId}" not found.` });
            }

            const clientId = process.env.AZURE_CLIENT_ID || "";
            const clientSecret = process.env.AZURE_CLIENT_SECRET || "";
            let tenantId = process.env.AZURE_TENANT_ID || process.env.MICROSOFT_TENANT_ID || "";
            let secretsObj = null;
            let managedIdentity = false;
            let discoveredSubscriptionId = "";

            if (!clientId && !clientSecret) {
                // Fallback: Check if DefaultAzureCredential is functional (Managed Identity or CLI session)
                const { DefaultAzureCredential } = require('@azure/identity');

                try {
                    const credential = new DefaultAzureCredential();
                    const tokenRes = await credential.getToken("https://management.azure.com/.default");
                    if (tokenRes && tokenRes.token) {
                        managedIdentity = true;
                        // Decode Tenant ID from JWT tid claim
                        try {
                            const base64Url = tokenRes.token.split('.')[1];
                            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                            const jsonPayload = decodeURIComponent(Buffer.from(base64, 'base64').toString().split('').map(function(c) {
                                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                            }).join(''));
                            const payload = JSON.parse(jsonPayload);
                            if (payload && payload.tid) {
                                tenantId = payload.tid;
                            }
                        } catch (jwtErr) {
                            console.warn('[CredentialController] Failed to parse JWT tid claim:', jwtErr.message);
                        }

                        // Dynamically discover subscriptions the credential has access to
                        try {
                            const axios = require('axios');
                            const subUrl = `https://management.azure.com/subscriptions?api-version=2020-01-01`;
                            const subRes = await axios.get(subUrl, {
                                headers: { 'Authorization': `Bearer ${tokenRes.token}` },
                                timeout: 5000
                            });
                            const subscriptions = subRes.data?.value || [];
                            if (subscriptions.length > 0) {
                                discoveredSubscriptionId = subscriptions[0].subscriptionId;
                                console.log(`[CredentialController] Auto-discovered Subscription ID: ${discoveredSubscriptionId} (${subscriptions[0].displayName})`);
                                
                                // Auto-update organization's subscription ID if not configured
                                if (orgs[0] && !orgs[0].azure_subscription_id) {
                                    await db.query(
                                        'UPDATE organizations SET azure_subscription_id = ? WHERE id = ?',
                                        [discoveredSubscriptionId, organizationId]
                                    );
                                }
                            }
                        } catch (subErr) {
                            console.warn('[CredentialController] Failed to list subscriptions via Managed Identity token:', subErr.message);
                        }
                    }
                } catch (authErr) {
                    console.warn('[CredentialController] DefaultAzureCredential validation failed:', authErr.message);
                }

                if (managedIdentity) {
                    secretsObj = {
                        type: 'managed_identity',
                        clientId: 'SYSTEM_MANAGED_IDENTITY',
                        clientSecret: 'SYSTEM_MANAGED_IDENTITY',
                        tenantId: tenantId,
                        subscriptionId: discoveredSubscriptionId
                    };
                }
            } else {
                secretsObj = {
                    clientId,
                    clientSecret,
                    tenantId
                };
            }

            if (!secretsObj) {
                return res.json({ success: false, message: 'No Azure credentials configured in the server environment.' });
            }

            // Encrypt and save to database/vault
            const keyVaultUrl = orgs[0]?.azure_key_vault_url;
            const secretsString = JSON.stringify(secretsObj);
            let encrypted, iv, authTag;

            // Always encrypt the secrets locally first as a fallback/backup
            const encResult = encrypt(secretsString);
            encrypted = encResult.encrypted;
            iv = encResult.iv;
            authTag = encResult.authTag;

            if (keyVaultUrl) {
                try {
                    const { SecretClient } = require('@azure/keyvault-secrets');
                    const { DefaultAzureCredential } = require('@azure/identity');
                    const credential = new DefaultAzureCredential();
                    const client = new SecretClient(keyVaultUrl, credential);
                    const secretName = `${organizationId}-azure`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                    
                    console.log(`[CredentialController] Auto-discover: Writing secret '${secretName}' to Key Vault: ${keyVaultUrl}`);
                    await client.setSecret(secretName, secretsString);
                    
                    encrypted = 'stored-in-azure-key-vault';
                    iv = 'kv';
                    authTag = 'kv';
                } catch (kvErr) {
                    console.warn(`[CredentialController] Auto-discover Key Vault storage failed, falling back to local DB encryption:`, kvErr.message);
                    // Do not block saving to local database, proceed with local encrypted variables
                }
            }

            const [existing] = await db.query(
                'SELECT id FROM integration_credentials WHERE organization_id = ? AND provider = ?',
                [organizationId, 'azure']
            );

            const credentialName = managedIdentity ? 'Azure Managed Identity (Auto-Discovered)' : 'Azure Service Principal (Auto-Discovered)';

            if (existing.length > 0) {
                await db.query(
                    `UPDATE integration_credentials 
                     SET credential_name = ?, encrypted_secrets = ?, iv = ?, auth_tag = ?
                     WHERE organization_id = ? AND provider = ?`,
                    [credentialName, encrypted, iv, authTag, organizationId, 'azure']
                );
            } else {
                await db.query(
                    `INSERT INTO integration_credentials 
                     (organization_id, provider, credential_name, encrypted_secrets, iv, auth_tag) 
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [organizationId, 'azure', credentialName, encrypted, iv, authTag]
                );
            }

            res.json({
                success: true,
                message: 'Azure credentials auto-discovered and registered successfully.',
                secrets: secretsObj
            });
        } catch (error) {
            console.error('[CredentialController] Error discovering environment credentials:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    }
};

module.exports = credentialController;
