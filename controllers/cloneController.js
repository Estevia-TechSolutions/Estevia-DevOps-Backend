const db = require('../config/db');
const { sendTeamsNotification } = require('../utils/teamsNotifier');

const cloneController = {
    /**
     * POST /api/environments/clone
     * Clones an application environment configuration.
     */
    cloneEnvironment: async (req, res) => {
        try {
            const { organizationId, appName, sourceEnv, targetEnv } = req.body;

            if (!organizationId || !appName || !sourceEnv || !targetEnv) {
                return res.status(400).json({ success: false, message: 'Missing parameters (organizationId, appName, sourceEnv, targetEnv).' });
            }

            console.log(`[Clone] Initiating environment clone for ${appName}: [${sourceEnv}] -> [${targetEnv}]...`);

            // 1. Fetch source application record from DB
            const [sourceApps] = await db.query(
                'SELECT * FROM applications WHERE organization_id = ? AND name = ?',
                [organizationId, appName]
            );

            if (sourceApps.length === 0) {
                return res.status(404).json({ success: false, message: `Source app '${appName}' not found.` });
            }

            const sourceApp = sourceApps[0];
            const targetAppName = appName.replace(`-${sourceEnv}`, `-${targetEnv}`);

            // 2. Generate target app resource details (copying config envs, scaling, location)
            const sourceDetails = typeof sourceApp.azure_resource_details === 'string' ? JSON.parse(sourceApp.azure_resource_details || '{}') : (sourceApp.azure_resource_details || {});
            
            const targetDetails = {
                ...sourceDetails,
                hostname: `${targetAppName}.${sourceDetails.hostname ? sourceDetails.hostname.split('.').slice(1).join('.') : 'azurewebsites.net'}`,
                resourceId: sourceDetails.resourceId ? sourceDetails.resourceId.replace(appName, targetAppName) : ''
            };

            // 3. Save new cloned application to DB
            const [existingTarget] = await db.query(
                'SELECT id FROM applications WHERE organization_id = ? AND name = ?',
                [organizationId, targetAppName]
            );

            let targetAppId;
            if (existingTarget.length === 0) {
                const [insertResult] = await db.query(
                    `INSERT INTO applications 
                     (organization_id, name, repo_url, app_type, status, azure_resource_details, godaddy_dns_details)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [organizationId, targetAppName, sourceApp.repo_url, sourceApp.app_type, 'deployed', JSON.stringify(targetDetails), JSON.stringify({})]
                );
                targetAppId = insertResult.insertId;
            } else {
                targetAppId = existingTarget[0].id;
                await db.query(
                    `UPDATE applications 
                     SET repo_url = ?, app_type = ?, status = 'deployed', azure_resource_details = ? 
                     WHERE id = ?`,
                    [sourceApp.repo_url, sourceApp.app_type, JSON.stringify(targetDetails), targetAppId]
                );
            }

            const cloneResponse = {
                success: true,
                message: `Successfully cloned environment for '${appName}' from '${sourceEnv}' to '${targetEnv}'.`,
                sourceApp: appName,
                targetApp: {
                    id: targetAppId,
                    name: targetAppName,
                    status: 'deployed',
                    azureDetails: targetDetails
                }
            };

            res.json(cloneResponse);

            // Fire Teams alert asynchronously — must not block the HTTP response
            setImmediate(async () => {
                try {
                    const orgId = req.user?.organization_id || organizationId;
                    const actorEmail = req.user?.email || 'system';
                    const sourceUrl = sourceApp.azure_resource_details
                        ? (typeof sourceApp.azure_resource_details === 'string'
                            ? JSON.parse(sourceApp.azure_resource_details) : sourceApp.azure_resource_details).hostname
                        : appName;
                    await sendTeamsNotification(orgId, {
                        title: '🔄 Environment Clone Completed',
                        text:  `App **${appName}** was successfully cloned from **${sourceEnv}** to **${targetEnv}**.`,
                        themeColor: '36a64f',
                        facts: [
                            { name: 'Source App',       value: appName },
                            { name: 'Source Env',       value: sourceEnv },
                            { name: 'Cloned App Name',  value: targetAppName },
                            { name: 'Target Env',       value: targetEnv },
                            { name: 'Target Hostname',  value: targetDetails.hostname || targetAppName },
                            { name: 'Initiated By',     value: actorEmail },
                            { name: 'Completed At',     value: new Date().toISOString() }
                        ]
                    });
                } catch (notifyErr) {
                    console.error('[Clone] Teams notification failed:', notifyErr.message);
                }
            });
        } catch (error) {
            console.error('[Clone] Environment cloning failed:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }
};

module.exports = cloneController;
