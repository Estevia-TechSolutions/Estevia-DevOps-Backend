const db = require('../config/db');

async function auditLogger(req, res, next) {
    // Intercept response finish event to ensure we only log completed actions
    res.on('finish', async () => {
        try {
            const method = req.method;
            const path = req.path;
            const isLogsView = method === 'GET' && path.includes('/observability/') && path.includes('/logs');
            const isAuditView = method === 'GET' && path.includes('/audit-logs');
            const isDbBackup = method === 'GET' && path.includes('/database-hub/backup');
            
            // Only audit mutating actions (POST, PUT, DELETE) or sensitive read/backup actions
            if (!['POST', 'PUT', 'DELETE'].includes(method) && !isLogsView && !isAuditView && !isDbBackup) return;
            
            // Skip logging internal health checks or diagnostic actions
            if (path.includes('/health') || path.includes('/diagnostic')) return;
            
            // Check if user session context is present (from authentication middleware)
            const actorEmail = req.user?.email || 'system-bypass';
            
            // Resolve action type and target from request details
            let actionType = 'UNKNOWN_ACTION';
            let target = path;
            
            if (isLogsView) {
                actionType = 'VIEW_LOGS';
                const parts = path.split('/');
                const obsIdx = parts.indexOf('observability');
                target = (obsIdx !== -1 && parts[obsIdx + 1]) ? parts[obsIdx + 1] : 'Container App';
            } else if (isAuditView) {
                actionType = 'VIEW_AUDIT';
                target = 'Security Audit Trail';
            } else if (isDbBackup) {
                actionType = 'DB_BACKUP';
                target = req.query?.dbName || req.body?.dbName || 'Database Hub Backup';
            } else if (path.includes('/auth/users/sync')) {
                actionType = 'DIRECTORY_SYNC';
                target = 'Azure AD Sync';
            } else if (path.includes('/auth/users/') && path.includes('/role')) {
                actionType = 'ROLE_CHANGE';
                target = req.params.userId || 'User Role';
            } else if (path.includes('/credentials/validate')) {
                actionType = 'CRED_VALIDATE';
                target = req.body?.provider || 'Credentials Validation';
            } else if (path.includes('/credentials')) {
                actionType = 'CRED_UPDATE';
                target = req.body?.provider || 'Integration Credentials';
            } else if (path.includes('/apps/provision')) {
                actionType = 'PROVISION_APP';
                target = req.body?.name || 'Azure Resource';
            } else if (path.includes('/apps/bind-domain')) {
                actionType = 'BIND_DOMAIN';
                target = req.body?.subdomain ? `${req.body.subdomain}.${req.body.domain || 'esteviatech.com'}` : 'Custom Domain';
            } else if (path.includes('/apps/execute-query')) {
                actionType = 'SQL_RUN';
                target = req.body?.query ? req.body.query.substring(0, 100) : 'SQL Console';
            } else if (path.includes('/database/migrate')) {
                actionType = 'DB_MIGRATION';
                target = req.body?.targetDb || 'Database Schema';
            } else if (path.includes('/environments/clone')) {
                actionType = 'ENV_CLONE';
                target = req.body?.appName ? `${req.body.appName} (${req.body.sourceEnv} -> ${req.body.targetEnv})` : 'Environment';
            } else if (path.includes('/apps/cost/apply-remediation')) {
                actionType = 'APPLY_REMEDIATION';
                target = req.body?.appName ? `${req.body.appName} (${req.body.type || 'Remedy'})` : 'Cost Optimization';
            } else if (path.includes('/apps/cost/ask-eva')) {
                actionType = 'EVA_AI_CONSULT';
                target = req.body?.question ? req.body.question.substring(0, 100) : 'Eva AI Assistant';
            } else if (path.includes('/keyvault/map')) {
                actionType = 'KEYVAULT_SECRET_MAP';
                target = req.body?.secretName || 'KeyVault Secret';
            } else if (path.includes('/keyvault/mappings/')) {
                actionType = 'KEYVAULT_SECRET_UNMAP';
                target = path.split('/').pop() || 'Secret Mapping';
            } else if (path.includes('/apps/') && path.endsWith('/control')) {
                actionType = 'RESOURCE_POWER_CONTROL';
                const parts = path.split('/');
                const ctrlIdx = parts.indexOf('control');
                target = (ctrlIdx > 0) ? parts[ctrlIdx - 1] : 'Azure Resource';
            } else if (path.includes('/apps/') && path.endsWith('/traffic')) {
                actionType = 'TRAFFIC_UPDATE';
                const parts = path.split('/');
                const idx = parts.indexOf('traffic');
                target = (idx > 0) ? parts[idx - 1] : 'App Traffic';
            } else if (path.includes('/apps/') && path.endsWith('/revision-mode')) {
                actionType = 'REVISION_MODE_UPDATE';
                const parts = path.split('/');
                const idx = parts.indexOf('revision-mode');
                target = (idx > 0) ? parts[idx - 1] : 'App Revision Mode';
            } else if (path.includes('/apps/pipeline') || path.includes('/apps/create-pipeline-yml')) {
                actionType = 'PIPELINE_CREATE';
                target = req.body?.appName || req.body?.repoName || 'CI/CD Pipeline';
            } else if (path.includes('/apps/databases')) {
                actionType = 'PROVISION_DB';
                target = req.body?.dbName || 'Database Instance';
            } else if (path.includes('/org/setup-azure') || path.includes('/org/setup-devops') || path.includes('/org/setup-dns') || path.includes('/org/complete') || path.includes('/org/register')) {
                actionType = 'ONBOARDING_SETUP';
                target = path.split('/').pop() || 'Organization Onboarding';
            } else if (path.includes('/scheduler/rules')) {
                actionType = 'SCHEDULER_SAVE';
                target = req.body?.ruleName || 'Sleep Scheduler Rule';
            } else if (path.includes('/database-hub/compare')) {
                actionType = 'DB_SCHEMA_COMPARE';
                target = req.body?.sourceDb && req.body?.targetDb ? `${req.body.sourceDb} -> ${req.body.targetDb}` : 'Database Hub';
            } else if (path.includes('/database-hub/migrate')) {
                actionType = 'DB_SCHEMA_MIGRATE';
                target = req.body?.targetDb || 'Database Hub Migration';
            } else if (path.includes('/database-hub/migrate-data')) {
                actionType = 'DB_DATA_MIGRATE';
                target = req.body?.targetDb || 'Database Hub Data Migration';
            } else if (path.includes('/api/webhooks/azure-devops/')) {
                actionType = 'WEBHOOK_AZURE_DEVOPS';
                target = 'Azure DevOps Webhook';
            } else if (method === 'DELETE' && path.startsWith('/api/apps/')) {
                actionType = 'DELETE_RESOURCES';
                target = path.split('/').pop() || 'Azure Resource';
            }

            // Fallback for UNKNOWN_ACTION based on path target
            if (actionType === 'UNKNOWN_ACTION') {
                if (path.includes('/api/org/test/')) {
                    const provider = path.split('/test/').pop();
                    actionType = `TEST_${provider.toUpperCase()}_CONN`;
                    target = req.body?.provider || `${provider.charAt(0).toUpperCase() + provider.slice(1)} Connection`;
                } else if (path.includes('/api/apps/organization-settings')) {
                    actionType = 'ORG_SETTINGS_UPDATE';
                    target = req.body?.orgName || 'Organization Settings';
                } else if (path.includes('/api/apps/test-teams-webhook')) {
                    actionType = 'TEAMS_WEBHOOK_TEST';
                    target = req.body?.webhookUrl || 'Teams Webhook';
                } else if (path.includes('/api/apps/setup-teams-service-hook')) {
                    actionType = 'TEAMS_HOOK_SETUP';
                    target = req.body?.webhookUrl || 'Teams Service Hook';
                } else if (path.includes('/api/apps/discover-workspace')) {
                    actionType = 'DISCOVER_WORKSPACE';
                    target = req.body?.workspaceName || 'Log Analytics Workspace';
                } else if (path.includes('/api/apps/create-dockerfile')) {
                    actionType = 'DOCKERFILE_CREATE';
                    target = req.body?.repoName ? `${req.body.repoName}/Dockerfile` : 'Dockerfile';
                } else if (path.includes('/api/apps/update-dockerfile')) {
                    actionType = 'DOCKERFILE_UPDATE';
                    target = req.body?.repoName ? `${req.body.repoName}/Dockerfile` : 'Dockerfile';
                } else if (path.includes('/api/apps/dns-swap')) {
                    actionType = 'DNS_SWAP';
                    target = req.body?.app1Name && req.body?.app2Name ? `${req.body.app1Name} <-> ${req.body.app2Name}` : 'DNS Swap';
                } else {
                    // Smart generic regex mapping fallback based on path keywords
                    const cleanPath = path.replace(/^\/api\//, '');
                    const segments = cleanPath.split('/').filter(Boolean);
                    
                    if (segments.length > 0) {
                        let actionWord = 'UPDATE';
                        if (method === 'POST') actionWord = 'CREATE';
                        if (method === 'DELETE') actionWord = 'DELETE';
                        if (method === 'GET') actionWord = 'READ';

                        const lastSegment = segments[segments.length - 1];
                        const upperSegment = lastSegment.toUpperCase().replace(/-/g, '_');
                        actionType = `${upperSegment}_${actionWord}`;
                        
                        if (segments.length > 1 && !['apps', 'database-hub', 'org', 'credentials', 'keyvault'].includes(segments[segments.length - 2])) {
                            target = segments[segments.length - 2];
                        } else {
                            target = req.body?.name || req.body?.appName || lastSegment;
                        }
                    }
                }
            }

            // Exclude passwords, secrets, tokens, or private keys from audit details log for compliance
            const bodyCopy = { ...req.body };
            const sensitiveKeys = ['password', 'secret', 'pat', 'token', 'clientSecret', 'apiKey', 'encrypted_secrets', 'sqlScript'];
            for (const key of sensitiveKeys) {
                if (bodyCopy[key]) {
                    bodyCopy[key] = '******';
                }
            }

            const details = JSON.stringify({
                method,
                path,
                ip: req.ip || req.connection.remoteAddress,
                query: req.query,
                payload: bodyCopy
            });

            console.log(`[AuditLog] Actor: ${actorEmail} | Action: ${actionType} | Target: ${target}`);
            
            // Insert audit record
            await db.query(
                'INSERT INTO audit_logs (actor_email, action_type, target, details) VALUES (?, ?, ?, ?)',
                [actorEmail, actionType, target, details]
            );
        } catch (err) {
            console.error('[AuditLogger] Failed to write audit record:', err.message);
        }
    });

    next();
}

module.exports = auditLogger;
