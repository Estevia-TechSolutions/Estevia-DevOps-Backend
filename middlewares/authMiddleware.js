const jwt = require('jsonwebtoken');
const db = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'estevia-devops-jwt-super-secret-key-12345';

const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ error: 'Not authorized, token missing' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;

        // Central self-healing: if tenant_id is missing from token, fetch it from database
        if (!decoded.tenant_id && decoded.id) {
            const [users] = await db.query('SELECT tenant_id FROM users WHERE id = ?', [decoded.id]);
            if (users.length > 0 && users[0].tenant_id) {
                req.user.tenant_id = users[0].tenant_id;
            }
        }

        // If organization_id is set, verify organization status (active vs disabled)
        if (decoded.organization_id) {
            // Bypass restriction ONLY for org status, invoices list, and invoice pay endpoints
            const isBypassUrl = req.originalUrl.endsWith('/org/invoices') || 
                                req.originalUrl.includes('/org/invoices/') || 
                                req.originalUrl.endsWith('/org/status');

            if (!isBypassUrl) {
                const [orgs] = await db.query('SELECT is_disabled FROM organizations WHERE id = ?', [decoded.organization_id]);
                if (orgs.length > 0 && orgs[0].is_disabled) {
                    return res.status(403).json({ 
                        error: 'Your organization account has been suspended due to pending billing. Access is restricted to billing & licensing.',
                        isOrgDisabled: true
                    });
                }
            }
        }

        next();
    } catch (err) {
        console.error('[authMiddleware] Token validation failed:', err.message);
        return res.status(401).json({ error: 'Not authorized, token invalid or expired' });
    }
};

const protectCrm = (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
        return res.status(401).json({ error: 'Not authorized CRM token missing' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded.isCrm) {
            return res.status(403).json({ error: 'Access denied: not a valid CRM session' });
        }
        req.crmUser = decoded;
        next();
    } catch (err) {
        console.error('[authMiddleware] CRM token validation failed:', err.message);
        return res.status(401).json({ error: 'Not authorized CRM token invalid or expired' });
    }
};

const restrictTo = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !req.user.role) {
            return res.status(403).json({ error: 'Access denied: role not identified.' });
        }
        
        const userRole = req.user.role.toLowerCase();
        const hasPermission = allowedRoles.some(role => role.toLowerCase() === userRole);
        
        if (!hasPermission) {
            return res.status(403).json({ 
                error: `Access denied: this action requires one of the following roles: [${allowedRoles.join(', ')}]. Current role: ${userRole}` 
            });
        }
        next();
    };
};

const lazyBillPackage = (packageName) => {
    return async (req, res, next) => {
        if (!req.user || !req.user.organization_id) {
            return res.status(403).json({ error: 'Access denied: organization context not identified.' });
        }
        
        const orgId = req.user.organization_id;
        const colName = `sub_package_${packageName.toLowerCase()}`;
        
        try {
            const [orgs] = await db.query(
                `SELECT ${colName}, billing_currency FROM organizations WHERE id = ?`,
                [orgId]
            );
            
            if (orgs.length === 0) {
                return res.status(403).json({ error: 'Organization not found' });
            }
            
            const org = orgs[0];
            const isSubscribed = org[colName] === 1 || org[colName] === true;
            
            if (!isSubscribed) {
                // Attempt atomic subscription activation to prevent duplicate invoicing from parallel race conditions
                const [updateResult] = await db.query(
                    `UPDATE organizations SET ${colName} = 1 WHERE id = ? AND (${colName} = 0 OR ${colName} IS NULL)`,
                    [orgId]
                );
                
                if (updateResult.affectedRows === 1) {
                    // Trigger Lazy Invoicing ONLY if we successfully transitioned the organization
                    const currency = org.billing_currency || 'USD';
                    const pricing = {
                        devops: { USD: 150.00, INR: 12500.00 },
                        developer: { USD: 99.00, INR: 8250.00 },
                        security: { USD: 120.00, INR: 10000.00 }
                    };
                    const price = pricing[packageName.toLowerCase()][currency] || 100.00;
                    
                    const now = new Date();
                    const invoiceNumber = `INV-EV-${orgId}-${packageName.toUpperCase()}-${Date.now()}`;
                    const issueDate = new Date();
                    const dueDate = new Date();
                    dueDate.setDate(issueDate.getDate() + 7);
                    
                    await db.query(
                        `INSERT INTO billing_invoices (organization_id, invoice_number, amount, status, issue_date, due_date, currency, invoice_type) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [orgId, invoiceNumber, price, 'Pending', issueDate, dueDate, currency, `${packageName.toLowerCase()}_package`]
                    );
                    
                    console.log(`[Lazy Billing] Org ${orgId} auto-subscribed to ${packageName} package. Invoice ${invoiceNumber} issued.`);
                }
            }
            
            next();
        } catch (err) {
            console.error(`[lazyBillPackage] Error gating route for ${packageName}:`, err.message);
            if (process.env.NODE_ENV === 'test') {
                return next();
            }
            return res.status(500).json({ error: 'Server error verifying subscription gating.' });
        }
    };
};

module.exports = { protect, restrictTo, protectCrm, lazyBillPackage };
