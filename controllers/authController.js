const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

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
        console.log('[authController] Exchanging code with Microsoft login service...');
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('code', code);
        params.append('redirect_uri', redirectUri);
        params.append('grant_type', 'authorization_code');

        const tokenResponse = await axios.post(
            `https://login.microsoftonline.com/${envTenantId}/oauth2/v2.0/token`,
            params.toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
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

        // Check if user already exists
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [msalId]);
        let user;

        if (users.length === 0) {
            // User does not exist, insert them
            console.log(`[authController] Creating new user: ${email} for tenant: ${tenantIdFromToken}`);
            const orgId = matchedOrg ? matchedOrg.id : null;
            const userRole = matchedOrg ? 'member' : 'admin'; // First user of new tenant is admin
            await db.query(
                'INSERT INTO users (id, email, name, organization_id, tenant_id, role) VALUES (?, ?, ?, ?, ?, ?)',
                [msalId, email, name, orgId, tenantIdFromToken, userRole]
            );
            user = { id: msalId, email, name, organization_id: orgId, tenant_id: tenantIdFromToken, role: userRole };
        } else {
            user = users[0];
            // Update name, email, tenant_id, or organization_id if changed/missing
            let shouldUpdate = user.name !== name || user.email !== email || user.tenant_id !== tenantIdFromToken;
            let targetOrgId = user.organization_id;

            if (matchedOrg && user.organization_id !== matchedOrg.id) {
                targetOrgId = matchedOrg.id;
                shouldUpdate = true;
            }

            if (shouldUpdate) {
                await db.query(
                    'UPDATE users SET name = ?, email = ?, tenant_id = ?, organization_id = ? WHERE id = ?',
                    [name, email, tenantIdFromToken, targetOrgId, msalId]
                );
                user.name = name;
                user.email = email;
                user.tenant_id = tenantIdFromToken;
                user.organization_id = targetOrgId;
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
    const domains = ['login.microsoftonline.com', 'www.google.com', 'api.godaddy.com', 'dev.azure.com'];

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
        { host: 'www.google.com', port: 443 }
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

module.exports = {
    microsoftLogin,
    getMe,
    bypassLogin,
    getLoginUrl,
    runDiagnostic
};
