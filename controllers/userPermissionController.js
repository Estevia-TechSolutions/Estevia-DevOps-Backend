const db = require('../config/db');

// Helper to extract clean app key by stripping env suffixes
function extractAppKey(resourceName) {
    if (!resourceName) return 'unknown';
    const clean = resourceName.toLowerCase()
        .replace(/-(dev|qa|prod|production|staging|test)(-swa)?$/i, '')
        .replace(/(-swa)?$/i, '')
        .replace(/^estevia-/, '');
    return clean || resourceName.toLowerCase();
}

/**
 * GET /api/auth/resource-catalog
 * Dynamically parses unique application keys & resource types from Azure cloud scan results & DB records
 */
exports.getResourceCatalog = async (req, res) => {
    try {
        const orgId = req.user.organization_id;
        const catalogMap = new Map();

        const targetSubId = req.query.subscriptionId;
        const targetRg = req.query.resourceGroup;

        // 1. Query active scanned apps for org from MySQL
        const [scannedDbApps] = await db.query(
            'SELECT name, type, azure_resource_id FROM scanned_apps WHERE organization_id = ?',
            [orgId]
        ).catch(() => [[]]);

        // 2. Query manually registered or provisioned apps for org from MySQL
        const [registeredApps] = await db.query(
            'SELECT name, app_type, azure_resource_details FROM applications WHERE organization_id = ?',
            [orgId]
        ).catch(() => [[]]);

        // Helper to check if a resource matches target scope
        const matchesScope = (azureResourceId, azureResourceDetails) => {
            if (!targetSubId && !targetRg) return true; // No filter requested
            
            let subId = null;
            let rg = null;
            
            if (azureResourceId) {
                const match = azureResourceId.match(/\/subscriptions\/([^\/]+)\/resourceGroups\/([^\/]+)/i);
                if (match) {
                    subId = match[1];
                    rg = match[2];
                }
            }
            
            if (azureResourceDetails) {
                try {
                    const details = typeof azureResourceDetails === 'string' ? JSON.parse(azureResourceDetails) : azureResourceDetails;
                    if (details.resourceGroup) {
                        rg = details.resourceGroup;
                    }
                    if (details.resourceId) {
                        const match = details.resourceId.match(/\/subscriptions\/([^\/]+)\/resourceGroups\/([^\/]+)/i);
                        if (match) {
                            subId = match[1];
                            rg = match[2];
                        }
                    }
                } catch (e) {
                    // Ignore JSON parsing error
                }
            }
            
            let match = true;
            if (targetSubId) {
                match = match && (subId && subId.toLowerCase() === targetSubId.toLowerCase());
            }
            if (targetRg) {
                match = match && (rg && rg.toLowerCase() === targetRg.toLowerCase());
            }
            return match;
        };

        const filteredScanned = (scannedDbApps || []).filter(app => matchesScope(app.azure_resource_id, null));
        const filteredRegistered = (registeredApps || []).filter(app => matchesScope(null, app.azure_resource_details));

        const allRows = [...filteredScanned, ...filteredRegistered];

        for (const appRow of allRows) {
            const rawName = appRow.name || '';
            const key = extractAppKey(rawName);
            if (!key) continue;

            const existing = catalogMap.get(key) || {
                key,
                label: key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, ' '),
                icon: '📦',
                resourceTypes: new Set(),
                environments: new Set()
            };

            const rawType = (appRow.type || appRow.app_type || '').toLowerCase();
            const rawNameLower = rawName.toLowerCase();

            // Detect environment suffix dynamically
            const envSegmentMatch = rawNameLower.match(/-(dev|qa|prod|production|staging|test)(-swa)?$/i);
            if (envSegmentMatch) {
                const seg = envSegmentMatch[1].toLowerCase();
                if (seg === 'prod' || seg === 'production') existing.environments.add('prod');
                else if (seg === 'qa' || seg === 'staging' || seg === 'test') existing.environments.add('qa');
                else existing.environments.add('dev');
            } else {
                existing.environments.add('prod');
            }

            if (rawType.includes('vm') || rawType.includes('virtualmachine') || rawType.includes('database') || rawNameLower.includes('vm') || rawNameLower.includes('db-server')) {
                existing.resourceTypes.add('vm');
                existing.icon = '🖥️';
            } else if (rawType.includes('swa') || rawType.includes('staticwebapp') || rawType.includes('frontend') || rawNameLower.includes('swa') || rawNameLower.includes('-web')) {
                existing.resourceTypes.add('swa');
                existing.icon = '🌐';
            } else {
                existing.resourceTypes.add('aca');
                existing.icon = '📦';
            }

            catalogMap.set(key, existing);
        }

        if (catalogMap.size === 0) {
            catalogMap.set('estevia-frontend', {
                key: 'estevia-frontend',
                label: 'Estevia DevOps Frontend (SWA)',
                icon: '🌐',
                resourceTypes: new Set(['swa']),
                environments: new Set(['dev', 'qa', 'prod'])
            });
            catalogMap.set('estevia-backend', {
                key: 'estevia-backend',
                label: 'Estevia DevOps Backend (ACA)',
                icon: '📦',
                resourceTypes: new Set(['aca']),
                environments: new Set(['dev', 'qa', 'prod'])
            });
            catalogMap.set('estevia-api', {
                key: 'estevia-api',
                label: 'Estevia Core API (ACA)',
                icon: '📦',
                resourceTypes: new Set(['aca']),
                environments: new Set(['dev', 'qa', 'prod'])
            });
            catalogMap.set('estevia-db-vm', {
                key: 'estevia-db-vm',
                label: 'Estevia Database Host (VM)',
                icon: '🖥️',
                resourceTypes: new Set(['vm']),
                environments: new Set(['prod'])
            });
        }

        const resultCatalog = Array.from(catalogMap.values()).map(item => ({
            ...item,
            resourceTypes: Array.from(item.resourceTypes),
            environments: Array.from(item.environments).length > 0 ? Array.from(item.environments) : ['prod']
        }));

        res.json({ success: true, count: resultCatalog.length, catalog: resultCatalog });
    } catch (err) {
        console.error('Failed to fetch resource catalog:', err.message);
        res.status(500).json({ error: 'Failed to retrieve dynamic resource catalog' });
    }
};

/**
 * GET /api/auth/users/:userId/resource-permissions
 * Fetches granted app-environment-action mappings for a target user
 */
exports.getUserPermissions = async (req, res) => {
    try {
        const { userId } = req.params;
        const orgId = req.user.organization_id;

        // Fetch user's role
        const [uRows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]).catch(() => [[]]);
        const role = (uRows && uRows[0] && uRows[0].role) ? uRows[0].role.toLowerCase() : 'contributor';

        // Retrieve existing permissions for user
        let [rows] = await db.query(
            'SELECT app_key, environment, actions FROM user_resource_permissions WHERE user_id = ? AND organization_id = ?',
            [userId, orgId]
        );

        // Fetch all catalog keys for organization to ensure complete coverage
        const [scannedDbApps] = await db.query(
            'SELECT name FROM scanned_apps WHERE organization_id = ?',
            [orgId]
        ).catch(() => [[]]);

        const [registeredApps] = await db.query(
            'SELECT name FROM applications WHERE organization_id = ?',
            [orgId]
        ).catch(() => [[]]);

        const catalogKeySet = new Set();
        for (const appRow of [...(scannedDbApps || []), ...(registeredApps || [])]) {
            const key = extractAppKey(appRow.name);
            if (key) catalogKeySet.add(key);
        }

        // Add standard application key fallbacks
        const standardKeys = [
            'connecthub', 'docai', 'protrack', 'talenthq', 'evafusion', 'evaops',
            'estevia-hub', 'protrack-frontend', 'talenthq-frontend', 'docai-frontend',
            'evafusion-frontend', 'connecthub-frontend', 'estevia-marketing-web',
            'platform-management', 'restaurant-frontend', 'evanet',
            'estevia-backend', 'estevia-api', 'estevia-db-vm'
        ];
        standardKeys.forEach(k => catalogKeySet.add(k));
        const allCatalogKeys = Array.from(catalogKeySet);

        const existingAppKeys = new Set((rows || []).map(r => r.app_key));
        const missingKeys = allCatalogKeys.filter(k => !existingAppKeys.has(k));

        if (missingKeys.length > 0) {
            const defaultActions = (role === 'owner' || role === 'admin')
                ? ['view', 'deploy', 'provision', 'cost_remediation', 'db_manage']
                : (role === 'viewer')
                ? ['view']
                : ['view', 'deploy', 'provision', 'cost_remediation'];

            const insertVals = [];
            for (const appKey of missingKeys) {
                const envs = role === 'member' ? ['dev', 'qa'] : ['dev', 'qa', 'prod'];
                for (const env of envs) {
                    insertVals.push([userId, orgId, appKey, env, JSON.stringify(defaultActions)]);
                }
            }

            if (insertVals.length > 0) {
                await db.query(
                    'INSERT IGNORE INTO user_resource_permissions (user_id, organization_id, app_key, environment, actions) VALUES ?',
                    [insertVals]
                ).catch(() => {});

                const [newRows] = await db.query(
                    'SELECT app_key, environment, actions FROM user_resource_permissions WHERE user_id = ? AND organization_id = ?',
                    [userId, orgId]
                ).catch(() => [[]]);
                rows = newRows || [];
            }
        }

        const permissions = {};
        for (const r of rows) {
            if (!permissions[r.app_key]) {
                permissions[r.app_key] = { dev: [], qa: [], prod: [] };
            }
            let actionList = [];
            try {
                actionList = typeof r.actions === 'string' ? JSON.parse(r.actions) : (r.actions || []);
            } catch (e) {
                actionList = [];
            }
            permissions[r.app_key][r.environment] = actionList;
        }

        res.json({ userId, permissions });
    } catch (err) {
        console.error('Failed to fetch user resource permissions:', err.message);
        res.status(500).json({ error: 'Failed to retrieve permissions' });
    }
};

/**
 * PUT /api/auth/users/:userId/resource-permissions
 * Updates granted app-environment-action mappings for a user (restricted to owner and admin)
 */
exports.updateUserPermissions = async (req, res) => {
    try {
        const { userId } = req.params;
        const orgId = req.user.organization_id;
        const { permissions } = req.body; // { appKey: { dev: ['view', 'deploy'], qa: [] } }

        if (!permissions || typeof permissions !== 'object') {
            return res.status(400).json({ error: 'Invalid permissions payload' });
        }

        // Delete existing permissions for user
        await db.query(
            'DELETE FROM user_resource_permissions WHERE user_id = ? AND organization_id = ?',
            [userId, orgId]
        );

        const insertValues = [];
        for (const [appKey, envMap] of Object.entries(permissions)) {
            if (!envMap || typeof envMap !== 'object') continue;
            for (const env of ['dev', 'qa', 'prod']) {
                const actionsArr = envMap[env];
                if (Array.isArray(actionsArr) && actionsArr.length > 0) {
                    insertValues.push([
                        userId,
                        orgId,
                        appKey,
                        env,
                        JSON.stringify(actionsArr)
                    ]);
                }
            }
        }

        if (insertValues.length > 0) {
            await db.query(
                'INSERT INTO user_resource_permissions (user_id, organization_id, app_key, environment, actions) VALUES ?',
                [insertValues]
            );
        }

        res.json({ message: 'Permissions updated successfully', userId });
    } catch (err) {
        console.error('Failed to update user permissions:', err.message);
        res.status(500).json({ error: 'Failed to update permissions' });
    }
};
