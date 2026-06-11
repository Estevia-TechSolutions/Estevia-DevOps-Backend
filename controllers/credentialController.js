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
            const [orgs] = await db.query('SELECT id FROM organizations WHERE id = ?', [organizationId]);
            if (orgs.length === 0) {
                return res.status(404).json({ message: `Organization "${organizationId}" not found.` });
            }

            // Encrypt the secrets
            const secretsString = typeof secrets === 'string' ? secrets : JSON.stringify(secrets);
            const { encrypted, iv, authTag } = encrypt(secretsString);

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
            const decryptedString = decrypt(encrypted_secrets, iv, auth_tag);
            return JSON.parse(decryptedString);
        } catch (error) {
            console.error(`[CredentialController] Internal decryption failed for ${provider}:`, error);
            throw error;
        }
    }
};

module.exports = credentialController;
