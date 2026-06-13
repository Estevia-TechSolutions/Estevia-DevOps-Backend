const db = require('../config/db');

const keyVaultController = {
    /**
     * GET /api/keyvault/mappings?organizationId=...
     */
    getMappings: async (req, res) => {
        try {
            const orgId = req.query.organizationId || req.user?.organization_id || 'estevia';
            const [rows] = await db.query('SELECT * FROM key_vault_mappings WHERE organization_id = ?', [orgId]);
            
            res.json({
                success: true,
                organization_id: orgId,
                mappings: rows
            });
        } catch (error) {
            console.error('[KeyVaultController] Failed to get mappings:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * POST /api/keyvault/map
     */
    mapSecret: async (req, res) => {
        try {
            const { organizationId, secretName, mappedToVariableGroup } = req.body;
            const orgId = organizationId || req.user?.organization_id || 'estevia';
            
            if (!secretName || !mappedToVariableGroup) {
                return res.status(400).json({ success: false, message: 'Missing parameters (secretName, mappedToVariableGroup).' });
            }

            const [insertResult] = await db.query(
                'INSERT INTO key_vault_mappings (organization_id, secret_name, mapped_to_variable_group, active) VALUES (?, ?, ?, ?)',
                [orgId, secretName, mappedToVariableGroup, 1]
            );

            res.json({
                success: true,
                message: `Successfully mapped Key Vault secret '${secretName}' to Pipeline Variable Group '${mappedToVariableGroup}'.`,
                mapping: {
                    id: insertResult.insertId,
                    organization_id: orgId,
                    secret_name: secretName,
                    mapped_to_variable_group: mappedToVariableGroup,
                    active: true
                }
            });
        } catch (error) {
            console.error('[KeyVaultController] Failed to map secret:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * DELETE /api/keyvault/mappings/:id
     */
    deleteMapping: async (req, res) => {
        try {
            const { id } = req.params;

            const [rows] = await db.query('SELECT * FROM key_vault_mappings WHERE id = ?', [id]);
            if (rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Mapping not found.' });
            }

            await db.query('DELETE FROM key_vault_mappings WHERE id = ?', [id]);

            res.json({
                success: true,
                message: 'Successfully deleted Key Vault secret mapping.'
            });
        } catch (error) {
            console.error('[KeyVaultController] Failed to delete mapping:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }
};

module.exports = keyVaultController;
