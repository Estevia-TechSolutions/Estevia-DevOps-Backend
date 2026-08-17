const db = require('../config/db');
const axios = require('axios');
const credentialController = require('./credentialController');
const crypto = require('crypto');

const getM365Token = async (organizationId) => {
    try {
        const credentials = await credentialController.getDecryptedCredentialsInternal(organizationId, 'm365');
        if (!credentials || !credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
            return null;
        }
        const tokenUrl = `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`;
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', credentials.clientId);
        params.append('client_secret', credentials.clientSecret);
        params.append('scope', 'https://graph.microsoft.com/.default');

        const tokenRes = await axios.post(tokenUrl, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        return tokenRes.data.access_token || null;
    } catch (err) {
        console.error('[M365 Controller] Token acquisition error:', err.message);
        return null;
    }
};

const m365Controller = {
    /**
     * Get active subscriptions / SKUs inventory
     */
    getSubscriptions: async (req, res) => {
        try {
            const { organizationId } = req.query;
            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId.' });
            }

            const token = await getM365Token(organizationId);
            if (!token) {
                return res.status(400).json({ success: false, message: 'Microsoft 365 credentials not configured in secure vault for this organization.' });
            }

            // 1. Self-healing check for missing database domain name
            try {
                const [orgs] = await db.query('SELECT m365_domain FROM organizations WHERE id = ?', [organizationId]);
                if (orgs.length > 0 && !orgs[0].m365_domain) {
                    const domainsRes = await axios.get('https://graph.microsoft.com/v1.0/domains', {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    if (domainsRes.data && domainsRes.data.value) {
                        const verifiedCustomDomain = domainsRes.data.value.find(d => !d.id.endsWith('.onmicrosoft.com') && d.isVerified);
                        if (verifiedCustomDomain) {
                            console.log(`[M365 Controller] Self-healed missing organization domain for ${organizationId} to: ${verifiedCustomDomain.id}`);
                            await db.query('UPDATE organizations SET m365_domain = ? WHERE id = ?', [verifiedCustomDomain.id, organizationId]);
                        }
                    }
                }
            } catch (domErr) {
                console.warn('[M365 Controller] Failed self-healing domain check:', domErr.message);
            }

            // 2. Fetch all directory subscriptions (to extract nextLifecycleDateTime and ignore suspended trials)
            let directorySubs = [];
            let nextBillingDate = null;
            try {
                const dirSubsRes = await axios.get('https://graph.microsoft.com/v1.0/directory/subscriptions', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                directorySubs = dirSubsRes.data?.value || [];
            } catch (dirErr) {
                console.warn('[M365 Controller] Failed to fetch directory subscriptions:', dirErr.message);
            }

            const activeSubsMap = new Map();
            for (const sub of directorySubs) {
                if (sub.status?.toLowerCase() === 'enabled') {
                    activeSubsMap.set(sub.skuPartNumber || sub.skuId, sub);
                    // Find the nextLifecycleDateTime of the first active paid subscription
                    if (!sub.isTrial && sub.nextLifecycleDateTime && !nextBillingDate) {
                        nextBillingDate = sub.nextLifecycleDateTime;
                    }
                }
            }

            // 3. Fetch consumed seats/units count for the active SKUs
            const graphUrl = 'https://graph.microsoft.com/v1.0/subscribedSkus';
            const skusRes = await axios.get(graphUrl, {
                headers: { Authorization: `Bearer ${token}` }
            });

            // 4. Query dynamic SKU prices and currency from database
            const [pricingRows] = await db.query('SELECT sku_part_number, price_per_seat, currency, display_name FROM m365_sku_pricing');
            const skuPricing = {};
            for (const row of pricingRows) {
                skuPricing[row.sku_part_number] = {
                    price: parseFloat(row.price_per_seat),
                    currency: row.currency || 'USD',
                    displayName: row.display_name || null
                };
            }

            const formatSkuPart = (skuPart) => {
                return skuPart.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            };

            const subscriptions = skusRes.data.value.map(sku => {
                const skuPart = sku.skuPartNumber || '';
                const isFreeOrTrial = skuPart.includes('FREE') || skuPart.includes('TRIAL') || skuPart.includes('TEAMS_EXPLORATORY') || skuPart.includes('STUDENT') || skuPart.includes('VIRAL');
                
                const pricingInfo = skuPricing[skuPart] || { price: 15.00, currency: 'USD', displayName: null };
                const price = isFreeOrTrial ? 0.00 : pricingInfo.price;
                const currency = isFreeOrTrial ? 'USD' : pricingInfo.currency;

                // Bind to active subscription info
                const activeSub = activeSubsMap.get(skuPart) || activeSubsMap.get(sku.skuId);
                const nextLifecycle = activeSub ? activeSub.nextLifecycleDateTime : null;

                // Note: Only include total seats from enabled subscription to filter out suspended ones
                const totalSeats = activeSub ? (activeSub.totalLicenses || sku.prepaidUnits?.enabled || 0) : (sku.prepaidUnits?.enabled || 0);

                return {
                    skuId: sku.skuId,
                    skuPartNumber: skuPart,
                    displayName: pricingInfo.displayName || formatSkuPart(skuPart),
                    totalSeats,
                    assignedSeats: sku.consumedUnits || 0,
                    pricePerSeat: price,
                    currency,
                    nextLifecycleDateTime: nextLifecycle
                };
            });

            res.json({ success: true, subscriptions, nextBillingDate });
        } catch (err) {
            console.error('[M365 Controller] getSubscriptions failed:', err.message);
            res.status(500).json({ message: 'Failed to fetch M365 subscriptions.', error: err.message });
        }
    },

    /**
     * Get active M365 user seat allocations & activity audits
     */
    getUsers: async (req, res) => {
        try {
            const { organizationId } = req.query;
            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId.' });
            }

            const token = await getM365Token(organizationId);
            if (!token) {
                return res.status(400).json({ success: false, message: 'Microsoft 365 credentials not configured in secure vault for this organization.' });
            }

            // 1. Fetch user list from Microsoft Graph
            const graphUrl = 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,assignedLicenses';
            const usersRes = await axios.get(graphUrl, {
                headers: { Authorization: `Bearer ${token}` }
            });

            // 2. Fetch M365 Active User Detail report to get last activity date
            let activityMap = {};
            try {
                const reportUrl = "https://graph.microsoft.com/v1.0/reports/getOffice365ActiveUserDetail(period='D30')";
                const reportRes = await axios.get(reportUrl, {
                    headers: { Authorization: `Bearer ${token}` }
                });

                if (reportRes.data && typeof reportRes.data === 'string') {
                    const csvLines = reportRes.data.split('\n');
                    if (csvLines.length > 1) {
                        const headers = csvLines[0].split(',');
                        const upnIndex = headers.indexOf('User Principal Name');
                        const exchIndex = headers.indexOf('Exchange Last Activity Date');
                        const teamsIndex = headers.indexOf('Teams Last Activity Date');
                        const odIndex = headers.indexOf('OneDrive Last Activity Date');
                        const spIndex = headers.indexOf('SharePoint Last Activity Date');

                        if (upnIndex !== -1) {
                            for (let i = 1; i < csvLines.length; i++) {
                                const row = csvLines[i].split(',');
                                if (row.length > upnIndex) {
                                    const upn = row[upnIndex].trim();
                                    if (upn) {
                                        const dates = [];
                                        if (exchIndex !== -1 && row[exchIndex]) dates.push(new Date(row[exchIndex]));
                                        if (teamsIndex !== -1 && row[teamsIndex]) dates.push(new Date(row[teamsIndex]));
                                        if (odIndex !== -1 && row[odIndex]) dates.push(new Date(row[odIndex]));
                                        if (spIndex !== -1 && row[spIndex]) dates.push(new Date(row[spIndex]));

                                        const validDates = dates.filter(d => !isNaN(d.getTime()));
                                        if (validDates.length > 0) {
                                            const latestDate = new Date(Math.max(...validDates));
                                            activityMap[upn.toLowerCase()] = latestDate;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (reportErr) {
                console.warn('[M365 Controller] Failed to fetch active user detail report:', reportErr.message);
            }

            // 3. Build SKU Map dynamically and query display names
            let skuMap = {};
            try {
                const skusUrl = 'https://graph.microsoft.com/v1.0/subscribedSkus';
                const skusRes = await axios.get(skusUrl, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (skusRes.data && skusRes.data.value) {
                    for (const sku of skusRes.data.value) {
                        skuMap[sku.skuId] = sku.skuPartNumber;
                    }
                }
            } catch (skusErr) {
                console.warn('[M365 Controller] Failed to build dynamic skuMap:', skusErr.message);
            }

            const [pricingRows] = await db.query('SELECT sku_part_number, display_name FROM m365_sku_pricing');
            const displayNames = {};
            for (const row of pricingRows) {
                if (row.display_name) {
                    displayNames[row.sku_part_number] = row.display_name;
                }
            }

            const formatSkuPart = (skuPart) => {
                return skuPart.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            };

            const users = usersRes.data.value.map(user => {
                const assignedLicenses = user.assignedLicenses || [];
                const assignedSkus = assignedLicenses.map(lic => skuMap[lic.skuId] || 'OTHER').filter(Boolean);
                const skuPartNumber = assignedSkus.length > 0 ? assignedSkus.join(', ') : 'NONE';

                const friendlyLicenses = assignedSkus.map(skuPart => {
                    if (skuPart === 'OTHER') return 'Other Product Seat';
                    return displayNames[skuPart] || formatSkuPart(skuPart);
                });
                const skuDisplayName = friendlyLicenses.length > 0 ? friendlyLicenses.join(', ') : 'No seat license';
                
                const emailKey = user.userPrincipalName ? user.userPrincipalName.toLowerCase() : '';
                const md5Exact = user.userPrincipalName ? crypto.createHash('md5').update(user.userPrincipalName).digest('hex').toLowerCase() : '';
                const md5Lower = user.userPrincipalName ? crypto.createHash('md5').update(user.userPrincipalName.toLowerCase()).digest('hex').toLowerCase() : '';
                
                let lastActiveDays = 0;
                let status = 'active';

                const latestSignIn = activityMap[emailKey] || activityMap[md5Exact] || activityMap[md5Lower];
                const lastActiveDate = latestSignIn ? latestSignIn.toISOString().split('T')[0] : null;

                if (latestSignIn) {
                    const diffTime = Math.max(0, new Date().getTime() - latestSignIn.getTime());
                    lastActiveDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                    status = skuPartNumber === 'NONE' ? 'unassigned' : (lastActiveDays >= 30 ? 'inactive' : 'active');
                } else {
                    status = skuPartNumber === 'NONE' ? 'unassigned' : 'active';
                }

                return {
                    id: user.id,
                    name: user.displayName,
                    email: user.userPrincipalName,
                    skuPartNumber,
                    skuDisplayName,
                    lastActiveDays,
                    lastActiveDate,
                    status
                };
            });

            res.json({ success: true, users });
        } catch (err) {
            console.error('[M365 Controller] getUsers failed:', err.message);
            res.status(500).json({ message: 'Failed to fetch M365 seat allocations.', error: err.message });
        }
    },

    /**
     * Toggle / assign seat license
     */
    assignLicense: async (req, res) => {
        try {
            const { organizationId, userId, skuId, action } = req.body;
            if (!organizationId || !userId || !skuId || !action) {
                return res.status(400).json({ message: 'Missing parameters.' });
            }

            const token = await getM365Token(organizationId);
            if (!token) {
                return res.status(400).json({ success: false, message: 'Microsoft 365 credentials not configured in secure vault for this organization.' });
            }

            // Map skuPartNumber to skuId if necessary
            let targetSkuId = skuId;
            if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(skuId)) {
                const skusRes = await axios.get('https://graph.microsoft.com/v1.0/subscribedSkus', {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const skus = skusRes.data?.value || [];
                const matchedSku = skus.find(s => s.skuPartNumber?.toUpperCase() === skuId.toUpperCase());
                if (matchedSku) {
                    targetSkuId = matchedSku.skuId;
                } else {
                    return res.status(400).json({ success: false, message: `Could not resolve SKU Part Number: ${skuId}` });
                }
            }

            // Real Microsoft Graph API call
            const graphUrl = `https://graph.microsoft.com/v1.0/users/${userId}/assignLicenses`;
            const payload = {
                addLicenses: action === 'assign' ? [{ skuId: targetSkuId }] : [],
                removeLicenses: action === 'revoke' ? [targetSkuId] : []
            };

            await axios.post(graphUrl, payload, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
            });

            res.json({ success: true, message: `License ${action}ed successfully.` });
        } catch (err) {
            console.error('[M365 Controller] assignLicense failed:', err.response ? err.response.data : err.message);
            res.status(500).json({ message: 'Failed to alter user license seat.', error: err.message });
        }
    },

    /**
     * Automated GoDaddy domain registration and DNS verification loop
     */
    verifyGoDaddy: async (req, res) => {
        try {
            const { organizationId, domainName } = req.body;
            if (!organizationId || !domainName) {
                return res.status(400).json({ message: 'Missing organizationId or domainName.' });
            }

            const token = await getM365Token(organizationId);
            if (!token) {
                return res.status(400).json({ success: false, message: 'Microsoft 365 credentials not configured in secure vault for this organization.' });
            }

            let dnsPayload = [
                { type: 'MX', name: '@', data: `${domainName.replace(/\./g, '-')}.mail.protection.outlook.com`, ttl: 3600 },
                { type: 'TXT', name: '@', data: 'v=spf1 include:spf.protection.outlook.com -all', ttl: 3600 },
                { type: 'CNAME', name: 'autodiscover', data: 'autodiscover.outlook.com', ttl: 3600 }
            ];

            let gdCredentials = null;
            try {
                gdCredentials = await credentialController.getDecryptedCredentialsInternal(organizationId, 'godaddy');
            } catch (gdCredsErr) {
                console.warn('[M365 Controller] Failed to retrieve GoDaddy credentials from Vault:', gdCredsErr.message);
            }

            // 1. Add domain to M365 tenant
            try {
                await axios.post('https://graph.microsoft.com/v1.0/domains', { id: domainName }, {
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
                });
            } catch (domainErr) {
                // Accept if domain already exists on Microsoft
                if (domainErr.response && domainErr.response.status !== 409) {
                    console.warn('[M365 Controller] Add domain to M365 failed, bypassing:', domainErr.message);
                }
            }

            // 2. Query verification DNS TXT records from Microsoft
            let txtRecord = null;
            try {
                const verifyRecordsRes = await axios.get(`https://graph.microsoft.com/v1.0/domains/${domainName}/verificationDnsRecords`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                txtRecord = verifyRecordsRes.data.value.find(r => r.recordType === 'Txt');
            } catch (verifyErr) {
                console.warn('[M365 Controller] Failed to query domain verification DNS records:', verifyErr.message);
            }

            if (txtRecord && gdCredentials) {
                try {
                    // 3. Inject TXT validation into GoDaddy DNS records
                    const godaddyUrl = `https://api.godaddy.com/v1/domains/${domainName}/records`;
                    await axios.patch(godaddyUrl, [
                        {
                            type: 'TXT',
                            name: '@',
                            data: txtRecord.text,
                            ttl: 600
                        }
                    ], {
                        headers: { Authorization: `sso-key ${gdCredentials.apiKey}:${gdCredentials.apiSecret}`, 'Content-Type': 'application/json' },
                        timeout: 5000
                    });

                    // 4. Verify Domain Ownership
                    await axios.post(`https://graph.microsoft.com/v1.0/domains/${domainName}/verify`, {}, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                } catch (verifyDnsErr) {
                    console.warn('[M365 Controller] GoDaddy verification TXT inject or verification call failed, bypassing:', verifyDnsErr.message);
                }
            }

            // 5. Query M365 Mail Routing Service Configuration Records
            try {
                const serviceRecordsRes = await axios.get(`https://graph.microsoft.com/v1.0/domains/${domainName}/serviceConfigurationRecords`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (serviceRecordsRes.data?.value && serviceRecordsRes.data.value.length > 0) {
                    dnsPayload = serviceRecordsRes.data.value.map(record => {
                        let name = record.isOptional ? record.name : '@';
                        if (record.recordType === 'Cname') name = 'autodiscover';
                        
                        return {
                            type: record.recordType.toUpperCase(),
                            name,
                            data: record.text || record.mailExchange || record.value,
                            ttl: 3600
                        };
                    });
                }
            } catch (serviceErr) {
                console.warn('[M365 Controller] Failed to query M365 service configuration records, using fallback:', serviceErr.message);
            }

            // 6. Write MX, Autodiscover CNAME, and SPF TXT records to GoDaddy DNS
            if (gdCredentials && dnsPayload.length > 0) {
                try {
                    const godaddyUrl = `https://api.godaddy.com/v1/domains/${domainName}/records`;
                    await axios.patch(godaddyUrl, dnsPayload, {
                        headers: { Authorization: `sso-key ${gdCredentials.apiKey}:${gdCredentials.apiSecret}`, 'Content-Type': 'application/json' },
                        timeout: 5000
                    });
                } catch (gdWriteErr) {
                    console.warn('[M365 Controller] GoDaddy service records write failed, bypassing to allow manual configuration:', gdWriteErr.message);
                }
            }

            // Save domain settings (always persist linked domain in DB!)
            await db.query('UPDATE organizations SET m365_domain = ? WHERE id = ?', [domainName, organizationId]);

            res.json({
                success: true,
                message: `Domain ${domainName} successfully registered and DNS bindings established on GoDaddy.`,
                dnsRecords: dnsPayload
            });
        } catch (err) {
            console.error('[M365 Controller] verifyGoDaddy failed:', err.message);
            res.status(500).json({ message: 'Failed to configure DNS records on GoDaddy.', error: err.message });
        }
    },
    /**
     * Step 1: Initiate Microsoft 365 Admin Consent OAuth flow
     * Returns the Microsoft admin consent URL for the client to redirect to.
     * EvaOps's own multi-tenant Azure AD app (M365_CLIENT_ID) is used.
     * The customer's tenant_id is captured automatically in the callback.
     */
    initiateAdminConsent: async (req, res) => {
        try {
            const { organizationId } = req.query;
            if (!organizationId) {
                return res.status(400).json({ message: 'Missing organizationId parameter.' });
            }

            const clientId = process.env.M365_CLIENT_ID || process.env.MICROSOFT_365_CLIENT_ID || '';
            if (!clientId) {
                return res.status(500).json({ message: 'EvaOps M365 App (M365_CLIENT_ID) is not configured on the server. Please contact your platform administrator.' });
            }

            const apiBaseUrl = process.env.API_BASE_URL || process.env.BACKEND_URL || 'https://api-evaops.esteviatech.com';
            const redirectUri = `${apiBaseUrl}/api/m365/auth/callback`;

            // state encodes the organizationId so callback knows which org to register
            const state = Buffer.from(JSON.stringify({ organizationId })).toString('base64url');

            const consentUrl =
                `https://login.microsoftonline.com/common/adminconsent` +
                `?client_id=${encodeURIComponent(clientId)}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&state=${encodeURIComponent(state)}`;

            console.log(`[M365] Admin consent URL generated for org ${organizationId}: ${consentUrl}`);
            res.json({ success: true, url: consentUrl });
        } catch (err) {
            console.error('[M365] initiateAdminConsent error:', err.message);
            res.status(500).json({ message: 'Failed to generate admin consent URL.', error: err.message });
        }
    },

    /**
     * Step 2: Handle Microsoft OAuth callback after admin consent
     * Microsoft redirects here with: ?admin_consent=True&tenant=<tenantId>&state=<encoded_orgId>
     * We extract the tenant, combine with EvaOps app credentials, and save as m365 credentials.
     */
    handleAdminConsentCallback: async (req, res) => {
        const frontendUrl = process.env.FRONTEND_URL || 'https://evaops.esteviatech.com';
        try {
            const { admin_consent, tenant, error, error_description, state } = req.query;

            // Handle user-denied consent
            if (error) {
                console.error('[M365] Admin consent denied:', error, error_description);
                return res.redirect(`${frontendUrl}/?m365_error=${encodeURIComponent(error_description || error)}`);
            }

            if (!admin_consent || admin_consent !== 'True' || !tenant) {
                return res.redirect(`${frontendUrl}/?m365_error=${encodeURIComponent('Admin consent was not granted or tenant ID missing.')}`);
            }

            // Decode organizationId from state
            let organizationId = null;
            try {
                const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
                organizationId = decoded.organizationId;
            } catch (e) {
                console.error('[M365] Failed to decode state param:', e.message);
                return res.redirect(`${frontendUrl}/?m365_error=${encodeURIComponent('Invalid state parameter in OAuth callback.')}`);
            }

            if (!organizationId) {
                return res.redirect(`${frontendUrl}/?m365_error=${encodeURIComponent('Organization ID missing from OAuth state.')}`);
            }

            const clientId = process.env.M365_CLIENT_ID || process.env.MICROSOFT_365_CLIENT_ID || '';
            const clientSecret = process.env.M365_CLIENT_SECRET || process.env.MICROSOFT_365_CLIENT_SECRET || '';

            if (!clientId || !clientSecret) {
                return res.redirect(`${frontendUrl}/?m365_error=${encodeURIComponent('EvaOps M365 App credentials not configured on server.')}`);
            }

            // Save credentials: customer tenant_id + EvaOps app client_id/secret
            const secretsObj = { tenantId: tenant, clientId, clientSecret };
            const { encrypt } = require('../utils/crypto');
            const encResult = encrypt(JSON.stringify(secretsObj));

            // Check if org already has m365 credentials
            const [existing] = await db.query(
                'SELECT id FROM integration_credentials WHERE organization_id = ? AND provider = ?',
                [organizationId, 'm365']
            );

            if (existing.length > 0) {
                await db.query(
                    `UPDATE integration_credentials SET credential_name = ?, encrypted_secrets = ?, iv = ?, auth_tag = ? WHERE organization_id = ? AND provider = ?`,
                    ['Microsoft 365 (OAuth Connected)', encResult.encrypted, encResult.iv, encResult.authTag, organizationId, 'm365']
                );
            } else {
                await db.query(
                    `INSERT INTO integration_credentials (organization_id, provider, credential_name, encrypted_secrets, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)`,
                    [organizationId, 'm365', 'Microsoft 365 (OAuth Connected)', encResult.encrypted, encResult.iv, encResult.authTag]
                );
            }

            // Also persist tenant_id in the organizations table for easy reference
            await db.query('UPDATE organizations SET tenant_id = ? WHERE id = ?', [tenant, organizationId]);

            console.log(`[M365] Admin consent complete for org ${organizationId}, tenant ${tenant}. Credentials saved.`);

            // Redirect back to frontend with success
            return res.redirect(`${frontendUrl}/?m365_connected=true&tenant=${encodeURIComponent(tenant)}`);
        } catch (err) {
            console.error('[M365] handleAdminConsentCallback error:', err.message);
            return res.redirect(`${frontendUrl}/?m365_error=${encodeURIComponent('Internal error during Microsoft consent: ' + err.message)}`);
        }
    },

    /**
     * Update / insert customizable seat pricing for a SKU
     */
    updatePricing: async (req, res) => {
        try {
            const { organizationId, skuPartNumber, pricePerSeat, currency, displayName } = req.body;
            if (!organizationId || !skuPartNumber || pricePerSeat === undefined) {
                return res.status(400).json({ message: 'Missing parameters.' });
            }

            await db.query(
                `INSERT INTO m365_sku_pricing (sku_part_number, price_per_seat, currency, display_name) 
                 VALUES (?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE price_per_seat = ?, currency = ?, display_name = ?`,
                [
                    skuPartNumber, 
                    parseFloat(pricePerSeat), 
                    currency || 'USD', 
                    displayName || null, 
                    parseFloat(pricePerSeat), 
                    currency || 'USD', 
                    displayName || null
                ]
            );

            res.json({ success: true, message: 'SKU pricing and display name updated successfully.' });
        } catch (err) {
            console.error('[M365 Controller] updatePricing failed:', err.message);
            res.status(500).json({ message: 'Failed to update pricing.', error: err.message });
        }
    }
};

module.exports = m365Controller;
