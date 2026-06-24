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
            const secretsString = typeof secrets === 'string' ? secrets : JSON.stringify(secrets);
            
            let encrypted, iv, authTag;

            if (keyVaultUrl) {
                try {
                    const { SecretClient } = require('@azure/keyvault-secrets');
                    const { DefaultAzureCredential } = require('@azure/identity');
                    const credential = new DefaultAzureCredential();
                    const client = new SecretClient(keyVaultUrl, credential);
                    const secretName = `${organizationId}-${provider}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                    
                    console.log(`[CredentialController] Writing secret '${secretName}' to Azure Key Vault: ${keyVaultUrl}`);
                    await client.setSecret(secretName, secretsString);
                    
                    encrypted = 'stored-in-azure-key-vault';
                    iv = 'kv';
                    authTag = 'kv';
                } catch (kvErr) {
                    console.error('[CredentialController] Failed to write secret to Azure Key Vault:', kvErr.message);
                    return res.status(500).json({ message: `Azure Key Vault storage failed: ${kvErr.message}` });
                }
            } else {
                // Encrypt the secrets locally
                const encResult = encrypt(secretsString);
                encrypted = encResult.encrypted;
                iv = encResult.iv;
                authTag = encResult.authTag;
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
                const clientId = secrets.clientId;
                const clientSecret = secrets.clientSecret;
                const tenantId = secrets.tenantId;
                
                if (!clientId || !clientSecret || !tenantId) {
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

                const { ClientSecretCredential } = require('@azure/identity');
                const { ResourceManagementClient } = require('@azure/arm-resources');

                try {
                    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
                    const client = new ResourceManagementClient(credential, subscriptionId);
                    
                    // Verify access by trying to list resource groups (limit to first 2 for speed)
                    const groups = [];
                    let count = 0;
                    for await (const rg of client.resourceGroups.list()) {
                        groups.push(rg.name);
                        count++;
                        if (count >= 2) break;
                    }
                    return res.json({ success: true, message: `Azure Service Principal authenticated. Discovered resource groups: ${groups.join(', ')}` });
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
            const tenantId = process.env.AZURE_TENANT_ID || process.env.MICROSOFT_TENANT_ID || "";

            if (!clientId && !clientSecret) {
                return res.json({ success: false, message: 'No Azure credentials configured in the server environment.' });
            }

            res.json({
                success: true,
                secrets: {
                    clientId,
                    clientSecret,
                    tenantId
                }
            });
        } catch (error) {
            console.error('[CredentialController] Error discovering environment credentials:', error);
            res.status(500).json({ message: 'Internal server error.', error: error.message });
        }
    }
};

module.exports = credentialController;
