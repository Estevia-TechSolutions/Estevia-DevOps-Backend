const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const https = require('https');
const { DefaultAzureCredential, ClientSecretCredential } = require('@azure/identity');
const credentialController = require('./credentialController');
const { sendTeamsNotification } = require('../utils/teamsNotifier');

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
            `SELECT COUNT(*) AS count FROM users WHERE organization_id = ? AND role IN ('owner','admin','contributor')`,
            [organizationId]
        );
        return { limit, current: count, isFull: count >= limit };
    } catch (err) {
        console.warn('[authController] checkSeatCapacity failed (non-fatal):', err.message);
        return { limit: 10, current: 0, isFull: false };
    }
}
// ── End Seat Helper ────────────────────────────────────────────────────────────

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

        // Generate local JWT token
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
            { expiresIn: '24h' }
        );

        let requiresOnboarding = true;
        let finalOrg = null;
        if (user.organization_id) {
            const [matchedOrgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [user.organization_id]);
            if (matchedOrgs.length > 0) {
                finalOrg = matchedOrgs[0];
                requiresOnboarding = !finalOrg.onboarding_complete;
            }
        }

        req.user = user;
        return res.json({ 
            token, 
            user, 
            requiresOnboarding, 
            organization: finalOrg 
        });
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
            { expiresIn: '30d' }
        );

        let requiresOnboarding = true;
        let finalOrg = null;
        if (user.organization_id) {
            const [matchedOrgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [user.organization_id]);
            if (matchedOrgs.length > 0) {
                finalOrg = matchedOrgs[0];
                requiresOnboarding = !finalOrg.onboarding_complete;
            }
        }

        req.user = user;
        return res.json({ token, user, requiresOnboarding, organization: finalOrg });
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
            { expiresIn: '8h' } // Shorter expiry for admin override sessions
        );

        console.log(`[authController] Admin Override: successful login for org '${org.id}'`);
        req.user = user;
        return res.json({
            token,
            user,
            requiresOnboarding: !org.onboarding_complete,
            organization: org
        });
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
            'SELECT id, email, name, role, created_at FROM users WHERE organization_id = ? ORDER BY name ASC',
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

module.exports = {
    microsoftLogin,
    getMe,
    bypassLogin,
    adminOverrideLogin,
    getLoginUrl,
    runDiagnostic,
    listUsers,
    updateUserRole,
    syncUsers
};
