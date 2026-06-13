const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const https = require('https');
const { DefaultAzureCredential, ClientSecretCredential } = require('@azure/identity');
const credentialController = require('./credentialController');

async function getAzureCredential(organizationId) {
    try {
        const azureSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure');
        if (azureSecrets && azureSecrets.clientId && azureSecrets.clientSecret && azureSecrets.tenantId) {
            console.log(`[AzureAuth] Using ClientSecretCredential for organization: ${organizationId}`);
            return new ClientSecretCredential(
                azureSecrets.tenantId,
                azureSecrets.clientId,
                azureSecrets.clientSecret
            );
        }
    } catch (err) {
        console.warn(`[AzureAuth] Failed to retrieve Azure credentials for organization ${organizationId}:`, err.message);
    }
    console.log(`[AzureAuth] Falling back to DefaultAzureCredential for organization: ${organizationId}`);
    return new DefaultAzureCredential();
}

const JWT_SECRET = process.env.JWT_SECRET || 'estevia-devops-jwt-super-secret-key-12345';

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

        // Extract role from Azure AD claims (App Roles or Directory Roles)
        let userRole = matchedOrg ? 'viewer' : 'admin';
        if (claims.roles && claims.roles.length > 0) {
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
                // User does not exist at all, insert them
                console.log(`[authController] Creating new user: ${email} for tenant: ${tenantIdFromToken} with role: ${userRole}`);
                await db.query(
                    'INSERT INTO users (id, email, name, organization_id, tenant_id, role) VALUES (?, ?, ?, ?, ?, ?)',
                    [msalId, email, name, orgId, tenantIdFromToken, userRole]
                );
                user = { id: msalId, email, name, organization_id: orgId, tenant_id: tenantIdFromToken, role: userRole };
            }
        } else {
            user = users[0];
            // Update name, email, tenant_id, organization_id, or role if changed/missing
            // If they have a role in the DB (like contributor/viewer/owner), let's keep it and not force-overwrite with userRole fallback
            const finalRole = user.role || userRole;
            let shouldUpdate = user.name !== name || user.email !== email || user.tenant_id !== tenantIdFromToken || user.role !== finalRole;
            let targetOrgId = user.organization_id;

            if (matchedOrg && user.organization_id !== matchedOrg.id) {
                targetOrgId = matchedOrg.id;
                shouldUpdate = true;
            }

            if (shouldUpdate) {
                await db.query(
                    'UPDATE users SET name = ?, email = ?, tenant_id = ?, organization_id = ?, role = ? WHERE id = ?',
                    [name, email, tenantIdFromToken, targetOrgId, finalRole, msalId]
                );
                user.name = name;
                user.email = email;
                user.tenant_id = tenantIdFromToken;
                user.organization_id = targetOrgId;
                user.role = finalRole;
            }
        }

        // Generate local JWT token
        const token = jwt.sign(
            { 
                id: user.id, 
                email: user.email, 
                name: user.name, 
                organization_id: user.organization_id, 
                role: user.role 
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

// Developer Bypass Login handler
const bypassLogin = async (req, res) => {
    try {
        console.log('[authController] Developer Bypass authenticating...');
        // Look for the pre-seeded bypass user
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', ['dev-bypass-user-id']);
        
        let user;
        if (users.length === 0) {
            // Re-create if missing
            await db.query(
                "INSERT INTO users (id, email, name, organization_id, tenant_id, role) VALUES ('dev-bypass-user-id', 'dev@estevia.com', 'Developer Bypass', 'estevia', 'a39c526c-2005-4529-ab5a-f008fc5cbc57', 'admin')"
            );
            user = { id: 'dev-bypass-user-id', email: 'dev@estevia.com', name: 'Developer Bypass', organization_id: 'estevia', tenant_id: 'a39c526c-2005-4529-ab5a-f008fc5cbc57', role: 'admin' };
        } else {
            user = users[0];
        }

        // Generate local JWT token
        const token = jwt.sign(
            { 
                id: user.id, 
                email: user.email, 
                name: user.name, 
                organization_id: user.organization_id, 
                role: user.role 
            },
            JWT_SECRET,
            { expiresIn: '30d' } // Dev tokens last longer for convenience
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

        return res.json({ 
            token, 
            user, 
            requiresOnboarding, 
            organization: finalOrg 
        });
    } catch (err) {
        console.error('[authController] Developer Bypass failed:', err.message);
        return res.status(500).json({ error: 'Developer Bypass login failed', details: err.message });
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
            [req.user.organization_id || 'estevia']
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

        await db.query('UPDATE users SET role = ? WHERE id = ?', [role.toLowerCase(), userId]);
        return res.json({ message: 'User role updated successfully.', userId, role: role.toLowerCase() });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update user role.', details: err.message });
    }
};

const syncUsers = async (req, res) => {
    console.log('[authController] Triggering team directory sync from Azure AD (Microsoft Graph API)...');
    
    try {
        const orgId = req.user?.organization_id || 'estevia';
        const tenantId = req.user?.tenant_id || 'a39c526c-2005-4529-ab5a-f008fc5cbc57';

        // Retrieve token for Microsoft Graph
        const credential = await getAzureCredential(orgId);
        const tokenResponse = await credential.getToken("https://graph.microsoft.com/.default");
        const accessToken = tokenResponse.token;

        // Fetch users from Graph API
        const graphResponse = await axios.get('https://graph.microsoft.com/v1.0/users', {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        const adUsers = graphResponse.data.value || [];
        
        let newUsersCount = 0;
        let updatedUsersCount = 0;
        
        for (const adUser of adUsers) {
            const email = adUser.mail || adUser.userPrincipalName;
            if (!email) continue;
            
            const name = adUser.displayName || email.split('@')[0];
            const msalId = adUser.id;
            
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
                await db.query(
                    'INSERT INTO users (id, email, name, organization_id, tenant_id, role) VALUES (?, ?, ?, ?, ?, ?)',
                    [msalId, email, name, orgId, tenantId, 'viewer']
                );
                newUsersCount++;
            }
        }
        
        return res.json({ 
            message: 'Directory sync completed successfully.', 
            added: newUsersCount, 
            updated: updatedUsersCount 
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
    getLoginUrl,
    runDiagnostic,
    listUsers,
    updateUserRole,
    syncUsers
};
