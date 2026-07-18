const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const https = require('https');
const { DefaultAzureCredential, ClientSecretCredential } = require('@azure/identity');
const credentialController = require('./credentialController');
const { sendTeamsNotification } = require('../utils/teamsNotifier');
const crypto = require('crypto');
const emailService = require('../utils/emailService');

async function getAzureCredential(organizationId) {
    try {
        const azureSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure');
        if (azureSecrets) {
            if (azureSecrets.type === 'managed_identity') {
                console.log(`[AzureAuth] Using DefaultAzureCredential (Managed Identity) for organization: ${organizationId}`);
                return new DefaultAzureCredential();
            }
            if (azureSecrets.clientId && azureSecrets.clientSecret && azureSecrets.tenantId) {
                console.log(`[AzureAuth] Using ClientSecretCredential for organization: ${organizationId}`);
                return new ClientSecretCredential(
                    azureSecrets.tenantId,
                    azureSecrets.clientId,
                    azureSecrets.clientSecret
                );
            }
        }
    } catch (err) {
        console.warn(`[AzureAuth] Failed to retrieve Azure credentials for organization ${organizationId}:`, err.message);
    }
    console.log(`[AzureAuth] Falling back to DefaultAzureCredential for organization: ${organizationId}`);
    return new DefaultAzureCredential();
}

if (!process.env.JWT_SECRET) {
    console.error('[authController] FATAL: JWT_SECRET environment variable is not set. Server cannot start securely.');
    if (process.env.NODE_ENV === 'production') process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET must be set in environment variables'); })();

// Helper to decode JWT payload without verification (for Azure ID Token)
function decodeJwtPayload(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = Buffer.from(parts[1], 'base64').toString('utf8');
        return JSON.parse(payload);
    } catch (err) {
        console.error('[authController] Failed to decode ID token payload:', err.message);
        return null;
    }
}

// ── Seat Capacity Helper ────────────────────────────────────────────────────────────
// Single source of truth for seat gating across all auth handlers.
async function checkSeatCapacity(organizationId) {
    try {
        const [[org]] = await db.query(
            'SELECT operator_seats_limit FROM organizations WHERE id = ?',
            [organizationId]
        );
        const limit = org?.operator_seats_limit ?? 10;
        const [[{ count }]] = await db.query(
            `SELECT COUNT(*) AS count FROM users WHERE organization_id = ? AND role IN ('owner','admin','contributor') AND id NOT LIKE 'dev-bypass-%' AND id NOT LIKE 'admin-override-%' AND id <> 'dev-bypass-user-id'`,
            [organizationId]
        );
        return { limit, current: count, isFull: count >= limit };
    } catch (err) {
        console.warn('[authController] checkSeatCapacity failed (non-fatal):', err.message);
        return { limit: 10, current: 0, isFull: false };
    }
}
// ── End Seat Helper ────────────────────────────────────────────────────────────

async function completeLoginSession(user, loginMethod, req, res, mfaVerified = false) {
    try {
        let manualMfaRequired = 0;
        let ssoMfaRequired = 0;
        let finalOrg = null;
        let requiresOnboarding = true;

        if (user.organization_id) {
            const [matchedOrgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [user.organization_id]);
            if (matchedOrgs.length > 0) {
                finalOrg = matchedOrgs[0];
                manualMfaRequired = finalOrg.manual_mfa_required || 0;
                ssoMfaRequired = finalOrg.sso_mfa_required || 0;
                requiresOnboarding = !finalOrg.onboarding_complete;
            }
        }

        // Fetch user's latest MFA status
        const [users] = await db.query('SELECT mfa_enabled, mfa_secret FROM users WHERE id = ?', [user.id]);
        const dbUser = users[0] || {};
        const mfaEnabled = dbUser.mfa_enabled || 0;

        // Determine if MFA is enforced for this login method (bypass is always exempt)
        let mfaRequired = false;
        if (!mfaVerified) {
            if (loginMethod === 'sso' && ssoMfaRequired === 1) {
                mfaRequired = true;
            } else if (loginMethod === 'manual' && manualMfaRequired === 1) {
                mfaRequired = true;
            }
        }

        if (mfaRequired) {
            if (mfaEnabled === 0) {
                const tempToken = jwt.sign(
                    { id: user.id, purpose: 'mfa_setup', loginMethod },
                    JWT_SECRET,
                    { expiresIn: '5m' }
                );
                return res.json({
                    code: 'MFA_SETUP_REQUIRED',
                    message: 'Multi-Factor Authentication setup is required.',
                    tempToken
                });
            } else {
                const tempToken = jwt.sign(
                    { id: user.id, purpose: 'mfa_validate', loginMethod },
                    JWT_SECRET,
                    { expiresIn: '5m' }
                );
                return res.json({
                    code: 'MFA_REQUIRED',
                    message: 'Multi-Factor Authentication verification is required.',
                    tempToken
                });
            }
        }

        // Generate JWT token
        let expiresIn = '24h';
        if (loginMethod === 'bypass') expiresIn = '30d';
        else if (loginMethod === 'manual') expiresIn = '8h';

        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                name: user.name,
                organization_id: user.organization_id,
                role: user.role,
                tenant_id: user.tenant_id
            },
            JWT_SECRET,
            { expiresIn }
        );

        req.user = user;
        return res.json({
            token,
            user,
            requiresOnboarding,
            organization: finalOrg
        });
    } catch (err) {
        console.error('[authController] completeLoginSession failed:', err.message);
        return res.status(500).json({ error: 'Authentication processing failed.' });
    }
}

// Exchanges code for Microsoft OAuth access token and user claims
const microsoftLogin = async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'OAuth authorization code is required' });
    }

    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
    const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
    const envTenantId = process.env.MICROSOFT_TENANT_ID || 'common';

    if (!clientId || !clientSecret || !redirectUri) {
        console.error('[authController] Microsoft OAuth credentials are not fully configured in backend environment.');
        return res.status(500).json({ 
            error: 'Microsoft OAuth app registration is not configured on this server.' 
        });
    }

    try {
        // Exchange authorization code for token
        console.log(`[authController] Exchanging code with Microsoft login service for tenant: ${envTenantId}...`);
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('code', code);
        params.append('redirect_uri', redirectUri);
        params.append('grant_type', 'authorization_code');

        const tokenResponse = await axios.post(
            `https://login.microsoftonline.com/${envTenantId}/oauth2/v2.0/token`,
            params.toString(),
            { 
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                httpsAgent: new https.Agent({ family: 4 }),
                timeout: 15000
            }
        );

        const { id_token } = tokenResponse.data;
        if (!id_token) {
            return res.status(401).json({ error: 'No ID Token returned from Microsoft authentication' });
        }

        const claims = decodeJwtPayload(id_token);
        if (!claims) {
            return res.status(401).json({ error: 'Failed to parse Microsoft claims' });
        }

        const email = claims.email || claims.preferred_username || claims.upn;
        const name = claims.name || email.split('@')[0];
        const msalId = claims.oid || claims.sub;
        const tenantIdFromToken = claims.tid || claims.iss?.split('/')?.pop() || null;

        if (!email) {
            return res.status(400).json({ error: 'Email claim missing in Microsoft ID Token' });
        }
        if (!tenantIdFromToken) {
            return res.status(400).json({ error: 'Tenant ID claim (tid) missing in Microsoft ID Token' });
        }

        // Look up organization by tenant ID (Option A)
        const [orgs] = await db.query('SELECT * FROM organizations WHERE tenant_id = ?', [tenantIdFromToken]);
        const matchedOrg = orgs.length > 0 ? orgs[0] : null;

        // Extract role from Azure AD claims (App Roles, Directory Roles, or Security Groups)
        let userRole = matchedOrg ? 'viewer' : 'admin';
        if (claims.groups && Array.isArray(claims.groups)) {
            const ownerGroupId = process.env.AZURE_AD_GROUP_OWNER || 'owner-group-id-placeholder';
            const adminGroupId = process.env.AZURE_AD_GROUP_ADMIN || 'admin-group-id-placeholder';
            const contributorGroupId = process.env.AZURE_AD_GROUP_CONTRIBUTOR || 'contributor-group-id-placeholder';
            const viewerGroupId = process.env.AZURE_AD_GROUP_VIEWER || 'viewer-group-id-placeholder';

            if (claims.groups.includes(ownerGroupId)) {
                userRole = 'owner';
            } else if (claims.groups.includes(adminGroupId)) {
                userRole = 'admin';
            } else if (claims.groups.includes(contributorGroupId)) {
                userRole = 'contributor';
            } else if (claims.groups.includes(viewerGroupId)) {
                userRole = 'viewer';
            }
        } else if (claims.roles && claims.roles.length > 0) {
            const matchedRole = claims.roles.find(r => ['owner', 'admin', 'member', 'viewer', 'contributor', 'reader'].includes(r.toLowerCase()));
            if (matchedRole) {
                userRole = matchedRole.toLowerCase();
            } else {
                userRole = claims.roles[0].toLowerCase();
            }
        } else if (claims.wids && claims.wids.includes('62e90394-69f5-4237-9190-012177145e10')) {
            // Global Administrator Template ID
            userRole = 'owner';
        } else if (matchedOrg && matchedOrg.admin_email && matchedOrg.admin_email.toLowerCase() === email.toLowerCase()) {
            // Fallback: check matching organization admin_email setting
            userRole = 'owner';
        }

        // Check if user already exists
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [msalId]);
        let user;

        if (users.length === 0) {
            // User does not exist by MSAL ID. Check if they exist by email (pre-seeded user)
            const [usersByEmail] = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
            const orgId = matchedOrg ? matchedOrg.id : null;
            
            if (usersByEmail.length > 0) {
                // Link pre-seeded user
                const preSeededUser = usersByEmail[0];
                console.log(`[authController] Linking pre-seeded user ${email} to MSAL ID: ${msalId} with role: ${preSeededUser.role}`);
                const finalRole = preSeededUser.role || userRole;
                
                await db.query(
                    'UPDATE users SET id = ?, name = ?, tenant_id = ?, organization_id = ?, role = ? WHERE email = ?',
                    [msalId, name, tenantIdFromToken, orgId || preSeededUser.organization_id, finalRole, email]
                );
                user = { id: msalId, email, name, organization_id: orgId || preSeededUser.organization_id, tenant_id: tenantIdFromToken, role: finalRole };
            } else {
                // Truly new user — apply seat capacity gate. If seat limit has hit, block login and database insertion.
                if (orgId) {
                    const seatCheck = await checkSeatCapacity(orgId);
                    if (seatCheck.isFull) {
                        console.warn(`[authController] Seat cap reached for org '${orgId}' (${seatCheck.current}/${seatCheck.limit}). New user ${email} login rejected.`);
                        return res.status(403).json({
                            error: `Seat license limit reached (${seatCheck.current}/${seatCheck.limit}). Access denied. Contact your administrator to increase the operator seat limit.`
                        });
                    }
                }
                console.log(`[authController] Creating new user: ${email} for tenant: ${tenantIdFromToken} with role: ${userRole}`);
                await db.query(
                    'INSERT INTO users (id, email, name, organization_id, tenant_id, role) VALUES (?, ?, ?, ?, ?, ?)',
                    [msalId, email, name, orgId, tenantIdFromToken, userRole]
                );
                user = { id: msalId, email, name, organization_id: orgId, tenant_id: tenantIdFromToken, role: userRole };
            }
        } else {
            user = users[0];
            // ROLE PRESERVATION RULE: If a role is already set in the DB, ALWAYS keep it.
            // Never allow the SSO-derived default (userRole) to overwrite an existing DB role.
            // This prevents admins/owners from reverting to 'viewer' on every login.
            const finalRole = (user.role && user.role.trim() !== '') ? user.role : userRole;
            let targetOrgId = user.organization_id;

            // Only the non-role fields are candidates for update from SSO claims
            let shouldUpdate = user.name !== name || user.email !== email || user.tenant_id !== tenantIdFromToken;

            if (matchedOrg && user.organization_id !== matchedOrg.id) {
                targetOrgId = matchedOrg.id;
                shouldUpdate = true;
            }

            if (shouldUpdate) {
                // Update name/email/tenant/org — but NEVER touch role here
                await db.query(
                    'UPDATE users SET name = ?, email = ?, tenant_id = ?, organization_id = ? WHERE id = ?',
                    [name, email, tenantIdFromToken, targetOrgId, msalId]
                );
                user.name = name;
                user.email = email;
                user.tenant_id = tenantIdFromToken;
                user.organization_id = targetOrgId;
            }
            // Always carry the preserved role forward in the in-memory user object
            user.role = finalRole;
        }

        return await completeLoginSession(user, 'sso', req, res);
    } catch (err) {
        const errorDetails = err.response?.data || err.message;
        console.error('[authController] Microsoft OAuth exchange failed:', errorDetails);
        try {
            require('fs').appendFileSync(
                require('path').join(__dirname, '../error.log'),
                `[${new Date().toISOString()}] Exchange failed: ${JSON.stringify(errorDetails)}\n`
            );
        } catch (fsErr) {
            console.error('Failed to write to error.log:', fsErr.message);
        }
        return res.status(500).json({ 
            error: 'Authentication exchange failed', 
            details: errorDetails 
        });
    }
};

// Returns details of the logged in user
const getMe = async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User session not found in database' });
        }
        return res.json(users[0]);
    } catch (err) {
        console.error('[authController] getMe failed:', err.message);
        return res.status(500).json({ error: 'Failed to retrieve user session context' });
    }
};

// Developer Override Login — always grants viewer-only access (for local dev/testing)
const bypassLogin = async (req, res) => {
    try {
        const { organizationId, requestedRole } = req.body;
        if (!organizationId) {
            return res.status(400).json({ error: 'organizationId is required for Developer Override login.' });
        }
        const cleanOrgId = organizationId.toLowerCase().trim();
        const bypassRole = requestedRole === 'admin' ? 'admin' : 'viewer';

        console.log(`[authController] Developer Override authenticating (${bypassRole} role) for organization: ${cleanOrgId}...`);
        
        // Ensure organization exists
        const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [cleanOrgId]);
        if (orgs.length === 0) {
            return res.status(404).json({ error: `Organization '${cleanOrgId}' not found.` });
        }
        const org = orgs[0];

        const bypassUserId = `dev-bypass-${cleanOrgId}`;
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [bypassUserId]);

        let user;
        if (users.length === 0) {
            // Create bypass user with requested role for this organization
            const bypassEmail = `dev-bypass@${cleanOrgId}.evaops`;
            await db.query(
                "INSERT INTO users (id, email, name, organization_id, tenant_id, role) VALUES (?, ?, ?, ?, ?, ?)",
                [bypassUserId, bypassEmail, 'Developer Override', cleanOrgId, org.tenant_id || '', bypassRole]
            );
            user = { id: bypassUserId, email: bypassEmail, name: 'Developer Override', organization_id: cleanOrgId, tenant_id: org.tenant_id || '', role: bypassRole };
        } else {
            user = users[0];
            // Force-reset role to the requested bypassRole
            if (user.role !== bypassRole || user.name !== 'Developer Override' || user.organization_id !== cleanOrgId) {
                console.log(`[authController] Developer Override: resetting role from '${user.role}' → '${bypassRole}' for organization '${cleanOrgId}'`);
                await db.query("UPDATE users SET role = ?, name = 'Developer Override', organization_id = ? WHERE id = ?", [bypassRole, cleanOrgId, bypassUserId]);
                user.role = bypassRole;
                user.name = 'Developer Override';
                user.organization_id = cleanOrgId;
            }
        }

        return await completeLoginSession(user, 'bypass', req, res);
    } catch (err) {
        console.error('[authController] Developer Override failed:', err.message);
        return res.status(500).json({ error: 'Developer Override login failed', details: err.message });
    }
};

// Admin Override Login — password-protected admin access for any registered org
// Password formula: {FIRST 4 LETTERS OF ORG ID — UPPERCASE} + "2026" + "CbEt06"
// Example: org 'estevia' → 'ESTE2026CbEt06'
const adminOverrideLogin = async (req, res) => {
    try {
        const { organizationId, password } = req.body;

        if (!organizationId || !password) {
            return res.status(400).json({ error: 'Organization ID and password are required.' });
        }

        // Look up the organization
        const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [organizationId.toLowerCase().trim()]);
        if (orgs.length === 0) {
            return res.status(401).json({ error: 'Invalid organization or password.' });
        }
        const org = orgs[0];

        // Compute expected password: first 4 chars of org ID (uppercase) + '2026' + 'CbEt06'
        const orgPrefix = org.id.replace(/[^a-z0-9]/gi, '').substring(0, 4).toUpperCase();
        const expectedPassword = `${orgPrefix}2026CbEt06`;

        if (password !== expectedPassword) {
            console.warn(`[authController] Admin Override: incorrect password attempt for org '${org.id}'`);
            return res.status(401).json({ error: 'Invalid organization or password.' });
        }

        // Create or fetch the admin override user for this org
        const adminOverrideId = `admin-override-${org.id}`;
        const [existingAdminUsers] = await db.query('SELECT * FROM users WHERE id = ?', [adminOverrideId]);

        let user;
        if (existingAdminUsers.length === 0) {
            await db.query(
                'INSERT INTO users (id, email, name, organization_id, tenant_id, role) VALUES (?, ?, ?, ?, ?, ?)',
                [adminOverrideId, `admin-override@${org.id}.evaops`, 'Admin Override', org.id, org.tenant_id || '', 'admin']
            );
            user = { id: adminOverrideId, email: `admin-override@${org.id}.evaops`, name: 'Admin Override', organization_id: org.id, tenant_id: org.tenant_id || '', role: 'admin' };
        } else {
            user = existingAdminUsers[0];
            // Always ensure admin override user has admin role
            if (user.role !== 'admin') {
                await db.query("UPDATE users SET role = 'admin' WHERE id = ?", [adminOverrideId]);
                user.role = 'admin';
            }
        }

        return await completeLoginSession(user, 'manual', req, res);
    } catch (err) {
        console.error('[authController] Admin Override failed:', err.message);
        return res.status(500).json({ error: 'Admin Override login failed', details: err.message });
    }
};

const runDiagnostic = async (req, res) => {
    const dnsPromises = require('dns').promises;
    const net = require('net');
    const results = {};
    const domains = [
        'login.microsoftonline.com', 
        'www.google.com', 
        'api.godaddy.com', 
        'dev.azure.com',
        'estevia-dev-db.mysql.database.azure.com',
        'estevia-dev-db.estevia-prod-db.private.mysql.database.azure.com',
        'estevia-prod-db-v2.estevia-prod-db.private.mysql.database.azure.com'
    ];

    // 1. DNS lookups
    results.dns = {};
    for (const domain of domains) {
        results.dns[domain] = {};
        try {
            results.dns[domain].ipv4 = await dnsPromises.resolve4(domain);
        } catch (err) {
            results.dns[domain].ipv4_error = err.message;
        }
        try {
            results.dns[domain].ipv6 = await dnsPromises.resolve6(domain);
        } catch (err) {
            results.dns[domain].ipv6_error = err.message;
        }
    }

    // 2. HTTP connectivity checks
    results.http = {};
    const endpoints = {
        google: 'https://www.google.com',
        microsoft: 'https://login.microsoftonline.com',
        microsoft_token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
    };

    for (const [key, url] of Object.entries(endpoints)) {
        try {
            const start = Date.now();
            const response = await axios.get(url, { timeout: 3000 });
            results.http[key] = {
                status: response.status,
                timeMs: Date.now() - start
            };
        } catch (err) {
            results.http[key] = {
                error: err.message,
                status: err.response?.status,
                response: err.response?.data ? JSON.stringify(err.response.data).substring(0, 100) : null
            };
        }
    }

    // 2.5. POST connectivity checks with different payload sizes
    results.post_payload_test = {};
    const testPost = async (label, size) => {
        const payload = 'a'.repeat(size);
        const start = Date.now();
        try {
            const response = await axios.post(
                'https://login.microsoftonline.com/common/oauth2/v2.0/token',
                payload,
                { headers: { 'Content-Type': 'text/plain' }, timeout: 3000 }
            );
            results.post_payload_test[label] = {
                status: response.status,
                timeMs: Date.now() - start
            };
        } catch (err) {
            results.post_payload_test[label] = {
                error: err.message,
                status: err.response?.status,
                timeMs: Date.now() - start,
                response: err.response?.data ? JSON.stringify(err.response.data).substring(0, 100) : null
            };
        }
    };

    await testPost('small_10b', 10);
    await testPost('large_2000b', 2000);

    // 2.7. Tenant-specific POST test with url-encoded body (small vs large)
    results.tenant_post_test = {};
    const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
    const runTenantPost = async (label, codeValue) => {
        const tenantParams = new URLSearchParams();
        tenantParams.append('client_id', process.env.MICROSOFT_CLIENT_ID || 'dummy');
        tenantParams.append('client_secret', process.env.MICROSOFT_CLIENT_SECRET || 'dummy');
        tenantParams.append('code', codeValue);
        tenantParams.append('redirect_uri', process.env.MICROSOFT_REDIRECT_URI || 'https://evaops.esteviatech.com');
        tenantParams.append('grant_type', 'authorization_code');

        const startTenant = Date.now();
        try {
            const response = await axios.post(
                `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
                tenantParams.toString(),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 3000 }
            );
            results.tenant_post_test[label] = {
                status: response.status,
                timeMs: Date.now() - startTenant
            };
        } catch (err) {
            results.tenant_post_test[label] = {
                error: err.message,
                status: err.response?.status,
                timeMs: Date.now() - startTenant,
                response: err.response?.data ? JSON.stringify(err.response.data).substring(0, 100) : null
            };
        }
    };

    await runTenantPost('small_code', '1.FakeCodeFakeCodeFakeCodeFakeCode');
    await runTenantPost('large_code', '1.' + 'FakeCode'.repeat(250)); // ~2000 chars code

    // 3. TCP socket connections
    results.tcp = {};
    const tcpTargets = [
        { host: 'login.microsoftonline.com', port: 443 },
        { host: 'www.google.com', port: 443 },
        { host: 'estevia-dev-db.mysql.database.azure.com', port: 3306 },
        { host: 'estevia-dev-db.estevia-prod-db.private.mysql.database.azure.com', port: 3306 },
        { host: 'estevia-prod-db-v2.estevia-prod-db.private.mysql.database.azure.com', port: 3306 }
    ];

    for (const target of tcpTargets) {
        const key = `${target.host}:${target.port}`;
        try {
            await new Promise((resolve, reject) => {
                const socket = new net.Socket();
                socket.setTimeout(3000);
                socket.on('connect', () => {
                    socket.destroy();
                    resolve();
                });
                socket.on('error', (err) => {
                    socket.destroy();
                    reject(err);
                });
                socket.on('timeout', () => {
                    socket.destroy();
                    reject(new Error('timeout'));
                });
                socket.connect(target.port, target.host);
            });
            results.tcp[key] = 'Connected successfully';
        } catch (err) {
            results.tcp[key] = `Failed: ${err.message}`;
        }
    }

    return res.json(results);
};

const getLoginUrl = (req, res) => {
    const clientId = process.env.MICROSOFT_CLIENT_ID || 'dummy-client-id';
    const redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:5173';
    const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
    const loginUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=openid%20profile%20email`;
    return res.json({ url: loginUrl });
};

const listUsers = async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT id, email, name, role, mfa_enabled, created_at FROM users WHERE organization_id = ? AND id NOT LIKE 'dev-bypass-%' AND id NOT LIKE 'admin-override-%' AND id <> 'dev-bypass-user-id' ORDER BY name ASC",
            [req.user.organization_id]
        );
        return res.json(rows);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to retrieve users list', details: err.message });
    }
};

const updateUserRole = async (req, res) => {
    const { userId } = req.params;
    const { role } = req.body;
    
    if (!['owner', 'admin', 'contributor', 'viewer'].includes(role.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid role value specified.' });
    }

    try {
        // Get target user current details
        const [targetUsers] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (targetUsers.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        const targetUser = targetUsers[0];

        // Authorization checks
        if (targetUser.role === 'owner' && req.user.role !== 'owner') {
            return res.status(403).json({ error: 'Only Owners can modify other Owner settings.' });
        }

        // Seat capacity check: block write-role promotions when seats are full
        const writeRoles = ['owner', 'admin', 'contributor'];
        const isPromotion = writeRoles.includes(role.toLowerCase()) && !writeRoles.includes(targetUser.role);
        if (isPromotion) {
            const orgId = req.user?.organization_id || targetUser.organization_id;
            if (orgId) {
                const seatCheck = await checkSeatCapacity(orgId);
                if (seatCheck.isFull) {
                    return res.status(403).json({
                        error: `Seat limit reached (${seatCheck.current}/${seatCheck.limit}). Cannot promote this user to a write role. Increase the seat limit or remove a write-role user first.`
                    });
                }
            }
        }

        await db.query('UPDATE users SET role = ? WHERE id = ?', [role.toLowerCase(), userId]);

        // Fire Teams security alert asynchronously
        setImmediate(async () => {
            try {
                const orgId = req.user?.organization_id || targetUser.organization_id;
                const adminEmail = req.user?.email || 'system';
                const roleLabel = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
                await sendTeamsNotification(orgId, {
                    title: '🔒 User Role Updated — Security Alert',
                    text:  `A user's authorization role was changed in **EvaOps Control Centre (CloudOps Management & Governance)**.`,
                    themeColor: 'FFA500',
                    facts: [
                        { name: 'Affected User',  value: targetUser.email || userId },
                        { name: 'New Role',        value: roleLabel },
                        { name: 'Changed By',      value: adminEmail },
                        { name: 'Changed At',      value: new Date().toISOString() }
                    ]
                });
            } catch (notifyErr) {
                console.error('[AuthController] Teams role-change notification failed:', notifyErr.message);
            }
        });

        return res.json({ message: 'User role updated successfully.', userId, role: role.toLowerCase() });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update user role.', details: err.message });
    }
};

const syncUsers = async (req, res) => {
    console.log('[authController] Triggering team directory sync from Azure AD (Microsoft Graph API)...');
    
    try {
        const orgId = req.user?.organization_id;
        let tenantId = req.user?.tenant_id;
        
        if (!tenantId && orgId) {
            const [orgs] = await db.query('SELECT tenant_id FROM organizations WHERE id = ?', [orgId]);
            if (orgs.length > 0) {
                tenantId = orgs[0].tenant_id;
            }
        }
        
        if (!orgId || !tenantId) {
            return res.status(400).json({ error: 'User session is missing organization or tenant context for directory sync.' });
        }

        // Retrieve token for Microsoft Graph using the main App Registration credentials
        // which have been granted the User.Read.All Application permission.
        let credential;
        const msClientId = process.env.MICROSOFT_CLIENT_ID;
        const msClientSecret = process.env.MICROSOFT_CLIENT_SECRET;

        if (msClientId && msClientSecret) {
            console.log(`[AzureAuth] Using App Registration ClientSecretCredential for directory sync. Tenant: ${tenantId}`);
            credential = new ClientSecretCredential(
                tenantId,
                msClientId,
                msClientSecret
            );
        } else {
            console.log(`[AzureAuth] Fallback: Using organization Azure credentials for directory sync. Tenant: ${tenantId}`);
            credential = await getAzureCredential(orgId);
        }

        const tokenResponse = await credential.getToken("https://graph.microsoft.com/.default");
        const accessToken = tokenResponse.token;

        // Fetch users from Graph API
        const graphResponse = await axios.get('https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,accountEnabled', {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        const adUsers = graphResponse.data.value || [];
        
        let newUsersCount = 0;
        let updatedUsersCount = 0;
        let skippedUsersCount = 0;
        const activeAdUserIds = new Set();
        const disabledAdUserIds = new Set();
        
        for (const adUser of adUsers) {
            const email = adUser.mail || adUser.userPrincipalName;
            if (!email) continue;
            
            const name = adUser.displayName || email.split('@')[0];
            const msalId = adUser.id;
            
            // If the account is disabled in Azure AD, collect the ID and skip upsert
            if (adUser.accountEnabled === false) {
                disabledAdUserIds.add(msalId);
                continue;
            }
            
            activeAdUserIds.add(msalId);
            
            // Check if user exists by MSAL ID or Email
            const [existingById] = await db.query('SELECT * FROM users WHERE id = ?', [msalId]);
            if (existingById.length > 0) {
                if (existingById[0].name !== name || existingById[0].email !== email) {
                    await db.query('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, msalId]);
                    updatedUsersCount++;
                }
                continue;
            }
            
            const [existingByEmail] = await db.query('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
            if (existingByEmail.length > 0) {
                await db.query('UPDATE users SET id = ?, name = ? WHERE email = ?', [msalId, name, email]);
                updatedUsersCount++;
            } else {
                // New user from AD sync — check seat capacity
                const seatCapCheck = await checkSeatCapacity(orgId);
                if (seatCapCheck.isFull) {
                    console.log(`[authController] Skipping new user ${email} from sync because operator seat limit (${seatCapCheck.limit}) is fully used up.`);
                    skippedUsersCount++;
                    continue;
                }
                
                await db.query(
                    'INSERT INTO users (id, email, name, organization_id, tenant_id, role) VALUES (?, ?, ?, ?, ?, ?)',
                    [msalId, email, name, orgId, tenantId, 'viewer']
                );
                newUsersCount++;
            }
        }
        
        // Retrieve all current users in the organization to check for missing/disabled users
        const [localUsers] = await db.query('SELECT id, email FROM users WHERE organization_id = ?', [orgId]);
        
        let removedUsersCount = 0;
        for (const localUser of localUsers) {
            // Do not delete bypass or admin override accounts
            if (localUser.id.startsWith('dev-bypass-') || localUser.id.startsWith('admin-override-') || localUser.id === 'dev-bypass-user-id') continue;
            
            // Do not delete pre-seeded users that haven't linked their MSAL ID yet (whose id matches their email)
            if (localUser.id.toLowerCase() === localUser.email.toLowerCase()) continue;
            
            const isDisabled = disabledAdUserIds.has(localUser.id);
            const isMissing = !activeAdUserIds.has(localUser.id);
            
            if (isDisabled || isMissing) {
                console.log(`[authController] Removing user ${localUser.email} (ID: ${localUser.id}) because they are ${isDisabled ? 'disabled' : 'missing'} in Azure AD.`);
                await db.query('DELETE FROM users WHERE id = ?', [localUser.id]);
                removedUsersCount++;
            }
        }
        
        if (skippedUsersCount > 0) {
            return res.json({ 
                message: `Directory sync completed. However, ${skippedUsersCount} new user(s) could not be added because your operator seat count is used up.`, 
                added: newUsersCount, 
                updated: updatedUsersCount,
                removed: removedUsersCount,
                skipped: skippedUsersCount
            });
        }
        
        return res.json({ 
            message: 'Directory sync completed successfully.', 
            added: newUsersCount, 
            updated: updatedUsersCount,
            removed: removedUsersCount
        });
    } catch (err) {
        console.error('[authController] Azure AD Microsoft Graph sync failed:', err.message);
        return res.status(500).json({ 
            error: 'Failed to retrieve users from Azure AD', 
            details: err.response?.data ? JSON.stringify(err.response.data) : err.message 
        });
    }
};

// --- TOTP MFA Helper Functions ---
function base32Decode(base32Str) {
    const charTable = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleanStr = base32Str.toUpperCase().replace(/=+$/, "");
    let bits = 0;
    let val = 0;
    const bytes = [];
    for (let i = 0; i < cleanStr.length; i++) {
        const char = cleanStr[i];
        const idx = charTable.indexOf(char);
        if (idx === -1) throw new Error("Invalid base32 character: " + char);
        val = (val << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((val >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function generateBase32Secret(length = 16) {
    const charTable = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const randomBytes = crypto.randomBytes(length);
    let secret = "";
    for (let i = 0; i < randomBytes.length; i++) {
        secret += charTable[randomBytes[i] % 32];
    }
    return secret;
}

function verifyTOTP(secret, code, window = 30) {
    try {
        console.log(`[TOTP Debug] verifyTOTP called with secret length: ${secret ? secret.length : 0}, code: ${code}`);
        if (!secret) return false;
        const key = base32Decode(secret);
        const epoch = Math.floor(Date.now() / 1000);
        const counter = Math.floor(epoch / 30);
        console.log(`[TOTP Debug] epoch: ${epoch}, counter: ${counter}`);
        
        for (let i = -window; i <= window; i++) {
            const checkCounter = counter + i;
            const buf = Buffer.alloc(8);
            buf.writeUInt32BE(0, 0); 
            buf.writeUInt32BE(checkCounter, 4);
            
            const hmac = crypto.createHmac('sha1', key).update(buf).digest();
            const offset = hmac[hmac.length - 1] & 0xf;
            const binary = ((hmac[offset] & 0x7f) << 24) |
                           ((hmac[offset + 1] & 0xff) << 16) |
                           ((hmac[offset + 2] & 0xff) << 8) |
                           (hmac[offset + 3] & 0xff);
                           
            const otp = (binary % 1000000).toString().padStart(6, '0');
            if (otp === code) {
                console.log(`[TOTP Debug] Found match at step: ${i}`);
                return true;
            }
        }
        console.log(`[TOTP Debug] No match found across window.`);
    } catch (err) {
        console.error('[TOTP Verification Error]', err);
    }
    return false;
}

// --- TOTP MFA Authenticated Endpoints (for logged-in users) ---
exports.setupMfaAuthenticated = async (req, res) => {
    try {
        const userId = req.user.id;
        const [users] = await db.query('SELECT email FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const secret = generateBase32Secret(16);
        const issuer = 'EvaOps';
        const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(users[0].email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

        res.json({ secret, otpauthUrl });
    } catch (error) {
        res.status(500).json({ error: 'MFA setup request failed', details: error.message });
    }
};

exports.verifyMfaAuthenticated = async (req, res) => {
    const { secret, code } = req.body;
    if (!secret || !code) {
        return res.status(400).json({ error: 'Secret and validation code are required' });
    }

    try {
        const userId = req.user.id;
        const isValid = verifyTOTP(secret, code);
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid 6-digit authenticator code' });
        }

        // Save secret and set mfa_enabled = 1
        await db.query('UPDATE users SET mfa_secret = ?, mfa_enabled = 1 WHERE id = ?', [secret, userId]);

        res.json({ success: true, message: 'MFA configured successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Verification failed', details: error.message });
    }
};

// --- TOTP MFA Endpoints ---
exports.setupMfa = async (req, res) => {
    const { tempToken } = req.body;
    if (!tempToken) {
        return res.status(400).json({ error: 'Temporary verification token required' });
    }

    try {
        const payload = jwt.verify(tempToken, JWT_SECRET);
        if (payload.purpose !== 'mfa_setup') {
            return res.status(400).json({ error: 'Invalid MFA state token' });
        }

        const [users] = await db.query('SELECT email FROM users WHERE id = ?', [payload.id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const secret = generateBase32Secret(16);
        const issuer = 'EvaOps';
        const otpauthUrl = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(users[0].email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

        res.json({ secret, otpauthUrl });
    } catch (error) {
        res.status(400).json({ error: 'MFA setup request expired or invalid', details: error.message });
    }
};

exports.verifyMfa = async (req, res) => {
    const { tempToken, secret, code } = req.body;
    if (!tempToken || !secret || !code) {
        return res.status(400).json({ error: 'Token, secret, and validation code are required' });
    }

    try {
        const payload = jwt.verify(tempToken, JWT_SECRET);
        if (payload.purpose !== 'mfa_setup') {
            return res.status(400).json({ error: 'Invalid MFA state token' });
        }

        const isValid = verifyTOTP(secret, code);
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid 6-digit authenticator code' });
        }

        // Save secret and set mfa_enabled = 1
        await db.query('UPDATE users SET mfa_secret = ?, mfa_enabled = 1 WHERE id = ?', [secret, payload.id]);

        // Load complete user row
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [payload.id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User record missing' });
        }

        return await completeLoginSession(users[0], payload.loginMethod, req, res, true);
    } catch (error) {
        res.status(400).json({ error: 'Verification transaction failed or expired', details: error.message });
    }
};

exports.validateMfa = async (req, res) => {
    const { tempToken, code } = req.body;
    if (!tempToken || !code) {
        return res.status(400).json({ error: 'Verification token and verification code are required' });
    }

    try {
        const payload = jwt.verify(tempToken, JWT_SECRET);
        if (payload.purpose !== 'mfa_validate') {
            return res.status(400).json({ error: 'Invalid MFA validation state' });
        }

        // Load complete user row
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [payload.id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User record missing' });
        }

        const user = users[0];
        const isValid = verifyTOTP(user.mfa_secret, code);
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid 6-digit authenticator code' });
        }

        return await completeLoginSession(user, payload.loginMethod, req, res, true);
    } catch (error) {
        res.status(400).json({ error: 'Authentication validation failed or expired', details: error.message });
    }
};

exports.requestMfaReset = async (req, res) => {
    const { tempToken } = req.body;
    if (!tempToken) {
        return res.status(400).json({ error: 'Temporary validation token required' });
    }

    try {
        const payload = jwt.verify(tempToken, JWT_SECRET);
        const [users] = await db.query('SELECT id, name, email, organization_id FROM users WHERE id = ?', [payload.id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const user = users[0];

        // 1. Generate a secure, one-time MFA reset token valid for 15 minutes
        const mfaResetToken = jwt.sign(
            { id: user.id, purpose: 'mfa_reset' },
            JWT_SECRET,
            { expiresIn: '15m' }
        );

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const resetLink = `${frontendUrl}/login?mfa_reset_token=${mfaResetToken}`;

        // 2. Send the confirmation email to the requesting user
        await emailService.sendMail({
            to: user.email,
            subject: '[EvaOps Security] Confirm Multi-Factor Authentication (MFA) Reset',
            html: `
                <div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
                    <div style="text-align: center; margin-bottom: 20px;">
                        <h2 style="color: #7c3aed; margin: 0; font-family: sans-serif; font-size: 1.5rem;">EvaOps</h2>
                        <span style="font-size: 0.75rem; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em;">Security & Cloud Identity</span>
                    </div>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin-bottom: 20px;" />
                    <p>Hello ${user.name},</p>
                    <p>We received a request to reset the Multi-Factor Authentication (MFA) configuration linked to your account because you lost access to your authenticator app.</p>
                    <p>To confirm this reset and link a new authenticator device, click the button below:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${resetLink}" style="background-color: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 8px; display: inline-block; box-shadow: 0 4px 12px rgba(124, 58, 237, 0.25);">Confirm MFA Reset</a>
                    </div>
                    <p style="font-size: 0.85rem; color: #64748b;">Or copy and paste this URL into your browser:</p>
                    <p style="font-size: 0.8rem; word-break: break-all; color: #6366f1; background: #f8fafc; padding: 10px; border-radius: 6px; border: 1px solid #e2e8f0;">${resetLink}</p>
                    <p style="font-size: 0.85rem; color: #ef4444; font-weight: 600; margin-top: 20px;">This link is valid for 15 minutes. If you did not make this request, please change your password immediately to secure your account.</p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 25px 0 15px 0;" />
                    <p style="font-size: 0.75rem; color: #94a3b8; text-align: center; margin: 0;">This is an automated security email. Please do not reply directly to this message.</p>
                </div>
            `
        });

        res.json({ success: true, message: 'An MFA reset confirmation link has been sent to your registered email address. Please check your inbox to proceed.' });
    } catch (error) {
        res.status(400).json({ error: 'Request verification failed or has expired', details: error.message });
    }
};

exports.confirmMfaReset = async (req, res) => {
    const { token } = req.body;
    if (!token) {
        return res.status(400).json({ error: 'MFA reset token required' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (!payload.id || payload.purpose !== 'mfa_reset') {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        // Reset user MFA settings in database
        const [result] = await db.query(
            'UPDATE users SET mfa_secret = NULL, mfa_enabled = 0 WHERE id = ?',
            [payload.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ success: true, message: 'Your Multi-Factor Authentication has been reset successfully. Please log in with your credentials to register a new authenticator.' });
    } catch (error) {
        console.error('[confirmMfaReset] Error:', error);
        res.status(400).json({ error: 'MFA reset link has expired or is invalid. Please request a new reset link.', details: error.message });
    }
};

exports.resetUserMfa = async (req, res) => {
    const { userId } = req.params;
    try {
        // Reset target user MFA settings in database (organization isolation is enforced by the caller session org ID)
        await db.query(
            'UPDATE users SET mfa_secret = NULL, mfa_enabled = 0 WHERE id = ? AND organization_id = ?',
            [userId, req.user.organization_id]
        );
        res.json({ success: true, message: 'MFA configuration successfully reset for the user.' });
    } catch (error) {
        console.error('[resetUserMfa] Error:', error);
        res.status(500).json({ error: 'Server error during MFA reset', details: error.message });
    }
};

exports.updateMfaSettings = async (req, res) => {
    const { manualMfaRequired, ssoMfaRequired } = req.body;
    const orgId = req.user.organization_id;

    if (!orgId) {
        return res.status(400).json({ error: 'Organization context not found in user session.' });
    }

    try {
        await db.query(
            'UPDATE organizations SET manual_mfa_required = ?, sso_mfa_required = ? WHERE id = ?',
            [manualMfaRequired ? 1 : 0, ssoMfaRequired ? 1 : 0, orgId]
        );
        res.json({ success: true, message: 'Organization MFA policies updated successfully.' });
    } catch (error) {
        console.error('[updateMfaSettings] Error:', error);
        res.status(500).json({ error: 'Failed to update organization MFA settings', details: error.message });
    }
};

module.exports = {
    microsoftLogin,
    getMe,
    bypassLogin,
    adminOverrideLogin,
    getLoginUrl,
    runDiagnostic,
    listUsers,
    updateUserRole,
    syncUsers,
    setupMfa: exports.setupMfa,
    verifyMfa: exports.verifyMfa,
    validateMfa: exports.validateMfa,
    requestMfaReset: exports.requestMfaReset,
    confirmMfaReset: exports.confirmMfaReset,
    resetUserMfa: exports.resetUserMfa,
    updateMfaSettings: exports.updateMfaSettings,
    setupMfaAuthenticated: exports.setupMfaAuthenticated,
    verifyMfaAuthenticated: exports.verifyMfaAuthenticated
};
