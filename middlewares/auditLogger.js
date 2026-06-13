const db = require('../config/db');

async function auditLogger(req, res, next) {
    // Intercept response finish event to ensure we only log completed actions
    res.on('finish', async () => {
        try {
            const method = req.method;
            const path = req.path;
            
            // Only audit mutating actions (POST, PUT, DELETE) and skip read-only operations
            if (!['POST', 'PUT', 'DELETE'].includes(method)) return;
            
            // Skip logging internal health checks or diagnostic actions
            if (path.includes('/health') || path.includes('/diagnostic')) return;
            
            // Check if user session context is present (from authentication middleware)
            const actorEmail = req.user?.email || 'system-bypass';
            
            // Resolve action type and target from request details
            let actionType = 'UNKNOWN_ACTION';
            let target = path;
            
            if (path.includes('/auth/users/sync')) {
                actionType = 'DIRECTORY_SYNC';
                target = 'Azure AD Sync';
            } else if (path.includes('/auth/users/') && path.includes('/role')) {
                actionType = 'ROLE_CHANGE';
                target = req.params.userId || 'User Role';
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
            } else if (method === 'DELETE' && path.startsWith('/api/apps/')) {
                actionType = 'DELETE_RESOURCES';
                target = path.split('/').pop() || 'Azure Resource';
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
